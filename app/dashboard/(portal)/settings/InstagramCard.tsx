"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MetaSetupPanel from "./MetaSetupPanel";

type HybridMode = "hybrid" | "api" | "login";

type MetaState = {
  accountId: string;
  pageId: string;
  mode?: HybridMode;
  apiConnected?: boolean;
  loginConnected?: boolean;
  loginUsername?: string;
  loginPasswordMasked?: string;
  sessionCookieMasked?: string;
  enabled: boolean;
  configured: boolean;
  messengerEnabled: boolean;
  commentsEnabled: boolean;
  commentAutoReply: boolean;
  accessTokenMasked: string;
  pageAccessTokenMasked: string;
  appSecretMasked: string;
  verifyTokenMasked: string;
  webhookPath: string;
  lastCheckAt: string | null;
  lastError: string | null;
  cpSends: boolean;
  lastSentAt: string | null;
  sendError: string | null;
};

const EMPTY: MetaState = {
  accountId: "",
  pageId: "",
  mode: "hybrid",
  apiConnected: false,
  loginConnected: false,
  loginUsername: "",
  loginPasswordMasked: "",
  sessionCookieMasked: "",
  enabled: false,
  configured: false,
  messengerEnabled: true,
  commentsEnabled: true,
  commentAutoReply: true,
  accessTokenMasked: "",
  pageAccessTokenMasked: "",
  appSecretMasked: "",
  verifyTokenMasked: "",
  webhookPath: "/api/v1/public/meta/webhook",
  lastCheckAt: null,
  lastError: null,
  cpSends: true,
  lastSentAt: null,
  sendError: null,
};

const INPUT =
  "mt-1 w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink focus:border-brand/50 focus:outline-none";

function SecretField(props: {
  label: string;
  masked: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={"block" + (props.wide ? " sm:col-span-2" : "")}>
      <span className="text-[11px] text-ink-3">
        {props.label} {props.masked ? "(" + props.masked + ")" : ""}
      </span>
      <input
        type="password"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.masked ? "Leave blank to keep the saved value" : props.placeholder}
        autoComplete="new-password"
        className={INPUT}
      />
      {props.hint ? <span className="mt-1 block text-[10px] text-ink-3">{props.hint}</span> : null}
    </label>
  );
}

function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={
        "flex items-start gap-2 rounded-lg border border-line bg-soft px-3 py-2 " +
        (props.disabled ? "opacity-50" : "")
      }
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-xs text-ink">{props.label}</span>
        <span className="block text-[10px] text-ink-3">{props.hint}</span>
      </span>
    </label>
  );
}

