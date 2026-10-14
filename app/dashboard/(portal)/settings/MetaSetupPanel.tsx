"use client";

import { useState } from "react";
import PortalIcon, { type IconName } from "../../components/PortalIcon";
import type { MetaSetupFix, MetaSetupReport, MetaSetupStatus } from "../../../../lib/omniflow/portal";

// §256: the Meta setup steps, read live from the Graph API with the
// workspace's own app and tokens. Two steps can be fixed from here; App
// Review / Live mode stays a Meta-console step and is labelled as such.

const ICON: Record<MetaSetupStatus, { icon: IconName; tone: string; label: string }> = {
  ok: { icon: "approvals", tone: "text-ok", label: "Done" },
  warn: { icon: "alert", tone: "text-amber-700", label: "Check" },
  fail: { icon: "failed", tone: "text-danger", label: "Missing" },
  skip: { icon: "skipped", tone: "text-ink-3", label: "Skipped" },
  manual: { icon: "externalLink", tone: "text-ink-3", label: "In Meta console" },
};

const FIX_LABEL: Record<MetaSetupFix, string> = {
  subscribe_page: "Subscribe the Page",
  subscribe_app: "Register webhooks",
};

export default function MetaSetupPanel({ disabled }: { disabled: boolean }) {
  const [report, setReport] = useState<MetaSetupReport | null>(null);
  const [busy, setBusy] = useState<"" | "check" | MetaSetupFix>("");
  const [note, setNote] = useState("");

  async function run(fix: MetaSetupFix | null) {
    if (busy) return;
    setBusy(fix ?? "check");
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fix ? { fix } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "The setup check could not run.");
        return;
      }
      setReport(payload as MetaSetupReport);
      if (payload.note) setNote(payload.note);
    } catch {
      setNote("The setup check could not run.");
    } finally {
      setBusy("");
    }
  }

  const open = report ? report.checks.filter((c) => c.status === "fail" || c.status === "warn").length : 0;

  return (
    <div className="mt-4 rounded-lg border border-line bg-soft px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink">Setup check</p>
          <p className="text-[11px] text-ink-3">
            Reads token permissions, webhooks and the Page subscription live from Meta.
          </p>
        </div>
        <button
          onClick={() => void run(null)}
          disabled={disabled || busy !== ""}
          className="rounded-lg border border-line bg-white inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 hover:bg-line/60 disabled:opacity-50"
        >
          {busy === "check" ? "Checking..." : report ? "Check again" : "Run setup check"}
        </button>
      </div>

      {report ? (
        <>
          <p className="mt-3 text-[11px] text-ink-2">
            {open ? open + " step" + (open === 1 ? "" : "s") + " need attention." : "Everything this check can see is set up."}
          </p>
          <ul className="mt-2 space-y-1.5">
            {report.checks.map((check) => {
              const { icon, tone, label } = ICON[check.status];
              return (
                <li key={check.id} className="flex items-start gap-2 rounded-md border border-line bg-white px-2.5 py-2">
                  <PortalIcon name={icon} className={"mt-0.5 h-3.5 w-3.5 " + tone} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-ink">
                      {check.label} <span className={"text-[10px] " + tone}>{label}</span>
                    </p>
                    <p className="break-words text-[10px] text-ink-3">{check.detail}</p>
                  </div>
                  {check.fix ? (
                    <button
                      onClick={() => void run(check.fix)}
                      disabled={busy !== ""}
                      className="shrink-0 self-center rounded-md border border-brand/30 bg-brand-soft px-2 py-1 text-[10px] text-brand disabled:opacity-50"
                    >
                      {busy === check.fix ? "Working..." : FIX_LABEL[check.fix]}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {report.webhookUrl ? (
            <p className="mt-2 break-all text-[10px] text-ink-3">
              Webhook URL: <span className="font-mono text-ink-2">{report.webhookUrl}</span>
            </p>
          ) : null}
        </>
      ) : null}
      {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}
    </div>
  );
}
