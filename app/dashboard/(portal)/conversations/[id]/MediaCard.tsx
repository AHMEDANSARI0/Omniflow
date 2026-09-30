"use client";

import { useCallback, useEffect, useState } from "react";

/** §214: files the customer sent - kept copies of images / voice notes,
 * and fresh links for videos and other files (Instagram links expire). */
interface InboundMediaItem {
  id: number;
  kind: string;
  mime: string;
  size_bytes: number;
  status: string;
  note: string;
  channel: string;
  has_copy: boolean;
  can_open: boolean;
  can_refresh: boolean;
  created_at: string | null;
}

const KIND_LABELS: Record<string, string> = {
  image: "Image",
  audio: "Voice note",
  video: "Video",
  file: "File",
};

const NOTE_LABELS: Record<string, string> = {
  copies_off: "Copies are off",
  too_large: "Too large to keep",
  unsupported: "Format not kept",
  download_failed: "Could not be saved",
  no_source: "No file received",
  retention: "Removed after the keep period",
  quota: "Removed to stay within storage",
};

function sizeLabel(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function contentUrl(id: number): string {
  return "/api/omniflow/portal/inbound-media/" + id + "/content";
}

export default function MediaCard({ conversationId }: { conversationId: number }) {
  const [items, setItems] = useState<InboundMediaItem[]>([]);
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const [links, setLinks] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/media",
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        media?: InboundMediaItem[];
      } | null;
      if (payload && Array.isArray(payload.media)) setItems(payload.media);
    } catch {
      return;
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function getLink(item: InboundMediaItem) {
    if (busy !== null) return;
    setBusy(item.id);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/inbound-media/" + item.id + "/link",
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as {
        url?: string;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && typeof payload.url === "string") {
        setLinks((current) => ({ ...current, [item.id]: payload.url as string }));
      } else {
        setNote({
          text: payload?.error?.message || "This file is no longer available.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not reach the server - try again.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: InboundMediaItem) {
    if (busy !== null) return;
    if (!window.confirm("Delete this file from OmniFlow? The message text stays.")) {
      return;
    }
    setBusy(item.id);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/inbound-media/" + item.id, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (response.ok) {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        setNote({ text: "File deleted.", ok: true });
      } else {
        setNote({ text: payload?.error?.message || "Could not delete the file.", ok: false });
      }
    } catch {
      setNote({ text: "Could not reach the server - try again.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <section className="of-fade-up rounded-2xl border border-line bg-white shadow-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">Files from the customer</p>
        <span className="text-[10px] text-ink-3">{items.length} received</span>
      </div>
      {note ? (
        <p className={"mt-2 text-[11px] " + (note.ok ? "text-ok" : "text-danger")}>
          {note.text}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {items.map((item) => {
          const inline = item.kind === "image" || item.kind === "audio";
          const showInline = inline && item.can_open && !broken[item.id];
          return (
            <li
              key={item.id}
              className="rounded-lg border border-line bg-soft px-2.5 py-2 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink-2">
                  {KIND_LABELS[item.kind] || "File"}
                  {item.size_bytes ? " · " + sizeLabel(item.size_bytes) : ""}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span
                    className={
                      "rounded-md border px-1.5 py-0.5 text-[10px] " +
                      (item.has_copy
                        ? "border-brand/25 bg-brand-soft text-brand"
                        : "border-line bg-white text-ink-3")
                    }
                  >
                    {item.has_copy ? "Saved" : "Link only"}
                  </span>
                  <button
                    onClick={() => void remove(item)}
                    disabled={busy !== null}
                    className="text-[10px] font-medium text-ink-3 hover:text-danger disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </div>
              {!item.has_copy && NOTE_LABELS[item.note] ? (
                <p className="mt-1 text-[10px] text-ink-3">{NOTE_LABELS[item.note]}</p>
              ) : null}
              {showInline && item.kind === "image" ? (
                <a
                  href={contentUrl(item.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 block"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={contentUrl(item.id)}
                    alt="Image sent by the customer"
                    loading="lazy"
                    onError={() => setBroken((current) => ({ ...current, [item.id]: true }))}
                    className="max-h-48 w-auto rounded-md border border-line bg-white object-contain"
                  />
                </a>
              ) : null}
              {showInline && item.kind === "audio" ? (
                <audio
                  controls
                  preload="none"
                  className="mt-1.5 h-7 w-full"
                  src={contentUrl(item.id)}
                  onError={() => setBroken((current) => ({ ...current, [item.id]: true }))}
                />
              ) : null}
              {inline && (broken[item.id] || !item.can_open) ? (
                <p className="mt-1 text-[10px] text-ink-3">
                  No longer available from the channel.
                </p>
              ) : null}
              {!inline && item.can_open ? (
                <div className="mt-1.5 flex items-center gap-2">
                  {links[item.id] ? (
                    <a
                      href={links[item.id]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-medium text-brand"
                    >
                      Open file
                    </a>
                  ) : (
                    <button
                      onClick={() => void getLink(item)}
                      disabled={busy !== null}
                      className="text-[10px] font-medium text-brand disabled:opacity-50"
                    >
                      {busy === item.id ? "Getting link…" : "Get link"}
                    </button>
                  )}
                  {item.can_refresh ? (
                    <span className="text-[10px] text-ink-3">
                      Instagram links expire; a fresh one is requested each time.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
