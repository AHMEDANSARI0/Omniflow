"use client";

import { useCallback, useEffect, useState } from "react";

interface WatiTemplate {
  name: string;
  data: Record<string, unknown>;
}

export default function WatiCard() {
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [tokenMasked, setTokenMasked] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [templates, setTemplates] = useState<WatiTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/wati/settings", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.settings) {
        setEnabled(payload.settings.enabled === true);
        setBaseUrl(payload.settings.baseUrl || "");
        setTokenMasked(payload.settings.tokenMasked || "");
      }
      const listResponse = await fetch(
        "/api/omniflow/portal/wati/templates",
        { cache: "no-store" }
      );
      const listPayload = await listResponse.json().catch(() => null);
      if (listPayload && Array.isArray(listPayload.templates)) {
        setTemplates(listPayload.templates);
      }
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/wati/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          base_url: baseUrl.trim(),
          api_token: tokenInput.trim() || "keep-existing-token-placeholder",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not save.");
        return;
      }
      setNote("Saved.");
      setTokenInput("");
      await load();
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/wati/sync", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not sync.");
        return;
      }
      setNote(
        payload && typeof payload.count === "number"
          ? "Synced " + payload.count + " approved templates."
          : "Synced."
      );
      await load();
    } catch {
      setNote("Could not sync - try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-2xl border border-line bg-soft p-5">
        <h2 className="text-sm font-medium text-ink">WATI templates</h2>
        <p className="mt-0.5 text-xs text-ink-3">Loading...</p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-soft p-5">
      <h2 className="text-sm font-medium text-ink">WATI templates</h2>
      <p className="mt-0.5 text-xs text-ink-3">
        WATI pe approved templates se direct WhatsApp messages bhejein. Token
        sirf masked save hota hai.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="text-[11px] text-ink-3">Enabled</span>
          <button
            onClick={() => setEnabled((value) => !value)}
            className={
              "mt-1 block rounded-lg border px-3 py-1.5 text-xs "
              + (enabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                : "border-line text-ink-3")
            }
          >
            {enabled ? "On" : "Off"}
          </button>
        </label>
        <label className="block flex-1 min-w-56">
          <span className="text-[11px] text-ink-3">
            WATI tenant URL (e.g. https://live-mt-server.wati.io/12345)
          </span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://live-mt-server.wati.io/xxxxx"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block flex-1 min-w-56">
          <span className="text-[11px] text-ink-3">
            API token {tokenMasked ? "(saved: " + tokenMasked + ")" : ""}
          </span>
          <input
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder={tokenMasked ? "Unchanged - bas badalna ho to likhein" : "Paste API token"}
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save"}
        </button>
        <button
          onClick={() => void sync()}
          disabled={busy || !enabled}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-white/[0.06] disabled:opacity-50"
        >
          Sync approved templates
        </button>
      </div>

      {templates.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {templates.map((template) => (
            <span
              key={template.name}
              className="rounded-md border border-line bg-soft px-2 py-0.5 text-[10px] text-ink-2"
            >
              {template.name}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-ink-3">
          Abhi koi approved template sync nahi hua. Sync dabane par WATI se
          approved templates yahan aa jayenge - phir chats se bhej sakte hain.
        </p>
      )}
      {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}
    </section>
  );
}
