"use client";

import { useState } from "react";

import {
  KIND_LABELS,
  NOTE_LABELS,
  contentUrl,
  fetchMediaLink,
  sizeLabel,
  type InboundMediaItem,
} from "./inbound-media-shared";

/** §215: customer files shown inside their chat bubble - image thumbnails,
 * voice-note players, and an on-demand link for videos / other files.
 * Bytes come from the media store (stored copy, provider link or a fresh
 * Instagram link); a file that is gone shows a short note instead. */
export default function MessageMedia({ items }: { items: InboundMediaItem[] }) {
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const [links, setLinks] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  if (items.length === 0) return null;

  async function getLink(item: InboundMediaItem) {
    if (busy !== null) return;
    setBusy(item.id);
    const result = await fetchMediaLink(item.id);
    if ("url" in result) {
      setLinks((current) => ({ ...current, [item.id]: result.url }));
    } else {
      setErrors((current) => ({ ...current, [item.id]: result.error }));
    }
    setBusy(null);
  }

  function markBroken(id: number) {
    setBroken((current) => ({ ...current, [id]: true }));
  }

  return (
    <div className="mb-1.5 space-y-1.5">
      {items.map((item) => {
        const label = KIND_LABELS[item.kind] || "File";
        const gone = !item.can_open || broken[item.id];
        if ((item.kind === "image" || item.kind === "audio") && gone) {
          return (
            <p
              key={item.id}
              className="rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[11px] text-ink-3"
            >
              {label} no longer available
              {NOTE_LABELS[item.note] ? " · " + NOTE_LABELS[item.note] : ""}
            </p>
          );
        }
        if (item.kind === "image") {
          return (
            <a
              key={item.id}
              href={contentUrl(item.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the full image"
              className="block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={contentUrl(item.id)}
                alt="Image sent by the customer"
                loading="lazy"
                onError={() => markBroken(item.id)}
                className="max-h-64 w-auto max-w-full rounded-xl border border-line bg-white object-contain"
              />
            </a>
          );
        }
        if (item.kind === "audio") {
          return (
            <audio
              key={item.id}
              controls
              preload="none"
              src={contentUrl(item.id)}
              onError={() => markBroken(item.id)}
              aria-label="Voice note from the customer"
              className="h-8 w-64 max-w-full"
            />
          );
        }
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px]"
          >
            <span className="text-ink-2">
              {label}
              {item.size_bytes ? " · " + sizeLabel(item.size_bytes) : ""}
            </span>
            {!item.can_open ? (
              <span className="text-ink-3">No longer available</span>
            ) : links[item.id] ? (
              <a
                href={links[item.id]}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand"
              >
                Open file
              </a>
            ) : (
              <button
                type="button"
                onClick={() => void getLink(item)}
                disabled={busy !== null}
                className="font-medium text-brand disabled:opacity-50"
              >
                {busy === item.id ? "Getting link…" : "Get link"}
              </button>
            )}
            {errors[item.id] ? <span className="text-danger">{errors[item.id]}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
