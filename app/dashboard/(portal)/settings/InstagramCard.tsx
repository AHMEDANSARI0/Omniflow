"use client";

import { useCallback, useEffect, useState } from "react";
import type { InstagramSettings } from "../../../../lib/omniflow/portal";
import MetaSetupPanel from "./MetaSetupPanel";

const inputClass =
  "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none";

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export interface InstagramCardProps {
  initialSettings?: Partial<InstagramSettings>;
}

export default function InstagramCard({ initialSettings }: InstagramCardProps = {}) {
  const [loaded, setLoaded] = useState(Boolean(initialSettings));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState("");
  const [errorNote, setErrorNote] = useState("");

  const [enabled, setEnabled] = useState(initialSettings?.enabled ?? false);
  const [accountId, setAccountId] = useState(initialSettings?.accountId ?? "");
  const [pageId, setPageId] = useState(initialSettings?.pageId ?? "");
  const [verifyTokenInput, setVerifyTokenInput] = useState(
    initialSettings?.verifyTokenMasked ?? ""
  );
  const [accessTokenInput, setAccessTokenInput] = useState("");
  const [accessTokenMasked, setAccessTokenMasked] = useState(
    initialSettings?.accessTokenMasked ?? ""
  );
  const [pageAccessTokenInput, setPageAccessTokenInput] = useState("");
  const [pageAccessTokenMasked, setPageAccessTokenMasked] = useState(
    initialSettings?.pageAccessTokenMasked ?? ""
  );
  const [appSecretInput, setAppSecretInput] = useState("");
  const [appSecretMasked, setAppSecretMasked] = useState(
    initialSettings?.appSecretMasked ?? ""
  );
  const [messengerEnabled, setMessengerEnabled] = useState(
    initialSettings?.messengerEnabled ?? false
  );
  const [commentsEnabled, setCommentsEnabled] = useState(
    initialSettings?.commentsEnabled ?? false
  );
  const [commentAutoReply, setCommentAutoReply] = useState(
    initialSettings?.commentAutoReply ?? false
  );
  const [cpSends, setCpSends] = useState(initialSettings?.cpSends ?? true);
  const [lastCheckAt, setLastCheckAt] = useState<string | null>(
    initialSettings?.lastCheckAt ?? null
  );
  const [lastWebhookAt, setLastWebhookAt] = useState<string | null>(
    initialSettings?.lastWebhookAt ?? null
  );
  const [lastSentAt, setLastSentAt] = useState<string | null>(
    initialSettings?.lastSentAt ?? null
  );
  const [lastError, setLastError] = useState(initialSettings?.lastError ?? "");
  const [sendError, setSendError] = useState(initialSettings?.sendError ?? "");

  const applySettings = useCallback((s: InstagramSettings) => {
    setEnabled(s.enabled === true);
    setAccountId(s.accountId || "");
    setPageId(s.pageId || "");
    setVerifyTokenInput(s.verifyTokenMasked || "");
    setAccessTokenMasked(s.accessTokenMasked || "");
    setPageAccessTokenMasked(s.pageAccessTokenMasked || "");
    setAppSecretMasked(s.appSecretMasked || "");
    setMessengerEnabled(s.messengerEnabled === true);
    setCommentsEnabled(s.commentsEnabled === true);
    setCommentAutoReply(s.commentAutoReply === true);
    setCpSends(s.cpSends !== false);
    setLastCheckAt(s.lastCheckAt || null);
    setLastWebhookAt(s.lastWebhookAt || null);
    setLastSentAt(s.lastSentAt || null);
    setLastError(s.lastError || "");
    setSendError(s.sendError || "");
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.settings) {
        applySettings(payload.settings as InstagramSettings);
      }
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    setErrorNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          account_id: accountId.trim(),
          page_id: pageId.trim(),
          access_token: accessTokenInput.trim(),
          page_access_token: pageAccessTokenInput.trim(),
          app_secret: appSecretInput.trim(),
          verify_token: verifyTokenInput.trim(),
          messenger_enabled: messengerEnabled,
          comments_enabled: commentsEnabled,
          comment_auto_reply: commentAutoReply,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || (payload && payload.error)) {
        setErrorNote(payload?.error?.message || "Could not save Instagram settings.");
        return;
      }
      if (payload?.settings) {
        applySettings(payload.settings as InstagramSettings);
      } else {
        await load();
      }
      setAccessTokenInput("");
      setPageAccessTokenInput("");
      setAppSecretInput("");
      setNote("Meta settings saved.");
    } catch {
      setErrorNote("Could not save Instagram settings — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyConnection() {
    if (testing || busy) return;
    setTesting(true);
    setNote("");
    setErrorNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/test", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || (payload && payload.error)) {
        setErrorNote(payload?.error?.message || "Meta Graph API verification failed.");
        return;
      }
      const igLabel = payload?.profile?.username
        ? "@" + payload.profile.username
        : payload?.profile?.id || "Instagram";
      const pageLabel = payload?.page?.name || payload?.page?.id || "";
      setNote(
        payload?.ok
          ? "Verified with Meta Graph API: " + igLabel + (pageLabel ? " · Page: " + pageLabel : "")
          : "Verification finished — check details below."
      );
      await load();
    } catch {
      setErrorNote("Could not verify Instagram connection right now.");
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-2xl border border-line bg-white p-5 shadow-card">
        <h2 className="text-sm font-medium text-ink">Instagram & Facebook Messenger</h2>
        <p className="mt-0.5 text-xs text-ink-3">Loading Meta channel settings...</p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink">Instagram & Facebook Messenger</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect your Instagram Business account and Facebook Page via the official Meta Graph API
            {cpSends ? " (Control Plane dispatches replies directly)" : " (via connector-node/instagram_bridge.py)"}.
          </p>
        </div>
        <span
          className={
            "rounded-full px-2.5 py-0.5 text-[11px] font-medium " +
            (enabled && (accessTokenMasked || pageAccessTokenMasked)
              ? "bg-ok/15 text-ok"
              : "bg-soft text-ink-3")
          }
        >
          {enabled && (accessTokenMasked || pageAccessTokenMasked) ? "Connected" : "Not configured"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable Instagram DMs
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={messengerEnabled}
            onChange={(e) => setMessengerEnabled(e.target.checked)}
          />
          Enable Facebook Messenger
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={commentsEnabled}
            onChange={(e) => setCommentsEnabled(e.target.checked)}
          />
          Ingest post comments
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={commentAutoReply}
            onChange={(e) => setCommentAutoReply(e.target.checked)}
          />
          Allow AI auto-reply on comments
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-2">
          Instagram Business Account ID
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="1784140..."
            className={inputClass}
          />
        </label>
        <label className="block text-xs text-ink-2">
          Facebook Page ID
          <input
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            placeholder="104829..."
            className={inputClass}
          />
        </label>
        <label className="block text-xs text-ink-2">
          Instagram / System User Access Token{" "}
          {accessTokenMasked ? (
            <span className="text-ink-3">({accessTokenMasked})</span>
          ) : null}
          <input
            type="password"
            value={accessTokenInput}
            onChange={(e) => setAccessTokenInput(e.target.value)}
            placeholder={accessTokenMasked ? "Leave blank to keep saved token" : "EAAB..."}
            className={inputClass}
          />
        </label>
        <label className="block text-xs text-ink-2">
          Facebook Page Access Token{" "}
          {pageAccessTokenMasked ? (
            <span className="text-ink-3">({pageAccessTokenMasked})</span>
          ) : null}
          <input
            type="password"
            value={pageAccessTokenInput}
            onChange={(e) => setPageAccessTokenInput(e.target.value)}
            placeholder={pageAccessTokenMasked ? "Leave blank to keep saved token" : "EAAB..."}
            className={inputClass}
          />
        </label>
        <label className="block text-xs text-ink-2">
          Meta App Secret{" "}
          {appSecretMasked ? <span className="text-ink-3">({appSecretMasked})</span> : null}
          <input
            type="password"
            value={appSecretInput}
            onChange={(e) => setAppSecretInput(e.target.value)}
            placeholder={appSecretMasked ? "Leave blank to keep saved secret" : "App secret for X-Hub-Signature-256"}
            className={inputClass}
          />
        </label>
        <label className="block text-xs text-ink-2">
          Webhook Verify Token
          <input
            value={verifyTokenInput}
            onChange={(e) => setVerifyTokenInput(e.target.value)}
            placeholder="Auto-generated on save if blank"
            className={inputClass}
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span>Last check: {fmtDate(lastCheckAt)}</span>
        <span>·</span>
        <span>Last webhook: {fmtDate(lastWebhookAt)}</span>
        <span>·</span>
        <span>Last reply sent: {fmtDate(lastSentAt)}</span>
      </div>

      {lastError ? (
        <p className="mt-2 text-xs text-danger">Graph check error: {lastError}</p>
      ) : null}
      {sendError ? (
        <p className="mt-1 text-xs text-danger">Last send error: {sendError}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || testing}
          className="inline-flex min-h-9 items-center rounded-xl bg-brand px-4 py-2 text-xs font-medium text-white hover:bg-brand-2 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save settings"}
        </button>
        <button
          type="button"
          onClick={() => void verifyConnection()}
          disabled={busy || testing}
          className="inline-flex min-h-9 items-center rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 hover:bg-soft disabled:opacity-50"
        >
          {testing ? "Verifying with Meta..." : "Verify connection"}
        </button>
      </div>

      {note ? <p className="mt-2 text-xs text-ok">{note}</p> : null}
      {errorNote ? <p className="mt-2 text-xs text-danger">{errorNote}</p> : null}

      <MetaSetupPanel disabled={!enabled || busy} />
    </section>
  );
}
