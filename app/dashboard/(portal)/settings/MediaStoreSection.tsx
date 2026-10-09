"use client";

import { useCallback, useEffect, useState } from "react";

/** §214: copies of customer images / voice notes (media store) - keep
 * switch, keep period, storage limit and current usage. Rendered inside
 * the Voice and images card. */
interface MediaStoreSettings {
  keep_copies: boolean;
  retention_days: number;
  quota_mb: number;
}

interface MediaStorePayload {
  settings: MediaStoreSettings;
  usage: { used_bytes: number; copies: number; files: number };
  limits: {
    mode: string;
    max_file_bytes: number;
    max_quota_mb: number;
    max_retention_days: number;
  };
}

const INPUT =
  "w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none";

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

export default function MediaStoreSection() {
  const [data, setData] = useState<MediaStorePayload | null>(null);
  const [draft, setDraft] = useState<MediaStoreSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/media-store/settings", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as MediaStorePayload | null;
      if (!response.ok || !payload || !payload.settings) {
        setFailed(true);
        return;
      }
      setData(payload);
      setDraft(payload.settings);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/media-store/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (MediaStorePayload & { error?: { message?: string } })
        | null;
      if (response.ok && payload && payload.settings) {
        setData(payload);
        setDraft(payload.settings);
        setNotice({ text: "Storage settings saved.", ok: true });
      } else {
        setNotice({
          text: payload?.error?.message || "Could not save - try again.",
          ok: false,
        });
      }
    } catch {
      setNotice({ text: "Could not reach the server - try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <div className="mt-4 rounded-xl border border-line bg-soft/60 p-4">
        <p className="text-xs font-semibold text-ink">Customer file storage</p>
        <p className="mt-1 text-[11px] text-ink-3">
          Storage settings are unavailable right now.
        </p>
      </div>
    );
  }
  if (!data || !draft) return null;

  const quotaBytes = data.settings.quota_mb * 1024 * 1024;
  const percent = quotaBytes
    ? Math.min(100, Math.round((data.usage.used_bytes / quotaBytes) * 100))
    : 0;
  const paused = data.limits.mode === "off";

  return (
    <div className="mt-4 rounded-xl border border-line bg-soft/60 p-4">
      <p className="text-xs font-semibold text-ink">Customer file storage</p>
      <p className="mt-1 text-[11px] text-ink-3">
        Keep a copy of the images and voice notes customers send, so they stay
        visible in the conversation after the channel link expires (Instagram
        links last about a day). Videos and other files are kept as links.
        The oldest copies are removed first when the limit is reached.
      </p>
      {paused ? (
        <p className="mt-2 text-[11px] text-danger">Paused by the platform.</p>
      ) : null}
      <label className="mt-3 flex items-center gap-3 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={draft.keep_copies}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, keep_copies: event.target.checked })}
          className="h-4 w-4 accent-brand"
        />
        Keep copies of customer images and voice notes
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] text-ink-2">
          Keep files for (days)
          <input
            type="number"
            min={1}
            max={data.limits.max_retention_days}
            value={draft.retention_days}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, retention_days: Number.parseInt(event.target.value, 10) || 1 })
            }
            className={INPUT + " mt-1"}
          />
        </label>
        <label className="text-[11px] text-ink-2">
          Storage limit (MB)
          <input
            type="number"
            min={10}
            max={data.limits.max_quota_mb}
            value={draft.quota_mb}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, quota_mb: Number.parseInt(event.target.value, 10) || 10 })
            }
            className={INPUT + " mt-1"}
          />
        </label>
      </div>
      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white">
          <div className="h-full rounded-full bg-brand" style={{ width: percent + "%" }} />
        </div>
        <p className="mt-1 text-[10px] text-ink-3">
          {mb(data.usage.used_bytes)} MB of {data.settings.quota_mb} MB used ·{" "}
          {data.usage.copies} saved copies · {data.usage.files} files received · up to{" "}
          {mb(data.limits.max_file_bytes)} MB per file
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save storage settings"}
        </button>
        {notice ? (
          <span className={"text-[11px] " + (notice.ok ? "text-ok" : "text-danger")}>
            {notice.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
