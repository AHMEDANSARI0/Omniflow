"use client";

import { useCallback, useEffect, useState } from "react";

type InstagramState = {
  accountId: string;
  pageId: string;
  enabled: boolean;
  configured: boolean;
  accessTokenMasked: string;
  appSecretMasked: string;
  verifyTokenMasked: string;
  lastCheckAt: string | null;
  lastError: string | null;
};

const EMPTY: InstagramState = {
  accountId: "",
  pageId: "",
  enabled: false,
  configured: false,
  accessTokenMasked: "",
  appSecretMasked: "",
  verifyTokenMasked: "",
  lastCheckAt: null,
  lastError: null,
};

export default function InstagramCard() {
  const [settings, setSettings] = useState<InstagramState>(EMPTY);
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.settings) {
        setSettings({ ...EMPTY, ...payload.settings });
      }
    } catch {
      setNote("Could not load Instagram settings.");
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
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(settings.accountId.trim()),
          account_id: settings.accountId.trim(),
          page_id: settings.pageId.trim(),
          access_token: accessToken.trim(),
          app_secret: appSecret.trim(),
          verify_token: verifyToken.trim(),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "Could not save Instagram settings.");
        return;
      }
      setAccessToken("");
      setAppSecret("");
      setVerifyToken("");
      setNote(
        payload.requiresCheck === false
          ? "Saved. Meta verification is still required before delivery."
          : "Saved. Verify the account with Meta before accepting messages."
      );
      await load();
    } catch {
      setNote("Could not save Instagram settings.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/test", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "Meta verification failed.");
        await load();
        return;
      }
      const username = payload.profile?.username;
      setNote(username ? "Verified with Meta for @" + username + "." : "Verified with Meta.");
      await load();
    } catch {
      setNote("Meta verification failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-medium text-ink">Instagram Messaging</h2>
        <p className="mt-0.5 text-xs text-ink-3">Loading...</p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">Instagram Messaging</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect an Instagram Professional account through Meta's Messaging API.
          </p>
        </div>
        <span
          className={
            "rounded-md border px-2 py-0.5 text-[10px] " +
            (settings.enabled
              ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
              : "border-line bg-soft text-ink-3")
          }
        >
          {settings.enabled ? "Verified" : "Not verified"}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] text-ink-3">Instagram account ID</span>
          <input
            value={settings.accountId}
            onChange={(event) => setSettings((old) => ({ ...old, accountId: event.target.value }))}
            placeholder="Instagram Professional account ID"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-3">Facebook Page ID (optional)</span>
          <input
            value={settings.pageId}
            onChange={(event) => setSettings((old) => ({ ...old, pageId: event.target.value }))}
            placeholder="Connected Facebook Page ID"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-3">
            Access token {settings.accessTokenMasked ? "(" + settings.accessTokenMasked + ")" : ""}
          </span>
          <input
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder={settings.accessTokenMasked ? "Leave blank to keep saved token" : "Meta access token"}
            autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-3">
            App secret {settings.appSecretMasked ? "(" + settings.appSecretMasked + ")" : ""}
          </span>
          <input
            type="password"
            value={appSecret}
            onChange={(event) => setAppSecret(event.target.value)}
            placeholder={settings.appSecretMasked ? "Leave blank to keep saved secret" : "Meta app secret"}
            autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] text-ink-3">
            Webhook verify token {settings.verifyTokenMasked ? "(" + settings.verifyTokenMasked + ")" : ""}
          </span>
          <input
            type="password"
            value={verifyToken}
            onChange={(event) => setVerifyToken(event.target.value)}
            placeholder={settings.verifyTokenMasked ? "Leave blank to keep saved token" : "A private token you also enter in Meta"}
            autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
          <span className="mt-1 block text-[10px] text-ink-3">
            Configure Meta to call /api/v1/public/instagram/webhook on the Control Plane.
          </span>
        </label>
      </div>

      {settings.lastError ? (
        <p className="mt-3 text-[11px] text-danger">Last provider error: {settings.lastError}</p>
      ) : null}
      {settings.lastCheckAt ? (
        <p className="mt-2 text-[10px] text-ink-3">Last verified: {settings.lastCheckAt}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save configuration"}
        </button>
        <button
          onClick={() => void verify()}
          disabled={busy || !settings.configured}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-white/[0.06] disabled:opacity-50"
        >
          Verify with Meta
        </button>
        {note ? <span className="text-[11px] text-ink-3">{note}</span> : null}
      </div>
    </section>
  );
}
