"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

type SourceKind = "text" | "file" | "url";
type SourceStatus = "draft" | "published" | "paused";

interface KbSource {
  id: number;
  title: string;
  kind: SourceKind;
  origin: string;
  status: SourceStatus;
  version: number;
  chunk_count: number;
  char_count: number;
  last_error: string;
  stale: boolean;
  ingested_at: string | null;
  updated_at: string | null;
}

interface KbHealth {
  sources: number;
  published: number;
  drafts: number;
  paused: number;
  chunks: number;
  errors: number;
  stale: number;
}

interface KbLimits {
  max_sources: number;
  max_chars: number;
  chunk_chars: number;
  max_versions: number;
}

interface KbVersion {
  version: number;
  chunk_count: number;
  char_count: number;
  note: string;
  created_at: string | null;
}

interface SourcesPayload {
  sources: KbSource[];
  health: KbHealth;
  limits: KbLimits;
}

const KIND_LABELS: Record<SourceKind, string> = {
  text: "Pasted text",
  file: "File",
  url: "Web page",
};

const STATUS_LABELS: Record<SourceStatus, string> = {
  draft: "Draft",
  published: "Published",
  paused: "Paused",
};

const STATUS_CLASS: Record<SourceStatus, string> = {
  draft: "border-amber-400/30 bg-amber-400/[0.08] text-amber-700",
  published: "border-emerald-400/30 bg-emerald-400/[0.08] text-ok",
  paused: "border-line bg-soft text-ink-3",
};

const ACCEPTED_FILES = ".txt,.md,.csv,.json,.html,.htm,text/plain,text/markdown,text/csv,application/json,text/html";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";
const ghostBtn =
  "rounded-lg border border-line bg-soft px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors duration-300 hover:text-ink disabled:opacity-50";

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatChars(value: number): string {
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k chars";
  return value + " chars";
}

/**
 * Knowledge base -> Documents & pages: import text, files or web pages,
 * review them, publish (the assistant only reads published sources),
 * re-index, and roll back to an earlier version. Nothing is published
 * automatically.
 */
