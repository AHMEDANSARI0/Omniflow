"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface MediaAsset {
  id: number;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_at: string | null;
}

const KIND_STYLES: Record<string, string> = {
  image: "border-sky-400/25 bg-sky-400/[0.07] text-sky-300",
  document: "border-amber-400/25 bg-amber-400/[0.07] text-amber-300",
  audio: "border-violet-400/25 bg-violet-400/[0.07] text-violet-300",
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

/**
 * Media + voice (B11): the tenant media library - upload images,
 * PDFs and audio, then send any asset to a customer on WhatsApp
 * (needs OMNIFLOW_WA_CLOUD_URL + OMNIFLOW_WA_TOKEN on the bot) or
 * turn an audio asset into text (needs OMNIFLOW_STT_API_KEY on the
 * CP). Upload/list/download/delete always work; Send and Transcribe
 * explain exactly which env is missing when they are not configured.
 */
export default function MediaPage() {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [caption, setCaption] = useState("");
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendFor, setSendFor] = useState<number | null>(null);
  const [contactId, setContactId] = useState("");
  const [sendCaption, setSendCaption] = useState("");
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<number, string>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadAssets = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/media",
        { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { assets?: MediaAsset[] };
        setAssets(payload.assets ?? []);
      }
    } catch {
      /* keep list */
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  async function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setUploadNote(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (caption.trim()) form.set("caption", caption.trim());
      const response = await fetch("/api/omniflow/portal/media", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as
        { asset?: MediaAsset | null; error?: { message?: string } } | null;
      if (response.ok && payload?.asset) {
        setUploadNote("Uploaded: " + payload.asset.filename);
        setCaption("");
        if (fileInput.current) fileInput.current.value = "";
        await loadAssets();
      } else {
        setUploadNote(payload?.error?.message ?? "Upload failed.");
      }
    } catch {
      setUploadNote("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/media/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) await loadAssets();
    } catch {
      /* keep list */
    } finally {
      setBusy(false);
    }
  }

  async function send(id: number) {
    if (!contactId.trim()) return;
    setBusy(true);
    setSendNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/media/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, contact_id: contactId.trim(),
          caption: sendCaption }),
      });
      const payload = (await response.json().catch(() => null)) as
        { error?: { code?: string; message?: string } } | null;
      if (response.ok) {
        setSendNote("Queued - the bot delivers it on WhatsApp within the\n          next poll.");
        setSendFor(null);
        setContactId("");
        setSendCaption("");
      } else if (payload?.error?.code === "opted_out") {
        setSendNote("This customer has opted out - sending is blocked.");
      } else {
        setSendNote(payload?.error?.message ?? "Send failed.");
      }
    } catch {
      setSendNote("Send failed.");
    } finally {
      setBusy(false);
    }
  }

  async function transcribe(id: number) {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/media/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const payload = (await response.json().catch(() => null)) as
        { text?: string; error?: { message?: string } } | null;
      if (response.ok && typeof payload?.text === "string") {
        setTranscripts((prev) => ({ ...prev, [id]: payload!.text! }));
      } else {
        setTranscripts((prev) => ({ ...prev, [id]: "(error) "
          + (payload?.error?.message ?? "failed") }));
      }
    } catch {
      setTranscripts((prev) => ({ ...prev, [id]: "(error) failed" }));
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Media &amp; voice
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Store images, PDFs and audio - send them to customers on
            WhatsApp or turn voice notes into text. Uploads and the
            library always work; sending needs OMNIFLOW_WA_CLOUD_URL
            + OMNIFLOW_WA_TOKEN on the bot, transcription needs
            OMNIFLOW_STT_API_KEY on the CP.
          </p>
        </div>

        <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-xs font-semibold text-white">Upload</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf,audio/*"
              className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-white/[0.06] file:px-2 file:py-0.5 file:text-xs file:text-slate-200"
            />
            <input
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="caption (optional)"
              className="w-44 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <button
              onClick={() => void upload()}
              disabled={busy}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Upload
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Images, PDF, audio - max 8 MB.
          </p>
          {uploadNote ? (
            <p className="mt-1.5 text-[11px] text-slate-300">{uploadNote}</p>
          ) : null}
        </section>

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-xs font-semibold text-white">Library</p>
          {assets.length === 0 ? (
            <p className="mt-1 text-[11px] text-slate-500">
              No files yet - upload one above.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {assets.map((asset) => (
                <li
                  key={asset.id}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={
                          "shrink-0 rounded-full border px-2.5 py-1 text-[11px] " +
                          (KIND_STYLES[asset.kind] ?? KIND_STYLES.image)
                        }
                      >
                        {asset.kind}
                      </span>
                      <p className="min-w-0 truncate text-xs text-slate-200">
                        {asset.filename}
                      </p>
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {formatSize(asset.size_bytes)}
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <a
                        href={"/api/omniflow/portal/media/" + asset.id
                          + "/download"}
                        className="text-[11px] text-cyan-300 hover:underline"
                      >
                        Download
                      </a>
                      <button
                        onClick={() => {
                          setSendFor(sendFor === asset.id ? null : asset.id);
                          setSendNote(null);
                        }}
                        className="text-[11px] text-emerald-300 hover:underline"
                      >
                        Send
                      </button>
                      {asset.kind === "audio" ? (
                        <button
                          onClick={() => void transcribe(asset.id)}
                          disabled={busy}
                          className="text-[11px] text-violet-300 hover:underline disabled:opacity-40"
                        >
                          Transcribe
                        </button>
                      ) : null}
                      <button
                        onClick={() => void remove(asset.id)}
                        disabled={busy}
                        className="text-[11px] text-slate-500 hover:text-rose-300 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {asset.caption ? (
                    <p className="mt-1 truncate text-[11px] text-slate-500">
                      {asset.caption}
                    </p>
                  ) : null}

                  {sendFor === asset.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                      <input
                        value={contactId}
                        onChange={(event) => setContactId(event.target.value)}
                        placeholder="customer number e.g. 92300..."
                        className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
                      />
                      <input
                        value={sendCaption}
                        onChange={(event) => setSendCaption(event.target.value)}
                        placeholder="caption (optional)"
                        className="w-40 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
                      />
                      <button
                        onClick={() => void send(asset.id)}
                        disabled={busy || !contactId.trim()}
                        className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
                      >
                        Send now
                      </button>
                    </div>
                  ) : null}
                  {sendFor === asset.id && sendNote ? (
                    <p className="mt-1 text-[11px] text-slate-300">
                      {sendNote}
                    </p>
                  ) : null}

                  {transcripts[asset.id] ? (
                    <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-violet-400/20 bg-violet-400/[0.05] p-2">
                      <p className="min-w-0 break-words text-[11px] text-violet-100">
                        {transcripts[asset.id]}
                      </p>
                      <button
                        onClick={() => void copyText(transcripts[asset.id])}
                        className="shrink-0 text-[11px] text-slate-400 hover:underline"
                      >
                        Copy
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
