"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  AiReportFinding,
  AiReportSeverity,
  AiReportView,
  AiSetupDocument,
} from "../../../../lib/omniflow/portal";

// §235: the health report (findings with fixes, changes since the last
// check, optional AI summary) and the setup document (print / download).

const API = "/api/omniflow/portal/ai-report";

const SEVERITY: Record<AiReportSeverity, { label: string; badge: string }> = {
  critical: { label: "Critical", badge: "border-danger/30 bg-danger-soft text-danger" },
  warning: { label: "Warning", badge: "border-warn/30 bg-warn-soft text-amber-700" },
  info: { label: "Suggestion", badge: "border-brand/25 bg-brand-soft text-brand" },
};

type Call<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(path: string, init?: RequestInit): Promise<Call<T>> {
  try {
    const response = await fetch(path, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (response.ok && payload) return { ok: true, data: payload };
    return { ok: false, message: payload?.error?.message || "Could not reach the server. Try again shortly." };
  } catch {
    return { ok: false, message: "Could not reach the server. Try again shortly." };
  }
}

function when(value: string | null): string {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}

function scoreTone(score: number): string {
  if (score >= 85) return "text-ok";
  if (score >= 60) return "text-amber-700";
  return "text-danger";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function documentMarkdown(doc: AiSetupDocument): string {
  const lines = ["# AI setup document", "", `Generated ${when(doc.generatedAt)}`, ""];
  for (const section of doc.sections) {
    lines.push(`## ${section.title}`, "");
    for (const row of section.rows) lines.push(`- **${row.label}:** ${row.value}`);
    for (const item of section.items) {
      lines.push(`- **${item.title}**${item.tag ? ` (${item.tag})` : ""}${item.body ? `: ${item.body}` : ""}`);
      if (item.meta) lines.push(`  ${item.meta}`);
    }
    if (!section.rows.length && !section.items.length) lines.push("Nothing set yet.");
    lines.push("");
  }
  return lines.join("\n");
}

function documentHtml(doc: AiSetupDocument): string {
  const body = doc.sections
    .map((section) => {
      const rows = section.rows
        .map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
        .join("");
      const items = section.items
        .map(
          (item) =>
            `<li><b>${escapeHtml(item.title)}</b>${item.tag ? ` <i>(${escapeHtml(item.tag)})</i>` : ""}` +
            `${item.body ? `<div>${escapeHtml(item.body)}</div>` : ""}` +
            `${item.meta ? `<small>${escapeHtml(item.meta)}</small>` : ""}</li>`
        )
        .join("");
      const empty = !rows && !items ? "<p>Nothing set yet.</p>" : "";
      return `<h2>${escapeHtml(section.title)}</h2>${rows ? `<table>${rows}</table>` : ""}${
        items ? `<ul>${items}</ul>` : ""
      }${empty}`;
    })
    .join("");
  return (
    "<!doctype html><html><head><meta charset='utf-8'><title>AI setup document</title><style>" +
    "body{font:13px/1.5 system-ui,sans-serif;color:#0b1220;margin:32px}h1{font-size:20px}" +
    "h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #d7e0ea;padding-bottom:4px}" +
    "table{border-collapse:collapse}th{text-align:left;color:#5c6b7c;font-weight:500;padding:2px 16px 2px 0;" +
    "vertical-align:top}td{padding:2px 0}li{margin:6px 0}small{display:block;color:#5c6b7c}" +
    `</style></head><body><h1>AI setup document</h1><p>Generated ${escapeHtml(when(doc.generatedAt))}</p>` +
    body +
    "</body></html>"
  );
}

function FindingRow({ finding, first }: { finding: AiReportFinding; first: boolean }) {
  const tone = SEVERITY[finding.severity];
  return (
    <li className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={"rounded-full border px-2 py-0.5 text-[11px] font-semibold " + tone.badge}>
            {tone.label}
          </span>
          {first ? (
            <span className="rounded-full border border-ink/15 px-2 py-0.5 text-[11px] font-semibold text-ink">
              Fix first
            </span>
          ) : null}
          <p className="text-sm font-semibold text-ink">{finding.title}</p>
        </div>
        {finding.detail ? <p className="mt-1 text-xs leading-relaxed text-ink-2">{finding.detail}</p> : null}
      </div>
      {finding.fixHref ? (
        <Link
          href={finding.fixHref}
          className="shrink-0 rounded-xl border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-semibold text-brand transition-colors duration-300 hover:border-brand/40"
        >
          {finding.fixLabel || "Fix"}
        </Link>
      ) : (
        <span className="shrink-0 text-[11px] text-ink-3">Managed by the OmniFlow team</span>
      )}
    </li>
  );
}

export default function AiReportClient({
  initial,
  initialError,
}: {
  initial: AiReportView | null;
  initialError: string;
}) {
  const [view, setView] = useState<AiReportView | null>(initial);
  const [error, setError] = useState(initialError);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "summary">("");
  const [tab, setTab] = useState<"report" | "document">("report");
  const [doc, setDoc] = useState<AiSetupDocument | null>(null);
  const [docError, setDocError] = useState("");

  async function recheck() {
    setBusy("check");
    setNote("");
    const result = await call<AiReportView>(API + "?fresh=1");
    if (result.ok) {
      setView(result.data);
      setError("");
    } else setError(result.message);
    setBusy("");
  }

  async function summarize() {
    setBusy("summary");
    setNote("");
    const result = await call<AiReportView>(API + "/summary", { method: "POST" });
    if (result.ok) {
      setView(result.data);
      setNote(result.data.note);
      setError("");
    } else setNote(result.message);
    setBusy("");
  }

  async function openDocument() {
    setTab("document");
    if (doc) return;
    setDocError("");
    const result = await call<AiSetupDocument>(API + "/document");
    if (result.ok) setDoc(result.data);
    else setDocError(result.message);
  }

  function printDocument() {
    if (!doc) return;
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.appendChild(frame);
    const target = frame.contentWindow;
    if (!target) {
      frame.remove();
      return;
    }
    target.document.open();
    target.document.write(documentHtml(doc));
    target.document.close();
    target.focus();
    target.print();
    window.setTimeout(() => frame.remove(), 1000);
  }

  function downloadDocument() {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([documentMarkdown(doc)], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ai-setup-document.md";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const tabClass = (active: boolean) =>
    "rounded-xl inline-flex min-h-9 items-center px-3.5 py-1.5 text-xs font-semibold transition-colors duration-300 " +
    (active ? "bg-brand text-white" : "text-ink-2 hover:text-ink");

  const report = view?.report;
  const changes = view?.changes;
  const config = view?.config;
  const areaLabel = new Map((config?.areas ?? []).map((a) => [a.key, a.label]));
  const groups = (config?.areas ?? [])
    .map((area) => ({ ...area, findings: (report?.findings ?? []).filter((f) => f.area === area.key) }))
    .filter((group) => group.findings.length > 0);

  return (
    <div>
      <div className="mb-5 inline-flex rounded-xl2 border border-line bg-white p-1 shadow-card">
        <button type="button" className={tabClass(tab === "report")} onClick={() => setTab("report")}>
          Health report
        </button>
        <button type="button" className={tabClass(tab === "document")} onClick={() => void openDocument()}>
          Setup document
        </button>
      </div>

      {tab === "report" ? (
        <div className="space-y-5">
          {error ? (
            <div className="rounded-xl2 border border-danger/30 bg-danger-soft p-4 text-sm text-danger">{error}</div>
          ) : null}
          {report && config ? (
            <>
              <div className="rounded-xl2 border border-line bg-white p-6 shadow-card">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                  <div className="text-center sm:w-36">
                    <p className={"text-5xl font-semibold tracking-tight " + scoreTone(report.score)}>{report.score}</p>
                    <p className="mt-1 text-xs text-ink-3">out of 100</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                      <span className="rounded-full border border-danger/30 bg-danger-soft px-2.5 py-0.5 text-danger">
                        {report.counts.critical} critical
                      </span>
                      <span className="rounded-full border border-warn/30 bg-warn-soft px-2.5 py-0.5 text-amber-700">
                        {report.counts.warning} warnings
                      </span>
                      <span className="rounded-full border border-brand/25 bg-brand-soft px-2.5 py-0.5 text-brand">
                        {report.counts.info} suggestions
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-ink">{report.summary}</p>
                    <p className="mt-2 text-[11px] text-ink-3">
                      {report.summarySource === "ai" ? "AI summary" : "Standard summary"}
                      {" \u00b7 "}
                      {report.origin === "auto" ? "Automatic check" : "Checked"} {when(report.createdAt)}
                      {" \u00b7 "}
                      Automatic check every {config.everyHours} hours
                    </p>
                    {note ? <p className="mt-2 text-xs text-ink-2">{note}</p> : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void recheck()}
                        disabled={busy !== ""}
                        className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
                      >
                        {busy === "check" ? "Checking..." : "Re-check now"}
                      </button>
                      {config.canSummarize ? (
                        <button
                          type="button"
                          onClick={() => void summarize()}
                          disabled={busy !== "" || !config.aiReady}
                          title={config.aiReady ? "" : config.aiReason}
                          className="rounded-xl border border-line px-4 py-2 text-xs font-semibold text-ink transition-colors duration-300 hover:border-brand/40 disabled:opacity-50"
                        >
                          {busy === "summary" ? "Writing..." : "Write AI summary"}
                        </button>
                      ) : null}
                    </div>
                    {config.canSummarize && !config.aiReady && config.aiReason ? (
                      <p className="mt-2 text-[11px] text-ink-3">AI summary unavailable: {config.aiReason}</p>
                    ) : null}
                  </div>
                </div>
              </div>

              {changes ? (
                <div className="rounded-xl2 border border-line bg-white p-5 shadow-card">
                  <h2 className="text-sm font-semibold text-ink">Since the last check</h2>
                  <p className="mt-1 text-xs text-ink-3">
                    {when(changes.since)}: score {changes.scoreBefore}
                    {changes.scoreChange === 0
                      ? " (no change)"
                      : ` \u2192 ${report.score} (${changes.scoreChange > 0 ? "+" : ""}${changes.scoreChange})`}
                  </p>
                  {changes.added.length ? (
                    <ul className="mt-3 space-y-1 text-xs text-ink-2">
                      {changes.added.map((item) => (
                        <li key={item.key}>
                          <span className={item.severity === "critical" ? "font-semibold text-danger" : "font-semibold text-amber-700"}>
                            New:
                          </span>{" "}
                          {item.title}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {changes.resolved.length ? (
                    <ul className="mt-2 space-y-1 text-xs text-ink-2">
                      {changes.resolved.map((item) => (
                        <li key={item.key}>
                          <span className="font-semibold text-ok">Fixed:</span> {item.title}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {!changes.added.length && !changes.resolved.length ? (
                    <p className="mt-2 text-xs text-ink-2">No new or fixed problems.</p>
                  ) : null}
                </div>
              ) : null}

              {groups.length ? (
                groups.map((group) => (
                  <div key={group.key} className="rounded-xl2 border border-line bg-white px-5 py-2 shadow-card">
                    <h2 className="pt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">{group.label}</h2>
                    <ul className="divide-y divide-line">
                      {group.findings.map((finding) => (
                        <FindingRow
                          key={finding.key}
                          finding={finding}
                          first={report.priorities.includes(finding.key)}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <div className="rounded-xl2 border border-ok/30 bg-ok-soft p-5 text-sm text-ok">
                  No problems found in your AI setup.
                </div>
              )}

              {report.passes.length ? (
                <div className="rounded-xl2 border border-line bg-white p-5 shadow-card">
                  <h2 className="text-sm font-semibold text-ink">What&apos;s fine</h2>
                  <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {report.passes.map((item) => (
                      <li key={item.key} className="flex gap-2 text-xs text-ink-2">
                        <span className="text-ok">{"\u2713"}</span>
                        <span>
                          {item.title}
                          <span className="text-ink-3">{" \u00b7 " + (areaLabel.get(item.area) ?? "")}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {report.skipped.length ? (
                <div className="rounded-xl2 border border-line-2 bg-soft p-5">
                  <h2 className="text-sm font-semibold text-ink">Not checked</h2>
                  <p className="mt-1 text-xs text-ink-2">
                    These areas could not be read this time, so they are not counted.
                    Re-check in a few minutes.
                  </p>
                  <p className="mt-2 text-xs text-ink-3">{report.skipped.map((s) => s.title).join(", ")}</p>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl2 border border-line bg-white p-6 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Setup document</h2>
              <p className="mt-0.5 text-xs text-ink-3">
                Everything your assistant has been told, in one place. Secrets
                and full phone numbers are never shown.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={printDocument}
                disabled={!doc}
                className="rounded-xl border border-line inline-flex min-h-9 items-center px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-300 hover:border-brand/40 disabled:opacity-50"
              >
                Print
              </button>
              <button
                type="button"
                onClick={downloadDocument}
                disabled={!doc}
                className="rounded-xl border border-line inline-flex min-h-9 items-center px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-300 hover:border-brand/40 disabled:opacity-50"
              >
                Download .md
              </button>
            </div>
          </div>
          {docError ? <p className="mt-4 text-sm text-danger">{docError}</p> : null}
          {!doc && !docError ? <p className="mt-4 text-sm text-ink-3">Loading...</p> : null}
          {doc
            ? doc.sections.map((section) => (
                <section key={section.key} className="mt-6 border-t border-line pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
                    {section.href ? (
                      <Link href={section.href} className="text-xs font-semibold text-brand">
                        Edit
                      </Link>
                    ) : null}
                  </div>
                  {section.rows.length ? (
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[200px_1fr]">
                      {section.rows.map((row) => (
                        <div key={row.label} className="contents">
                          <dt className="text-ink-3">{row.label}</dt>
                          <dd className="text-ink">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {section.items.length ? (
                    <ul className="mt-2 space-y-2">
                      {section.items.map((item, index) => (
                        <li key={item.title + index} className="text-xs">
                          <span className="font-semibold text-ink">{item.title}</span>
                          {item.tag ? <span className="text-ink-3">{" (" + item.tag + ")"}</span> : null}
                          {item.body ? <p className="mt-0.5 whitespace-pre-line text-ink-2">{item.body}</p> : null}
                          {item.meta ? <p className="mt-0.5 text-ink-3">{item.meta}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {!section.rows.length && !section.items.length ? (
                    <p className="mt-2 text-xs text-ink-3">Nothing set yet.</p>
                  ) : null}
                </section>
              ))
            : null}
        </div>
      )}
    </div>
  );
}