export default function KbSourcesCard() {
  const [payload, setPayload] = useState<SourcesPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<SourceKind>("text");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(0);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [versionsFor, setVersionsFor] = useState(0);
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb/sources", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.ok) {
        setPayload((await response.json()) as SourcesPayload);
      }
      setLoaded(true);
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function readError(response: Response, fallback: string): Promise<string> {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return body?.error?.message ?? fallback;
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ kind: "error", text: "That file is larger than 2 MB. Split it or paste the relevant text." });
      event.target.value = "";
      return;
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".doc")) {
      setNotice({
        kind: "error",
        text: "PDF and Word files are not supported yet. Export the document as .txt or paste the text.",
      });
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === "string" ? reader.result : "");
      setFilename(file.name);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
      setNotice(null);
    };
    reader.onerror = () => {
      setNotice({ kind: "error", text: "That file could not be read." });
    };
    reader.readAsText(file);
  }

  async function create() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb/sources", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "url"
            ? { kind, title, url }
            : { kind, title, text, filename: kind === "file" ? filename : undefined }
        ),
      });
      if (!response.ok) {
        setNotice({ kind: "error", text: await readError(response, "That source could not be added.") });
        return;
      }
      const body = (await response.json().catch(() => null)) as { source?: KbSource } | null;
      setTitle("");
      setText("");
      setUrl("");
      setFilename("");
      if (fileRef.current) fileRef.current.value = "";
      setNotice({
        kind: "ok",
        text:
          "Indexed " +
          (body?.source?.chunk_count ?? 0) +
          " sections as a draft. Review it, then publish so the assistant can use it.",
      });
      await load();
    } catch {
      setNotice({ kind: "error", text: "Could not reach the workspace. Try again shortly." });
    } finally {
      setBusy(false);
    }
  }

  async function act(
    source: KbSource,
    path: string,
    init: RequestInit,
    okText: string,
    failText: string
  ) {
    setBusyId(source.id);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/kb/sources/" + source.id + path,
        { credentials: "same-origin", ...init }
      );
      if (!response.ok) {
        setNotice({ kind: "error", text: await readError(response, failText) });
        await load();
        return;
      }
      setNotice({ kind: "ok", text: okText });
      await load();
      if (versionsFor === source.id) await openVersions(source.id, true);
    } catch {
      setNotice({ kind: "error", text: "Could not reach the workspace. Try again shortly." });
    } finally {
      setBusyId(0);
    }
  }

  function setStatus(source: KbSource, status: SourceStatus) {
    const verb =
      status === "published" ? "Published" : status === "paused" ? "Paused" : "Moved to drafts";
    return act(
      source,
      "",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
      verb + " \u201c" + source.title + "\u201d.",
      "That change could not be saved."
    );
  }

  function reindex(source: KbSource) {
    return act(
      source,
      "/reindex",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      (source.kind === "url" ? "Re-fetched" : "Re-indexed") + " \u201c" + source.title + "\u201d.",
      "That source could not be re-indexed."
    );
  }

  function remove(source: KbSource) {
    if (!window.confirm("Delete \u201c" + source.title + "\u201d and all of its versions?")) return;
    if (versionsFor === source.id) setVersionsFor(0);
    return act(
      source,
      "",
      { method: "DELETE" },
      "Deleted \u201c" + source.title + "\u201d.",
      "That source could not be deleted."
    );
  }

  async function openVersions(id: number, force = false) {
    if (versionsFor === id && !force) {
      setVersionsFor(0);
      return;
    }
    try {
      const response = await fetch("/api/omniflow/portal/kb/sources/" + id + "/versions", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as { versions?: KbVersion[] } | null;
      setVersions(body?.versions ?? []);
      setVersionsFor(id);
    } catch {
      /* ignore */
    }
  }

  function rollback(source: KbSource, version: number) {
    return act(
      source,
      "/rollback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      },
      "Restored version " + version + " of \u201c" + source.title + "\u201d as a new version.",
      "That version could not be restored."
    );
  }

  const sources = payload?.sources ?? [];
  const health = payload?.health;
  const limits = payload?.limits;
  const atCap = limits ? sources.length >= limits.max_sources : false;
  const canSubmit = !busy && !atCap && (kind === "url" ? url.trim().length > 0 : text.trim().length >= 20);

  return (
    <section className="mb-6 rounded-2xl border border-line bg-soft p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Documents &amp; pages</h2>
          <p className="mt-1 text-xs text-ink-3">
            Import policies, price lists, FAQs or web pages. The assistant reads
            only <span className="font-medium text-ink-2">published</span> sources
            and cites the section it used.
          </p>
        </div>
        {health ? (
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-ok">
              {health.published} published {"\u00b7"} {health.chunks} sections
            </span>
            {health.drafts > 0 ? (
              <span className="rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 text-amber-700">
                {health.drafts} awaiting review
              </span>
            ) : null}
            {health.errors > 0 ? (
              <span className="rounded-full border border-rose-400/30 bg-rose-400/[0.08] px-2 py-0.5 text-danger">
                {health.errors} with errors
              </span>
            ) : null}
            {health.stale > 0 ? (
              <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
                {health.stale} pages need a refresh
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {!loaded ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : (
        <>
          {sources.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {sources.map((source) => (
                <li key={source.id} className="rounded-xl border border-line bg-soft px-3.5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                        <span className="truncate font-medium">{source.title || "Untitled"}</span>
                        <span className={"rounded-full border px-2 py-0.5 text-[10px] " + STATUS_CLASS[source.status]}>
                          {STATUS_LABELS[source.status]}
                        </span>
                        <span className="rounded-md border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-3">
                          {KIND_LABELS[source.kind]}
                        </span>
                      </p>
                      <p className="mt-1 text-[11px] text-ink-3">
                        {[
                          "v" + source.version,
                          source.chunk_count + " sections",
                          formatChars(source.char_count),
                          source.ingested_at ? "indexed " + formatWhen(source.ingested_at) : null,
                          source.origin ? source.origin : null,
                        ]
                          .filter(Boolean)
                          .join(" \u00b7 ")}
                      </p>
                      {source.last_error ? (
                        <p className="mt-1 text-[11px] text-danger">{source.last_error}</p>
                      ) : null}
                      {source.stale && !source.last_error ? (
                        <p className="mt-1 text-[11px] text-amber-700">
                          This page was last fetched a while ago. Re-fetch to pick up changes.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {source.status !== "published" ? (
                        <button
                          type="button"
                          onClick={() => void setStatus(source, "published")}
                          disabled={busyId !== 0 || source.chunk_count === 0}
                          className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] font-medium text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
                        >
                          Publish
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void setStatus(source, "paused")}
                          disabled={busyId !== 0}
                          className={ghostBtn}
                        >
                          Pause
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void reindex(source)}
                        disabled={busyId !== 0}
                        className={ghostBtn}
                      >
                        {source.kind === "url" ? "Re-fetch" : "Re-index"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openVersions(source.id)}
                        disabled={busyId !== 0}
                        className={ghostBtn}
                      >
                        {versionsFor === source.id ? "Hide versions" : "Versions"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(source)}
                        disabled={busyId !== 0}
                        className="rounded-lg border border-rose-400/20 px-2.5 py-1 text-[11px] text-danger hover:bg-rose-400/[0.07] disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {versionsFor === source.id ? (
                    <div className="mt-2 rounded-lg border border-line bg-soft px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                        Versions
                      </p>
                      {versions.length === 0 ? (
                        <p className="mt-1 text-[11px] text-ink-3">No stored versions.</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {versions.map((entry) => (
                            <li
                              key={entry.version}
                              className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-2"
                            >
                              <span>
                                {"v" + entry.version + " \u00b7 " + entry.chunk_count + " sections \u00b7 " + formatChars(entry.char_count)}
                                {entry.note ? " \u00b7 " + entry.note : ""}
                                {entry.created_at ? " \u00b7 " + formatWhen(entry.created_at) : ""}
                              </span>
                              {entry.version !== source.version ? (
                                <button
                                  type="button"
                                  onClick={() => void rollback(source, entry.version)}
                                  disabled={busyId !== 0}
                                  className="text-brand hover:underline disabled:opacity-50"
                                >
                                  Restore
                                </button>
                              ) : (
                                <span className="text-ink-3">current</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-xs text-ink-3">
              No documents yet. Paste your delivery policy, price list or FAQ
              below to give the assistant something to read.
            </p>
          )}

          <div className="mt-4 rounded-xl border border-line bg-soft p-4">
            <div className="flex flex-wrap gap-1.5">
              {(["text", "file", "url"] as SourceKind[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setKind(option);
                    setNotice(null);
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    kind === option
                      ? "border-brand/30 bg-brand-soft text-brand"
                      : "border-line bg-soft text-ink-3 hover:text-ink"
                  }`}
                >
                  {option === "text" ? "Paste text" : option === "file" ? "Upload file" : "Web page"}
                </button>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title (optional - taken from the first line or page title)"
                maxLength={120}
                className={inputClass}
              />
              {kind === "url" ? (
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/delivery-policy"
                  className={inputClass}
                />
              ) : (
                <>
                  {kind === "file" ? (
                    <input
                      ref={fileRef}
                      type="file"
                      accept={ACCEPTED_FILES}
                      onChange={onFile}
                      className="block w-full text-xs text-ink-3 file:mr-3 file:rounded-lg file:border file:border-line file:bg-soft file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-2"
                    />
                  ) : null}
                  <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={kind === "file" ? 4 : 6}
                    placeholder={
                      kind === "file"
                        ? "The file's text appears here - you can edit it before indexing."
                        : "Paste the policy, price list or FAQ text. Headings on their own line become section labels."
                    }
                    className={inputClass}
                  />
                </>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-ink-3">
                  {kind === "file"
                    ? "Text files only (.txt, .md, .csv, .json, .html), up to 2 MB. PDF and Word are not supported yet."
                    : kind === "url"
                      ? "Public pages only. The page text is indexed; you can re-fetch it any time."
                      : limits
                        ? "Up to " + formatChars(limits.max_chars) + " per source, split into sections of about " + limits.chunk_chars + " characters."
                        : ""}
                  {atCap && limits ? " This workspace has reached its " + limits.max_sources + "-source limit." : ""}
                </p>
                <button type="button" onClick={() => void create()} disabled={!canSubmit} className={primaryBtn}>
                  {busy ? "Indexing\u2026" : "Add as draft"}
                </button>
              </div>
            </div>
          </div>

          {notice ? (
            <p className={"mt-3 text-xs " + (notice.kind === "ok" ? "text-ok" : "text-danger")}>
              {notice.text}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
