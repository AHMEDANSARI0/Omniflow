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
  auto_refresh?: boolean;
  checked_at?: string | null;
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
  refresh_hours?: number;
  file_bytes_max?: number;
  pdf_available?: boolean;
  ocr_available?: boolean;
  ocr_pages_max?: number;
  ocr_pages_per_call?: number;
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

const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.csv,.json,.html,.htm,.jpg,.jpeg,.png,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,application/json,text/html,image/jpeg,image/png,image/webp";
// Plain-text files are read in the browser; PDF / Word / images go to the
// Control Plane, whose limit (OF_KB_FILE_BYTES_MAX) arrives in
// limits.file_bytes_max.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
// Photos are shrunk in the browser before upload: the vision model reads
// text well at this size and the upload stays small.
const IMAGE_MAX_SIDE = 2000;
const IMAGE_QUALITY = 0.85;
const AI_CONSENT = " This uses your workspace's AI credits.";

interface ExtractedFile {
  text: string;
  title: string;
  truncated: boolean;
  pages: number;
  aiPages?: number;
  aiNote?: string;
}

interface OcrResult {
  page: number;
  text: string;
  code: string;
  error: string;
}

interface ExtractBody {
  text?: string;
  title?: string;
  truncated?: boolean;
  pages?: number;
  ocr_pages?: number[];
  ocr_pages_skipped?: number;
  page_texts?: string[];
  results?: OcrResult[];
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
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

function formatMb(bytes: number): string {
  const mb = bytes / 1_000_000;
  return (mb >= 10 ? mb.toFixed(0) : String(Number(mb.toFixed(1)))) + " MB";
}

function formatInterval(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "day" : hours / 24 + " days";
  return hours === 1 ? "hour" : hours + " hours";
}

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isRichFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx") || isImageFile(name);
}

function pageList(pages: number[]): string {
  return (pages.length === 1 ? "Page " : "Pages ") + pages.join(", ");
}

/** A photo as a JPEG data URL no larger than IMAGE_MAX_SIDE, or null when
 * the browser cannot decode it (the original is sent instead). */
async function shrinkImage(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
    return dataUrl.startsWith("data:image/jpeg") ? dataUrl : null;
  } catch {
    return null;
  }
}

function formatChars(value: number): string {
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k chars";
  return value + " chars";
}

/**
 * Knowledge base -> Documents & pages: import text, files (incl. PDF and
 * Word, extracted by the Control Plane and reviewed here first) or web
 * pages, review them, publish (the assistant only reads published
 * sources), re-index, upload a new version of a file, keep web pages
 * up to date automatically, and roll back to an earlier version.
 * Nothing is published automatically.
 */
