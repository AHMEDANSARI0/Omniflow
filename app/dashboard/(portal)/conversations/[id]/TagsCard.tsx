"use client";

import { useState } from "react";

const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 24;

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function TagsCard({
  conversationId,
  initialTags,
}: {
  conversationId: number;
  initialTags: string[];
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function addTag() {
    const tag = value.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${conversationId}/tags`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ tag }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        duplicate?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setTags((current) =>
          payload.duplicate || current.some((t) => t.toLowerCase() === tag.toLowerCase())
            ? current
            : [...current, tag]
        );
        setValue("");
        setMessage(
          payload.duplicate ? "This label is already on the chat." : null
        );
      } else {
        setMessage(payload?.error?.message || "Could not add the label.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${conversationId}/tags?tag=${encodeURIComponent(tag)}`,
        { method: "DELETE", credentials: "same-origin" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
      } | null;
      if (response.ok && payload?.ok) {
        setTags((current) => current.filter((t) => t !== tag));
      } else {
        setMessage("Could not remove the label.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-white">Labels</h2>
        <span className="text-[10px] text-slate-500">
          {tags.length}/{MAX_TAGS}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
        Group chats your own way — labels show as chips in the inbox and become
        filters.
      </p>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium"
              style={{
                borderColor: `hsl(${tagHue(tag)} 70% 50% / 0.35)`,
                backgroundColor: `hsl(${tagHue(tag)} 70% 50% / 0.10)`,
                color: `hsl(${tagHue(tag)} 80% 74%)`,
              }}
            >
              #{tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={busy}
                aria-label={`Remove label ${tag}`}
                className="text-[13px] leading-none opacity-60 transition-opacity hover:opacity-100 disabled:opacity-30"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void addTag();
            }
          }}
          maxLength={MAX_TAG_LENGTH}
          placeholder={
            tags.length >= MAX_TAGS ? "Label limit reached" : "e.g. wholesale"
          }
          disabled={tags.length >= MAX_TAGS}
          className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void addTag()}
          disabled={busy || tags.length >= MAX_TAGS || !value.trim()}
          className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
        >
          {busy ? "Working…" : "Add label"}
        </button>
      </div>

      {message && <p className="mt-2 text-xs text-slate-400">{message}</p>}
    </div>
  );
}