export default function InstagramCard() {
  const [settings, setSettings] = useState<MetaState>(EMPTY);
  const [accessToken, setAccessToken] = useState("");
  const [pageAccessToken, setPageAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [sessionCookie, setSessionCookie] = useState("");
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
      setNote("Could not load the Meta settings.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof MetaState>(key: K, value: MetaState[K]) {
    setSettings((old) => ({ ...old, [key]: value }));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(
            settings.accountId.trim() ||
              settings.pageId.trim() ||
              (settings.loginUsername || "").trim()
          ),
          mode: settings.mode || "hybrid",
          account_id: settings.accountId.trim(),
          page_id: settings.pageId.trim(),
          access_token: accessToken.trim(),
          page_access_token: pageAccessToken.trim(),
          app_secret: appSecret.trim(),
          verify_token: verifyToken.trim(),
          login_username: (settings.loginUsername || "").trim(),
          login_password: loginPassword.trim(),
          session_cookie: sessionCookie.trim(),
          messenger_enabled: settings.messengerEnabled,
          comments_enabled: settings.commentsEnabled,
          comment_auto_reply: settings.commentsEnabled && settings.commentAutoReply,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "Could not save the Meta settings.");
        return;
      }
      setAccessToken("");
      setPageAccessToken("");
      setAppSecret("");
      setVerifyToken("");
      setLoginPassword("");
      setSessionCookie("");
      setNote("Hybrid Instagram & Facebook configuration saved.");
      await load();
    } catch {
      setNote("Could not save the Meta settings.");
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
        setNote(payload?.error?.message || "Verification failed.");
        await load();
        return;
      }
      const parts: string[] = [];
      if (payload.profile?.username) parts.push("@" + payload.profile.username);
      if (payload.page?.name) parts.push(payload.page.name);
      setNote(
        parts.length
          ? "Verified Hybrid Meta connection for " + parts.join(" and ") + "."
          : "Verified Hybrid Meta connection."
      );
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
        <h2 className="text-sm font-medium text-ink">Instagram, Messenger and comments (Hybrid)</h2>
        <p className="mt-0.5 text-xs text-ink-3">Loading...</p>
      </section>
    );
  }

  const currentMode: HybridMode = settings.mode || "hybrid";

  return (
    <section className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">
            Instagram & Facebook Messenger{" "}
            <span className="ml-1 text-[11px] font-normal text-brand">
              Hybrid (API + Login)
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect via Official Meta Graph API, Direct Account Login/Session Cookie, or Hybrid Auto-Failover.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "rounded-md border px-2 py-0.5 text-[10px] " +
              (settings.enabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                : "border-line bg-soft text-ink-3")
            }
          >
            {settings.enabled ? `Connected (${currentMode.toUpperCase()})` : "Not connected"}
          </span>
        </div>
      </div>

      {/* Hybrid Mode Selector */}
      <div className="mt-4 flex flex-wrap gap-2">
        {(
          [
            { id: "hybrid", label: "⚡ Hybrid (API + Account Login)" },
            { id: "api", label: "🔌 Official Meta API" },
            { id: "login", label: "🔑 Account Login / Session" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => set("mode", m.id)}
            className={
              "rounded-lg border px-3 py-1.5 text-xs font-medium " +
              (currentMode === m.id
                ? "border-brand/30 bg-brand/[0.08] text-brand"
                : "border-line bg-soft text-ink-3 hover:text-ink")
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* API Fields */}
      {(currentMode === "hybrid" || currentMode === "api") && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] text-ink-3">Instagram Professional Account ID</span>
            <input
              value={settings.accountId}
              onChange={(event) => set("accountId", event.target.value)}
              placeholder="Instagram Professional account ID"
              autoComplete="off"
              className={INPUT}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">Facebook Page ID</span>
            <input
              value={settings.pageId}
              onChange={(event) => set("pageId", event.target.value)}
              placeholder="Needed for Messenger and Facebook comments"
              autoComplete="off"
              className={INPUT}
            />
          </label>
          <SecretField
            label="Meta Access Token"
            masked={settings.accessTokenMasked}
            value={accessToken}
            onChange={setAccessToken}
            placeholder="Meta access token"
          />
          <SecretField
            label="Page Access Token (optional)"
            masked={settings.pageAccessTokenMasked}
            value={pageAccessToken}
            onChange={setPageAccessToken}
            placeholder="Only if the Page uses a different token"
          />
          <SecretField
            label="Meta App Secret"
            masked={settings.appSecretMasked}
            value={appSecret}
            onChange={setAppSecret}
            placeholder="Meta app secret"
          />
          <SecretField
            label="Webhook Verify Token"
            masked={settings.verifyTokenMasked}
            value={verifyToken}
            onChange={setVerifyToken}
            placeholder="A private token you also enter in Meta"
          />
        </div>
      )}

      {/* Account Login / Session Bridge Fields */}
      {(currentMode === "hybrid" || currentMode === "login") && (
        <div className="mt-4 rounded-xl border border-line bg-soft/40 p-3.5">
          <p className="text-xs font-medium text-ink">
            Direct Instagram / Facebook Account Login & Session Bridge
          </p>
          <p className="text-[11px] text-ink-3">
            Works even without a Meta Developer App — sign in with your account credentials or session cookie.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-[11px] text-ink-3">Username / Email / Phone</span>
              <input
                value={settings.loginUsername || ""}
                onChange={(event) => set("loginUsername", event.target.value)}
                placeholder="@yourbrand or email@domain.com"
                autoComplete="off"
                className={INPUT}
              />
            </label>
            <SecretField
              label="Account Password"
              masked={settings.loginPasswordMasked || ""}
              value={loginPassword}
              onChange={setLoginPassword}
              placeholder="Instagram / Facebook password"
            />
            <SecretField
              label="Session Cookie (sessionid / c_user)"
              masked={settings.sessionCookieMasked || ""}
              value={sessionCookie}
              onChange={setSessionCookie}
              placeholder="Optional session cookie"
            />
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Toggle
          label="Facebook Messenger"
          hint="Page messages arrive as Messenger conversations."
          checked={settings.messengerEnabled}
          onChange={(value) => set("messengerEnabled", value)}
        />
        <Toggle
          label="Comments on posts"
          hint="New comments arrive in the inbox. Your reply is posted publicly under the comment."
          checked={settings.commentsEnabled}
          onChange={(value) => set("commentsEnabled", value)}
        />
        <Toggle
          label="AI answers comments"
          hint="Off: comments wait for your team. On: the AI replies publicly when AI autonomy is Auto."
          checked={settings.commentsEnabled && settings.commentAutoReply}
          disabled={!settings.commentsEnabled}
          onChange={(value) => set("commentAutoReply", value)}
        />
      </div>

      <MetaSetupPanel disabled={!settings.configured} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-brand/30 bg-brand-soft inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-brand hover:bg-brand/[0.12] disabled:opacity-50"
        >
          {busy ? "Saving..." : `Save Hybrid Configuration (${currentMode.toUpperCase()})`}
        </button>
        <button
          onClick={() => void verify()}
          disabled={busy}
          className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 hover:bg-line/60 disabled:opacity-50"
        >
          Verify & Connect Now
        </button>
        <Link
          href="/dashboard/channels"
          className="rounded-lg border border-line bg-soft inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink"
        >
          Open All 8 Hybrid Connectors Hub →
        </Link>
        {note ? <span className="text-[11px] text-ink-3">{note}</span> : null}
      </div>
    </section>
  );
}
