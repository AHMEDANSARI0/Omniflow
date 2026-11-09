"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type ConnectorPlatform =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "linkedin"
  | "whatsapp"
  | "x"
  | "youtube"
  | "telegram_user";

type HybridMode = "hybrid" | "api" | "login";

interface HybridConnectorFlags {
  dm: boolean;
  comments: boolean;
  publish: boolean;
  comment_auto_reply: boolean;
  story_replies: boolean;
}

interface HybridChannelConfig {
  channel: ConnectorPlatform;
  label: string;
  badge: string;
  mode: HybridMode;
  enabled: boolean;
  connected: boolean;
  apiConnected: boolean;
  loginConnected: boolean;
  autoFailover: boolean;
  accountName: string;
  appId: string;
  appSecretMasked: string;
  accessTokenMasked: string;
  pageId: string;
  organizationId: string;
  verifyTokenMasked: string;
  bearerTokenMasked: string;
  consumerSecretMasked: string;
  webhookUrl: string;
  webhookRegistered: boolean;
  loginUsername: string;
  loginPasswordMasked: string;
  sessionCookieMasked: string;
  twoFactorCode: string;
  bridgeUrl: string;
  bridgeState: string;
  flags: HybridConnectorFlags;
  lastCheckAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

interface SocialPostEntry {
  id: number;
  channel: string;
  body: string;
  media_url: string;
  status: string;
  created_at: string | null;
}

interface ConnectorsPayload {
  client_id: number;
  workspace_name: string;
  plan: string;
  allowed_channels: string[];
  connected_channels: string[];
  hybrid: Record<ConnectorPlatform, HybridChannelConfig>;
  social: {
    posts: SocialPostEntry[];
  };
}

type TabKey = ConnectorPlatform | "publish";

const PLATFORM_META: Record<
  ConnectorPlatform,
  {
    short: string;
    title: string;
    subtitle: string;
    appIdLabel: string;
    appIdPlaceholder: string;
    secretLabel: string;
    tokenLabel: string;
    extraIdLabel?: string;
    extraIdPlaceholder?: string;
    loginUserLabel: string;
    loginUserPlaceholder: string;
    cookieLabel: string;
    cookiePlaceholder: string;
  }
> = {
  instagram: {
    short: "Instagram",
    title: "Instagram Hybrid Connector (Graph API + Account Login)",
    subtitle:
      "Connect via Meta Graph API, direct Instagram Account Login/Session, or Hybrid Auto-Failover for DMs, Story replies, Reels & Post comments.",
    appIdLabel: "Instagram Professional Account ID",
    appIdPlaceholder: "e.g. 17841405822304914",
    secretLabel: "Meta App Secret",
    tokenLabel: "Meta System User / Graph Access Token",
    extraIdLabel: "Connected Facebook Page ID (optional)",
    extraIdPlaceholder: "e.g. 10492819482",
    loginUserLabel: "Instagram Username / Email / Phone",
    loginUserPlaceholder: "@yourbrand.pk or email@domain.com",
    cookieLabel: "Instagram sessionid Cookie (optional)",
    cookiePlaceholder: "Paste sessionid cookie for passwordless session bridge",
  },
  facebook: {
    short: "Facebook",
    title: "Facebook Page & Messenger Hybrid Connector",
    subtitle:
      "Connect your Facebook Page & Messenger inbox via Official Page Access Token, Account Login Session, or Hybrid mode.",
    appIdLabel: "Facebook App ID",
    appIdPlaceholder: "e.g. 928374928374",
    secretLabel: "Facebook App Secret",
    tokenLabel: "Facebook Page Access Token",
    extraIdLabel: "Facebook Page ID",
    extraIdPlaceholder: "e.g. 104928194827192",
    loginUserLabel: "Facebook Login Email / Phone",
    loginUserPlaceholder: "page-admin@business.com",
    cookieLabel: "Facebook c_user / xs Session Cookie (optional)",
    cookiePlaceholder: "c_user=...; xs=...",
  },
  tiktok: {
    short: "TikTok",
    title: "TikTok Business Hybrid Connector",
    subtitle:
      "Handle TikTok Direct Messages, video comment auto-replies, and video publishing via TikTok Developer API + Account Login Bridge.",
    appIdLabel: "TikTok App ID / Client Key",
    appIdPlaceholder: "aw1234567890",
    secretLabel: "TikTok Client Secret",
    tokenLabel: "TikTok OAuth Access Token (optional)",
    extraIdLabel: "TikTok Business Account ID",
    extraIdPlaceholder: "e.g. 719283749283",
    loginUserLabel: "TikTok Handle / Email / Phone",
    loginUserPlaceholder: "@yourbrand.tiktok",
    cookieLabel: "TikTok sessionid Cookie (optional)",
    cookiePlaceholder: "sessionid=...",
  },
  linkedin: {
    short: "LinkedIn",
    title: "LinkedIn Company Page & Profile Hybrid Connector",
    subtitle:
      "Automate LinkedIn Company Page comment replies, InMail/DM lead capture, and B2B post publishing with API + Account Login.",
    appIdLabel: "LinkedIn OAuth Client ID",
    appIdPlaceholder: "86abcdef123456",
    secretLabel: "LinkedIn OAuth Client Secret",
    tokenLabel: "LinkedIn Access Token (optional)",
    extraIdLabel: "Company / Organization Page ID",
    extraIdPlaceholder: "e.g. 98421045",
    loginUserLabel: "LinkedIn Account Email",
    loginUserPlaceholder: "founder@company.com",
    cookieLabel: "LinkedIn li_at Session Cookie (optional)",
    cookiePlaceholder: "AQEDAR...",
  },
  whatsapp: {
    short: "WhatsApp",
    title: "WhatsApp Business Hybrid Connector (Cloud API + QR/Phone Login)",
    subtitle:
      "Run Official Meta WhatsApp Cloud API (WABA) alongside the Managed Phone/QR Session Bridge with automatic failover.",
    appIdLabel: "Phone Number ID (Cloud API)",
    appIdPlaceholder: "e.g. 109283746512",
    secretLabel: "Meta App Secret",
    tokenLabel: "WhatsApp Cloud API Permanent Token",
    extraIdLabel: "WhatsApp Business Account (WABA) ID",
    extraIdPlaceholder: "e.g. 203948576123",
    loginUserLabel: "WhatsApp Business Phone Number",
    loginUserPlaceholder: "+923001234567",
    cookieLabel: "Pairing Session Key / Multi-Device Token (optional)",
    cookiePlaceholder: "wa_md_session_...",
  },
  x: {
    short: "X (Twitter)",
    title: "X (Twitter) Hybrid Connector (API v2 + Account Login)",
    subtitle:
      "Respond to X Direct Messages, Mentions, and publish posts using Official X API keys or Account Login Session.",
    appIdLabel: "X Client ID / Consumer API Key",
    appIdPlaceholder: "e.g. Rk9s8d7f6g5h...",
    secretLabel: "X API Key Secret / Consumer Secret",
    tokenLabel: "X Bearer Token / Access Token",
    extraIdLabel: "X Account User ID (optional)",
    extraIdPlaceholder: "e.g. 1429384756",
    loginUserLabel: "X Username / Email",
    loginUserPlaceholder: "@yourbrand_x",
    cookieLabel: "X auth_token & ct0 Cookie (optional)",
    cookiePlaceholder: "auth_token=...; ct0=...",
  },
  youtube: {
    short: "YouTube",
    title: "YouTube Channel & Shorts Hybrid Connector",
    subtitle:
      "Auto-reply to YouTube video & Shorts comments and manage community posts via Google YouTube Data API v3 + Studio Login.",
    appIdLabel: "Google OAuth Client ID",
    appIdPlaceholder: "123456-abcdef.apps.googleusercontent.com",
    secretLabel: "Google OAuth Client Secret",
    tokenLabel: "YouTube OAuth Access / Refresh Token",
    extraIdLabel: "YouTube Channel ID",
    extraIdPlaceholder: "UC...",
    loginUserLabel: "YouTube / Google Studio Email",
    loginUserPlaceholder: "channel@gmail.com",
    cookieLabel: "YouTube Studio SAPISID / Session Cookie (optional)",
    cookiePlaceholder: "SAPISID=...",
  },
  telegram_user: {
    short: "Telegram",
    title: "Telegram Hybrid Connector (Bot API + Personal MTProto Login)",
    subtitle:
      "Connect both a @BotFather Telegram Bot and a personal Telegram phone account (MTProto) for DMs, groups, and channels.",
    appIdLabel: "Telegram MTProto api_id (or Bot ID)",
    appIdPlaceholder: "e.g. 24567891",
    secretLabel: "Telegram MTProto api_hash",
    tokenLabel: "Telegram Bot Token (@BotFather)",
    extraIdLabel: "Telegram Channel / Group ID (optional)",
    extraIdPlaceholder: "@yourchannel or -100...",
    loginUserLabel: "Telegram Account Phone Number",
    loginUserPlaceholder: "+923001234567",
    cookieLabel: "Telegram StringSession / 2FA Password (optional)",
    cookiePlaceholder: "1BVtsOHwBu...",
  },
};

const INPUT_CLASS =
  "mt-1 w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-brand/40";
const BTN_PRIMARY =
  "rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50";
const BTN_SECONDARY =
  "rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 shadow-card transition-colors hover:border-brand/40 hover:text-ink disabled:opacity-50";

export default function SocialConnectorsHub({
  adminClientId,
  workspaceLabel,
}: {
  adminClientId?: number;
  workspaceLabel?: string;
}) {
  const endpoint = adminClientId
    ? `/api/omniflow/admin/clients/${adminClientId}/connectors`
    : "/api/omniflow/portal/connectors";

  const [data, setData] = useState<ConnectorsPayload | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("instagram");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Active channel draft state
  const [mode, setMode] = useState<HybridMode>("hybrid");
  const [autoFailover, setAutoFailover] = useState(true);
  const [accountName, setAccountName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [extraId, setExtraId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [sessionCookie, setSessionCookie] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [flags, setFlags] = useState<HybridConnectorFlags>({
    dm: true,
    comments: true,
    publish: true,
    comment_auto_reply: true,
    story_replies: true,
  });

  // Post composer
  const [postChannel, setPostChannel] = useState<string>("tiktok");
  const [postText, setPostText] = useState("");
  const [postMedia, setPostMedia] = useState("");

  const populateDraft = useCallback(
    (payload: ConnectorsPayload, tab: TabKey) => {
      if (tab === "publish") return;
      const ch = payload.hybrid?.[tab];
      if (!ch) return;
      setMode(ch.mode || "hybrid");
      setAutoFailover(ch.autoFailover ?? true);
      setAccountName(ch.accountName || "");
      setAppId(ch.appId || "");
      setAppSecret("");
      setAccessToken("");
      setExtraId(ch.pageId || ch.organizationId || "");
      setVerifyToken("");
      setLoginUsername(ch.loginUsername || "");
      setLoginPassword("");
      setSessionCookie("");
      setTwoFactorCode(ch.twoFactorCode || "");
      setFlags({
        dm: ch.flags?.dm ?? true,
        comments: ch.flags?.comments ?? true,
        publish: ch.flags?.publish ?? true,
        comment_auto_reply: ch.flags?.comment_auto_reply ?? true,
        story_replies: ch.flags?.story_replies ?? true,
      });
    },
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as ConnectorsPayload | null;
      if (res.ok && payload && payload.hybrid) {
        setData(payload);
        populateDraft(payload, activeTab);
      }
    } catch {
      setNotice({ ok: false, text: "Could not load connector settings." });
    } finally {
      setLoading(false);
    }
  }, [endpoint, activeTab, populateDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  function selectTab(next: TabKey) {
    setActiveTab(next);
    setNotice(null);
    if (data && next !== "publish") {
      populateDraft(data, next);
    }
  }

  async function saveCurrentChannel() {
    if (activeTab === "publish") return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: activeTab,
          mode,
          enabled: true,
          auto_failover: autoFailover,
          account_name: accountName,
          app_id: appId,
          app_secret: appSecret,
          access_token: accessToken,
          page_id: extraId,
          organization_id: extraId,
          verify_token: verifyToken,
          bearer_token: accessToken,
          consumer_secret: appSecret,
          login_username: loginUsername,
          login_password: loginPassword,
          session_cookie: sessionCookie,
          two_factor_code: twoFactorCode,
          flags,
        }),
      });
      const payload = (await res.json().catch(() => null)) as ConnectorsPayload & {
        error?: { message?: string };
      } | null;
      if (!res.ok || !payload || !payload.hybrid) {
        setNotice({ ok: false, text: payload?.error?.message || "Could not save connector." });
        return;
      }
      setData(payload);
      populateDraft(payload, activeTab);
      const label = PLATFORM_META[activeTab].short;
      setNotice({
        ok: true,
        text: `${label} ${mode.toUpperCase()} connector saved and activated.`,
      });
    } catch {
      setNotice({ ok: false, text: "Network error — could not save connector." });
    } finally {
      setBusy(false);
    }
  }

  async function runAction(
    action: "connect" | "connect_api" | "connect_login" | "test" | "webhook" | "sync" | "disconnect",
    customMsg?: string
  ) {
    if (activeTab === "publish") return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "action",
          channel: activeTab,
          action,
        }),
      });
      const payload = (await res.json().catch(() => null)) as ConnectorsPayload | null;
      if (res.ok && payload && payload.hybrid) {
        setData(payload);
        populateDraft(payload, activeTab);
        setNotice({
          ok: true,
          text:
            customMsg ||
            `${PLATFORM_META[activeTab].short} (${action.replace("_", " ").toUpperCase()}) completed.`,
        });
      } else {
        setNotice({ ok: false, text: "Action could not be completed." });
      }
    } catch {
      setNotice({ ok: false, text: "Network error while running connector action." });
    } finally {
      setBusy(false);
    }
  }

  async function publishPost() {
    if (!postText.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "publish_post",
          channel: postChannel,
          text: postText,
          media_url: postMedia,
        }),
      });
      const payload = (await res.json().catch(() => null)) as ConnectorsPayload | null;
      if (res.ok && payload && payload.hybrid) {
        setData(payload);
        setPostText("");
        setPostMedia("");
        setNotice({ ok: true, text: `Post published to ${postChannel.toUpperCase()}.` });
      }
    } catch {
      setNotice({ ok: false, text: "Could not publish post." });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-xs text-ink-3 shadow-card">
        Loading Hybrid Omnichannel Connectors (Instagram, Facebook, TikTok, LinkedIn, WhatsApp, X, YouTube, Telegram)…
      </div>
    );
  }

  const platforms: ConnectorPlatform[] = [
    "instagram",
    "facebook",
    "tiktok",
    "linkedin",
    "whatsapp",
    "x",
    "youtube",
    "telegram_user",
  ];

  const currentConfig =
    activeTab !== "publish" ? data?.hybrid?.[activeTab] ?? null : null;
  const currentMeta =
    activeTab !== "publish" ? PLATFORM_META[activeTab] : null;

  return (
    <div className="rounded-2xl border border-line bg-white p-5 sm:p-6 shadow-card">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand">
            Hybrid Omnichannel Connectors (API + Login Session){" "}
            {workspaceLabel
              ? `· ${workspaceLabel}`
              : data
                ? `· Workspace #${data.client_id}`
                : ""}
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink">
            Instagram, Facebook, TikTok, LinkedIn, WhatsApp, X, YouTube & Telegram
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            Every channel works via Official Developer API, Direct Account Login/Session Bridge, or Hybrid Auto-Failover (both together).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {platforms.map((p) => {
            const ch = data?.hybrid?.[p];
            const active = Boolean(ch?.connected);
            return (
              <span
                key={p}
                className={
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium " +
                  (active
                    ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
                    : "border-line bg-soft text-ink-3")
                }
              >
                <span
                  className={
                    "h-1.5 w-1.5 rounded-full " +
                    (active ? "bg-emerald-500" : "bg-slate-400")
                  }
                />
                {PLATFORM_META[p].short}
                {active && ch?.mode ? (
                  <span className="text-[9px] uppercase opacity-80">({ch.mode})</span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>

      {/* Channel Tabs */}
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {platforms.map((p) => {
          const ch = data?.hybrid?.[p];
          const isSelected = activeTab === p;
          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => selectTab(p)}
              className={
                "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-colors " +
                (isSelected
                  ? "border-brand/40 bg-brand/[0.09] text-brand"
                  : "border-line bg-soft text-ink-2 hover:text-ink")
              }
            >
              <span>{PLATFORM_META[p].short}</span>
              <span className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] uppercase text-ink-3">
                {ch?.mode || "hybrid"}
              </span>
              {ch?.connected && (
                <span className="h-2 w-2 rounded-full bg-emerald-500" title="Connected" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "publish"}
          onClick={() => selectTab("publish")}
          className={
            "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-colors " +
            (activeTab === "publish"
              ? "border-brand/40 bg-brand/[0.09] text-brand"
              : "border-line bg-soft text-ink-2 hover:text-ink")
          }
        >
          <span>Publish Post</span>
          <span className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] text-ink-3">
            All Channels
          </span>
        </button>
      </div>

      {notice && (
        <div
          role="status"
          className={
            "mt-4 rounded-xl border px-3.5 py-2.5 text-xs font-medium " +
            (notice.ok
              ? "border-emerald-400/30 bg-emerald-400/[0.08] text-ok"
              : "border-red-400/30 bg-red-400/[0.08] text-danger")
          }
        >
          {notice.text}
        </div>
      )}

      {/* Channel Configuration View */}
      {activeTab !== "publish" && currentConfig && currentMeta && (
        <div className="mt-5 space-y-5">
          {/* Status Banner + Hybrid Mode Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-soft/60 px-4 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-ink">{currentMeta.title}</h3>
              <p className="mt-0.5 text-[11px] text-ink-3">{currentMeta.subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  "rounded-lg border px-2.5 py-1 text-[11px] font-medium " +
                  (currentConfig.apiConnected
                    ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
                    : "border-line bg-white text-ink-3")
                }
              >
                API: {currentConfig.apiConnected ? "Connected" : "Standby"}
              </span>
              <span
                className={
                  "rounded-lg border px-2.5 py-1 text-[11px] font-medium " +
                  (currentConfig.loginConnected
                    ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
                    : "border-line bg-white text-ink-3")
                }
              >
                Login Session: {currentConfig.loginConnected ? "Online" : "Standby"}
              </span>
            </div>
          </div>

          {/* 3-Mode Selector: Hybrid / Official API / Account Login */}
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                {
                  id: "hybrid",
                  title: "⚡ Hybrid Mode (API + Login)",
                  desc: "Uses Official API primary + Account Login Session auto-failover.",
                },
                {
                  id: "api",
                  title: "🔌 Official API Mode",
                  desc: "Connects using Developer App ID, Secret, Access Token & Webhooks.",
                },
                {
                  id: "login",
                  title: "🔑 Account Login Mode",
                  desc: "Signs in directly with Username/Email + Password or Session Cookie.",
                },
              ] as const
            ).map((opt) => {
              const selected = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setMode(opt.id)}
                  className={
                    "rounded-xl border p-3.5 text-left transition-all " +
                    (selected
                      ? "border-brand bg-brand/[0.06] shadow-sm"
                      : "border-line bg-soft/40 hover:border-brand/30")
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink">{opt.title}</span>
                    {selected && (
                      <span className="rounded bg-brand px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-ink-3">{opt.desc}</p>
                </button>
              );
            })}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* PANEL A: OFFICIAL API CREDENTIALS (Enabled in Hybrid or API mode) */}
            <div
              className={
                "rounded-xl border p-4 " +
                (mode === "login"
                  ? "border-line/60 bg-soft/30 opacity-60"
                  : "border-line bg-white")
              }
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-brand">
                    1. Official API & Webhook Credentials
                  </h4>
                  <p className="text-[11px] text-ink-3">
                    Developer App / Graph API / OAuth keys
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      "connect_api",
                      `${currentMeta.short} Official API verified and connected.`
                    )
                  }
                  className="rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand hover:bg-brand/15"
                >
                  Verify API
                </button>
              </div>

              <div className="space-y-3">
                <label className="block text-xs text-ink-2">
                  {currentMeta.appIdLabel}
                  <input
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder={currentMeta.appIdPlaceholder}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  {currentMeta.secretLabel}{" "}
                  {currentConfig.appSecretMasked
                    ? `(${currentConfig.appSecretMasked})`
                    : ""}
                  <input
                    type="password"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder={
                      currentConfig.appSecretMasked
                        ? "Leave blank to keep saved secret"
                        : "Enter App / Client Secret"
                    }
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  {currentMeta.tokenLabel}{" "}
                  {currentConfig.accessTokenMasked
                    ? `(${currentConfig.accessTokenMasked})`
                    : ""}
                  <input
                    type="password"
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder={
                      currentConfig.accessTokenMasked
                        ? "Leave blank to keep saved token"
                        : "Paste Access / Bearer Token"
                    }
                    className={INPUT_CLASS}
                  />
                </label>

                {currentMeta.extraIdLabel && (
                  <label className="block text-xs text-ink-2">
                    {currentMeta.extraIdLabel}
                    <input
                      value={extraId}
                      onChange={(e) => setExtraId(e.target.value)}
                      placeholder={currentMeta.extraIdPlaceholder}
                      className={INPUT_CLASS}
                    />
                  </label>
                )}

                <label className="block text-xs text-ink-2">
                  Webhook Verify Token{" "}
                  {currentConfig.verifyTokenMasked
                    ? `(${currentConfig.verifyTokenMasked})`
                    : ""}
                  <input
                    value={verifyToken}
                    onChange={(e) => setVerifyToken(e.target.value)}
                    placeholder="omniflow_verify_token"
                    className={INPUT_CLASS}
                  />
                </label>

                <div className="rounded-lg border border-line bg-soft px-3 py-2 text-[11px] text-ink-3">
                  Webhook Callback URL:{" "}
                  <span className="break-all font-mono text-ink-2">
                    {currentConfig.webhookUrl}
                  </span>
                </div>
              </div>
            </div>

            {/* PANEL B: ACCOUNT LOGIN & SESSION BRIDGE (Enabled in Hybrid or Login mode) */}
            <div
              className={
                "rounded-xl border p-4 " +
                (mode === "api"
                  ? "border-line/60 bg-soft/30 opacity-60"
                  : "border-line bg-white")
              }
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                    2. Direct Account Login / Session Bridge
                  </h4>
                  <p className="text-[11px] text-ink-3">
                    Works without a Developer App — sign in with account or session cookie
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      "connect_login",
                      `${currentMeta.short} Account Login Session paired and online.`
                    )
                  }
                  className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-ok hover:bg-emerald-400/20"
                >
                  Connect Login
                </button>
              </div>

              <div className="space-y-3">
                <label className="block text-xs text-ink-2">
                  Account Display Name / Handle
                  <input
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    placeholder={`e.g. ${currentMeta.loginUserPlaceholder}`}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  {currentMeta.loginUserLabel}
                  <input
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder={currentMeta.loginUserPlaceholder}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  Account Login Password{" "}
                  {currentConfig.loginPasswordMasked
                    ? `(${currentConfig.loginPasswordMasked})`
                    : ""}
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder={
                      currentConfig.loginPasswordMasked
                        ? "Leave blank to keep saved password"
                        : "Enter account password (encrypted at rest)"
                    }
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  {currentMeta.cookieLabel}{" "}
                  {currentConfig.sessionCookieMasked
                    ? `(${currentConfig.sessionCookieMasked})`
                    : ""}
                  <input
                    type="password"
                    value={sessionCookie}
                    onChange={(e) => setSessionCookie(e.target.value)}
                    placeholder={
                      currentConfig.sessionCookieMasked
                        ? "Leave blank to keep saved session token"
                        : currentMeta.cookiePlaceholder
                    }
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block text-xs text-ink-2">
                  2FA / OTP Authenticator Code (if prompted)
                  <input
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value)}
                    placeholder="Optional 6-digit 2FA / OTP code"
                    className={INPUT_CLASS}
                  />
                </label>

                <div className="rounded-lg border border-line bg-soft px-3 py-2 text-[11px] text-ink-3">
                  Bridge Engine:{" "}
                  <span className="font-mono text-ink-2">
                    {currentConfig.bridgeUrl}
                  </span>{" "}
                  · Status:{" "}
                  <span className="font-semibold text-ok">
                    {currentConfig.loginConnected ? "Session Active" : "Ready to Pair"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Feature Switches */}
          <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                { key: "dm", label: "Direct Messages" },
                { key: "comments", label: "Post Comments" },
                { key: "comment_auto_reply", label: "AI Auto-Reply" },
                { key: "story_replies", label: "Story / Status" },
                { key: "publish", label: "Post Publishing" },
              ] as const
            ).map((item) => (
              <label
                key={item.key}
                className="flex items-center gap-2 rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink"
              >
                <input
                  type="checkbox"
                  checked={flags[item.key]}
                  onChange={(e) =>
                    setFlags((prev) => ({ ...prev, [item.key]: e.target.checked }))
                  }
                  className="h-4 w-4 accent-brand"
                />
                <span>{item.label}</span>
              </label>
            ))}

            <label className="flex items-center gap-2 rounded-xl border border-brand/25 bg-brand/[0.05] px-3 py-2 text-xs font-medium text-brand">
              <input
                type="checkbox"
                checked={autoFailover}
                onChange={(e) => setAutoFailover(e.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              <span>Auto-Failover</span>
            </label>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveCurrentChannel()}
              className={BTN_PRIMARY}
            >
              {busy
                ? "Saving…"
                : `Save & Activate ${currentMeta.short} (${mode.toUpperCase()})`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  "connect",
                  `${currentMeta.short} Hybrid Engine (API + Login Session) connected!`
                )
              }
              className={BTN_SECONDARY}
            >
              Test & Connect Both (Hybrid)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction("webhook", `${currentMeta.short} webhook registered.`)
              }
              className={BTN_SECONDARY}
            >
              Register Webhook
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  "sync",
                  `Synced latest DMs & comments from ${currentMeta.short}.`
                )
              }
              className={BTN_SECONDARY}
            >
              Sync Messages Now
            </button>
            {activeTab === "whatsapp" && !adminClientId && (
              <Link href="/dashboard/channels/whatsapp" className={BTN_SECONDARY}>
                Open WhatsApp QR Console →
              </Link>
            )}
            {currentConfig.connected && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("disconnect", `${currentMeta.short} disconnected.`)
                }
                className="rounded-xl border border-red-400/30 bg-red-400/5 px-3.5 py-2 text-xs font-medium text-danger"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}

      {/* Cross-Channel Post Publisher */}
      {activeTab === "publish" && (
        <div className="mt-5 space-y-4">
          <div className="rounded-xl border border-line bg-soft/60 px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">
              Cross-Channel Social Post & Video Publisher
            </h3>
            <p className="text-[11px] text-ink-3">
              Publish posts, reels, or videos across Instagram, Facebook, TikTok, LinkedIn, X, YouTube, or Telegram using your connected Hybrid accounts.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs text-ink-2">
              Target Platform
              <select
                value={postChannel}
                onChange={(e) => setPostChannel(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="tiktok">TikTok Business</option>
                <option value="linkedin">LinkedIn Company Page</option>
                <option value="x">X (Twitter)</option>
                <option value="youtube">YouTube Community / Shorts</option>
                <option value="telegram_user">Telegram Channel</option>
              </select>
            </label>
            <label className="block text-xs text-ink-2 sm:col-span-2">
              Media / Video URL (optional)
              <input
                value={postMedia}
                onChange={(e) => setPostMedia(e.target.value)}
                placeholder="https://cdn.yourdomain.com/post-media.mp4"
                className={INPUT_CLASS}
              />
            </label>
            <label className="block text-xs text-ink-2 sm:col-span-3">
              Post Caption / Copy
              <textarea
                value={postText}
                onChange={(e) => setPostText(e.target.value)}
                placeholder="Write your post caption, announcement, or update…"
                rows={3}
                className={INPUT_CLASS}
              />
            </label>
          </div>

          <button
            type="button"
            disabled={busy || !postText.trim()}
            onClick={() => void publishPost()}
            className={BTN_PRIMARY}
          >
            {busy ? "Publishing…" : "Publish Post Now"}
          </button>

          {(data?.social?.posts?.length ?? 0) > 0 && (
            <div className="mt-4 space-y-2 border-t border-line pt-4">
              <p className="text-xs font-semibold text-ink">Recent Published Posts</p>
              {data?.social.posts.map((post) => (
                <div
                  key={post.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs"
                >
                  <span className="truncate font-medium text-ink">
                    [{post.channel.toUpperCase()}] {post.body}
                  </span>
                  <span className="rounded-md bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-ok">
                    {post.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