export default function KbSourcesCard() {
  const [payload, setPayload] = useState<SourcesPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<SourceKind>("text");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploadFor, setUploadFor] = useState<KbSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(0);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const ocrCancel = useRef(false);
  const [versionsFor, setVersionsFor] = useState(0);
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const versionFileRef = useRef<HTMLInputElement | null>(null);
  // The title last filled in from a file, so it can be replaced by the next
  // file and never leaks into a different kind of source.
  const autoTitle = useRef("");

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

  /** One call to the extract route: the parsed body, or an owner-readable
   * error string. */
  async function postExtract(payload: Record<string, unknown>): Promise<ExtractBody | string> {
    try {
      const response = await fetch("/api/omniflow/portal/kb/extract", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return await readError(response, "That file could not be read.");
      const body = (await response.json().catch(() => null)) as ExtractBody | null;
      return body ?? "That file could not be read.";
    } catch {
      return "Could not reach the workspace. Try again shortly.";
    }
  }

  /** Reads the given pages with the platform vision AI, a few per request,
   * with progress and Cancel. Fills `texts` (index = page - 1). */
  async function readWithAi(
    filename: string,
    dataUrl: string,
    pages: number[],
    texts: string[]
  ): Promise<{ read: number; note: string }> {
    const perCall = Math.max(1, limits?.ocr_pages_per_call ?? 1);
    const failed: OcrResult[] = [];
    let read = 0;
    let stop = "";
    ocrCancel.current = false;
    setOcrProgress({ done: 0, total: pages.length });
    for (let start = 0; start < pages.length; start += perCall) {
      if (ocrCancel.current) {
        stop = "Stopped - the remaining pages were not read.";
        break;
      }
      const batch = pages.slice(start, start + perCall);
      const body = await postExtract({ filename, file_base64: dataUrl, ocr: true, pages: batch });
      if (typeof body === "string" || !Array.isArray(body.results)) {
        stop = typeof body === "string" ? body : "The workspace did not return the pages.";
        break;
      }
      for (const result of body.results) {
        if (result.text.trim()) {
          texts[result.page - 1] = result.text;
          read += 1;
        } else {
          failed.push(result);
          if (result.code === "ai_blocked" || result.code === "ai_unavailable") stop = result.error;
        }
      }
      setOcrProgress({ done: Math.min(pages.length, start + batch.length), total: pages.length });
      if (stop) break;
    }
    setOcrProgress(null);
    const empty = failed.filter((row) => !row.error).map((row) => row.page);
    // The error that stopped the run is said once, at the end.
    const broken = failed.filter((row) => row.error && row.error !== stop);
    const note = [
      empty.length ? pageList(empty) + ": no readable text." : "",
      ...broken.slice(0, 3).map((row) => pageList([row.page]) + ": " + row.error),
      broken.length > 3 ? broken.length - 3 + " more pages could not be read." : "",
      stop,
    ]
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .join(" ");
    return { read, note };
  }

  /** Text of a picked file: PDF / Word / images via the Control Plane
   * (scanned pages and images read with AI after the owner confirms),
   * plain text in the browser. Returns an owner-readable error string on
   * failure, or "" when the owner cancelled. */
  async function readFile(file: File): Promise<ExtractedFile | string> {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".doc")) {
      return "Older .doc files are not supported. Save the document as .docx or PDF and upload it again.";
    }
    if (isRichFile(file.name)) {
      const image = isImageFile(file.name);
      if (lower.endsWith(".pdf") && payload?.limits.pdf_available === false) {
        return "PDF import is not available on this workspace yet. Paste the text instead.";
      }
      if (image && limits?.ocr_available !== true) {
        return "Reading text from images needs the platform's image-understanding AI, which is not available on this workspace. Paste the text instead.";
      }
      if (image && !window.confirm("Read the text in this image with AI?" + AI_CONSENT)) {
        return "";
      }
      const maxBytes = limits?.file_bytes_max ?? 0;
      let dataUrl = image ? await shrinkImage(file) : null;
      let filename = file.name;
      if (dataUrl) {
        filename = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      } else {
        if (maxBytes > 0 && file.size > maxBytes) {
          return "That file is larger than " + formatMb(maxBytes) + ". Split it or paste the relevant text.";
        }
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => reject(new Error("read"));
          reader.readAsDataURL(file);
        }).catch(() => "");
      }
      if (!dataUrl) return "That file could not be read.";
      if (maxBytes > 0 && ((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4 > maxBytes) {
        return "That file is larger than " + formatMb(maxBytes) + ". Split it or paste the relevant text.";
      }
      const title = file.name.replace(/\.[^.]+$/, "");
      if (image) {
        const texts = [""];
        const ai = await readWithAi(filename, dataUrl, [1], texts);
        if (!texts[0].trim()) return ai.note || "No readable text was found in this image.";
        return { text: texts[0], title, truncated: false, pages: 0, aiPages: ai.read, aiNote: ai.note };
      }
      const body = await postExtract({ filename, file_base64: dataUrl });
      if (typeof body === "string") return body;
      if (typeof body.text !== "string") return "That file could not be read.";
      const result: ExtractedFile = {
        text: body.text,
        title: typeof body.title === "string" ? body.title : "",
        truncated: body.truncated === true,
        pages: typeof body.pages === "number" ? body.pages : 0,
      };
      const scanned = Array.isArray(body.ocr_pages) ? body.ocr_pages : [];
      if (scanned.length === 0 || !Array.isArray(body.page_texts)) return result;
      const skipped = body.ocr_pages_skipped ?? 0;
      const ask =
        (body.text.trim()
          ? scanned.length + " of " + result.pages + " pages have no selectable text (they look scanned). Read them with AI?"
          : "This PDF looks scanned. Read its " + scanned.length + (scanned.length === 1 ? " page" : " pages") + " with AI?") +
        AI_CONSENT +
        " It takes a few seconds per page." +
        (skipped > 0 ? " Only the first " + scanned.length + " scanned pages are read; " + skipped + " more are skipped." : "");
      if (!window.confirm(ask)) {
        return body.text.trim() ? result : "";
      }
      const texts = [...body.page_texts];
      const ai = await readWithAi(filename, dataUrl, scanned, texts);
      let merged = texts.filter((page) => page.trim()).join("\n\n");
      let truncated = result.truncated || skipped > 0;
      const maxChars = limits?.max_chars ?? 0;
      if (maxChars > 0 && merged.length > maxChars) {
        merged = merged.slice(0, maxChars);
        truncated = true;
      }
      if (!merged.trim()) return ai.note || "No readable text was found in this PDF.";
      return { ...result, text: merged, truncated, aiPages: ai.read, aiNote: ai.note };
    }
    if (file.size > MAX_FILE_BYTES) {
      return "That file is larger than 2 MB. Split it or paste the relevant text.";
    }
    const plain = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    if (plain === null) return "That file could not be read.";
    return { text: plain, title: "", truncated: false, pages: 0 };
  }

  function extractedNote(file: ExtractedFile): string {
    return (
      (file.pages > 0 ? "Read " + file.pages + (file.pages === 1 ? " page. " : " pages. ") : "") +
      (file.aiPages ? "Read " + file.aiPages + (file.aiPages === 1 ? " page" : " pages") + " with AI - check the text for mistakes. " : "") +
      (file.aiNote ? file.aiNote + " " : "") +
      (file.truncated ? "The file was longer than the limit, so only the first part was kept. " : "")
    );
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setReading(true);
    setNotice(null);
    const result = await readFile(file);
    setReading(false);
    if (typeof result === "string") {
      if (result) setNotice({ kind: "error", text: result });
      event.target.value = "";
      return;
    }
    setText(result.text);
    setFilename(file.name);
    if (!title || title === autoTitle.current) {
      const next = (result.title || file.name.replace(/\.[^.]+$/, "")).slice(0, 120);
      autoTitle.current = next;
      setTitle(next);
    }
    if (isRichFile(file.name)) {
      setNotice({
        kind: "ok",
        text: extractedNote(result) + "Review the text below, then add it as a draft.",
      });
    }
  }

  async function onVersionFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const source = uploadFor;
    event.target.value = "";
    setUploadFor(null);
    if (!file || !source) return;
    setBusyId(source.id);
    setNotice(null);
    const result = await readFile(file);
    setBusyId(0);
    if (typeof result === "string") {
      if (result) setNotice({ kind: "error", text: result });
      return;
    }
    if (result.text.trim().length < 20) {
      setNotice({ kind: "error", text: "That file has too little text to index." });
      return;
    }
    if (
      source.status === "published" &&
      !window.confirm(
        "\u201c" + source.title + "\u201d is published. The new file replaces the text the assistant reads right away. Continue?"
      )
    ) {
      return;
    }
    await act(
      source,
      "/reindex",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: result.text, filename: file.name }),
      },
      extractedNote(result) + "Uploaded a new version of \u201c" + source.title + "\u201d.",
      "The new version could not be indexed."
    );
  }

  function pickVersionFile(source: KbSource) {
    setUploadFor(source);
    versionFileRef.current?.click();
  }

  function toggleAutoRefresh(source: KbSource) {
    const next = !source.auto_refresh;
    if (
      next &&
      !window.confirm(
        "Turn on automatic refresh? This page will be re-fetched about every " +
          formatInterval(limits?.refresh_hours ?? 168) +
          ". Changes are saved as a new version" +
          (source.status === "published"
            ? " and the assistant uses them right away, because this page is published."
            : "; it stays a draft until you publish it.")
      )
    ) {
      return;
    }
    return act(
      source,
      "",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_refresh: next }),
      },
      (next ? "Automatic refresh is on for \u201c" : "Automatic refresh is off for \u201c") +
        source.title +
        "\u201d.",
      "That change could not be saved."
    );
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
            ? { kind, title, url, auto_refresh: autoRefresh }
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
      setAutoRefresh(false);
      autoTitle.current = "";
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
  const canSubmit =
    !busy && !reading && !atCap && (kind === "url" ? url.trim().length > 0 : text.trim().length >= 20);
  const refreshEvery = formatInterval(limits?.refresh_hours ?? 168);

  return (
    <section className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
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
                <li key={source.id} className="rounded-xl border border-line bg-white shadow-card px-3.5 py-3">
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
                          source.checked_at && source.checked_at !== source.ingested_at
                            ? "checked " + formatWhen(source.checked_at)
                            : null,
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
                      {source.kind === "url" && source.auto_refresh ? (
                        <p className="mt-1 text-[11px] text-ink-3">
                          Re-fetched automatically about every {refreshEvery}. Changes become a new version.
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
                      {source.kind === "url" ? (
                        <button
                          type="button"
                          onClick={() => void toggleAutoRefresh(source)}
                          disabled={busyId !== 0}
                          aria-pressed={source.auto_refresh === true}
                          className={
                            source.auto_refresh
                              ? "rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand disabled:opacity-50"
                              : ghostBtn
                          }
                        >
                          {source.auto_refresh ? "Auto-refresh on" : "Auto-refresh off"}
                        </button>
                      ) : null}
                      {source.kind === "file" ? (
                        <button
                          type="button"
                          onClick={() => pickVersionFile(source)}
                          disabled={busyId !== 0}
                          className={ghostBtn}
                        >
                          {busyId === source.id && uploadFor === null ? "Reading\u2026" : "Upload new version"}
                        </button>
                      ) : null}
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

          <input
            ref={versionFileRef}
            type="file"
            accept={ACCEPTED_FILES}
            onChange={(event) => void onVersionFile(event)}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />

          <div className="mt-4 rounded-xl border border-line bg-white shadow-card p-4">
            <div className="flex flex-wrap gap-1.5">
              {(["text", "file", "url"] as SourceKind[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    if (option !== kind && title === autoTitle.current) setTitle("");
                    if (option !== kind) autoTitle.current = "";
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
                <>
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com/delivery-policy"
                    className={inputClass}
                  />
                  <label className="flex items-start gap-2 text-[11px] text-ink-2">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(event) => setAutoRefresh(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Keep this page up to date - re-fetch it automatically about every {refreshEvery}.
                      Changes are saved as a new version; publishing stays your decision.
                    </span>
                  </label>
                </>
              ) : (
                <>
                  {kind === "file" ? (
                    <input
                      ref={fileRef}
                      type="file"
                      accept={ACCEPTED_FILES}
                      onChange={(event) => void onFile(event)}
                      disabled={reading}
                      className="block w-full text-xs text-ink-3 file:mr-3 file:rounded-lg file:border file:border-line file:bg-soft file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-2"
                    />
                  ) : null}
                  <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={kind === "file" ? 4 : 6}
                    placeholder={
                      kind === "file"
                        ? reading
                          ? "Reading the file\u2026"
                          : "The file's text appears here - you can edit it before indexing."
                        : "Paste the policy, price list or FAQ text. Headings on their own line become section labels."
                    }
                    className={inputClass}
                  />
                </>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-ink-3">
                  {kind === "file"
                    ? "PDF and Word (.docx) files" +
                      (limits?.file_bytes_max ? " up to " + formatMb(limits.file_bytes_max) : "") +
                      ", photos of documents (JPG, PNG, WebP), or text files (.txt, .md, .csv, .json, .html) up to 2 MB. Older .doc files are not supported - save them as .docx." +
                      (limits?.ocr_available
                        ? " Scanned PDFs and photos are read with AI after you confirm."
                        : " Scanned PDFs without selectable text and photos need the platform's image-understanding AI, which is not available on this workspace.") +
                      (payload?.limits.pdf_available === false ? " PDF import is not available on this workspace yet." : "")
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

          {ocrProgress ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-2" role="status">
              <span>
                Reading with AI{"\u2026"} {ocrProgress.done} of {ocrProgress.total}{" "}
                {ocrProgress.total === 1 ? "page" : "pages"} done
              </span>
              <button
                type="button"
                onClick={() => {
                  ocrCancel.current = true;
                }}
                className={ghostBtn}
              >
                Cancel
              </button>
            </div>
          ) : null}

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
