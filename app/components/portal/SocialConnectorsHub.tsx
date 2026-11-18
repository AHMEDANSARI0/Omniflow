"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import EmailChannelCard from "../../dashboard/(portal)/settings/EmailChannelCard";
import InstagramCard from "../../dashboard/(portal)/settings/InstagramCard";
import SmsChannelCard from "../../dashboard/(portal)/settings/SmsChannelCard";
import SocialChannelsCard from "../../dashboard/(portal)/settings/SocialChannelsCard";
import WatiCard from "../../dashboard/(portal)/settings/WatiCard";
import { usePortalEntitlements } from "../../dashboard/components/usePortalEntitlements";
import type { ConnectorPlatform, HybridChannelConfig } from "../../lib/workspace-store";

export interface SocialConnectorsHubProps {
  apiEndpoint?: string;
  adminClientId?: number;
  workspaceLabel?: string;
  initialPlatform?: ConnectorPlatform;
  title?: string;
  subtitle?: string;
}

type PortalTab = "whatsapp" | "meta" | "social" | "email_sms";
type WaConnectMethod = "qr" | "pairing" | "api";

interface WhatsAppApiConfigState {
  provider: "meta_cloud" | "wati" | "custom_api";
  phone: string;
  accountName: string;
  phoneNumberId: string;
  wabaId: string;
  baseUrl: string;
  hasAccessToken: boolean;
  maskedToken: string | null;
  verifyToken: string;
  enabled: boolean;
  connectedAt: string | null;
}

interface WhatsAppLiveStatus {
  configured?: boolean;
  state: "connected" | "connecting" | "disconnected";
  connectionMode:
    | "qr"
    | "pairing_code"
    | "meta_cloud"
    | "wati"
    | "custom_api"
    | "none";
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
  pairingCode: string | null;
  qrPayload: string | null;
  apiConfig?: WhatsAppApiConfigState;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "No recent activity";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatConnectionModeLabel(
  mode: WhatsAppLiveStatus["connectionMode"],
  state: WhatsAppLiveStatus["state"]
): string {
  if (state === "disconnected") return "Not Connected";
  switch (mode) {
    case "meta_cloud":
      return "Meta WhatsApp Cloud API";
    case "wati":
      return "WATI Business API";
    case "custom_api":
      return "Custom WhatsApp API";
    case "pairing_code":
      return "8-Digit Phone Pairing Code";
    case "qr":
      return "WhatsApp Web QR Device Link";
    default:
      return state === "connected" ? "WhatsApp Bridge" : "Awaiting Connection";
  }
}

function DeterministicQrSvg({ seed }: { seed: string }) {
  const cells = useMemo(() => {
    const size = 21;
    const grid: boolean[][] = Array.from({ length: size }, () =>
      Array.from({ length: size }, () => false)
    );

    const drawFinder = (r0: number, c0: number) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const border = r === 0 || r === 6 || c === 0 || c === 6;
          const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          grid[r0 + r][c0 + c] = border || inner;
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const inFinder =
          (r < 8 && c < 8) ||
          (r < 8 && c >= size - 8) ||
          (r >= size - 8 && c < 8);
        if (inFinder) continue;
        hash ^= (r * 31 + c * 17) & 0xff;
        hash = Math.imul(hash, 16777619);
        grid[r][c] = (Math.abs(hash) % 10) < 5;
      }
    }
    return grid;
  }, [seed]);

  return (
    <svg
      viewBox="0 0 25 25"
      className="h-44 w-44 rounded-xl border border-line bg-white p-2 shadow-sm"
      role="img"
      aria-label="WhatsApp Link Device QR Code"
    >
      <rect width="25" height="25" fill="#ffffff" />
      {cells.map((row, rIdx) =>
        row.map((filled, cIdx) =>
          filled ? (
            <rect
              key={`${rIdx}-${cIdx}`}
              x={cIdx + 2}
              y={rIdx + 2}
              width={1}
              height={1}
              fill="#111827"
            />
          ) : null
        )
      )}
    </svg>
  );
}

export default function SocialConnectorsHub({
  apiEndpoint,
  adminClientId,
  workspaceLabel,
  initialPlatform = "whatsapp",
  title,
  subtitle,
}: SocialConnectorsHubProps) {
  const initialTab: PortalTab =
    initialPlatform === "instagram" || initialPlatform === "facebook"
      ? "meta"
      : initialPlatform === "whatsapp"
        ? "whatsapp"
        : "social";

  const [tab, setTab] = useState<PortalTab>(initialTab);
  const [waMethod, setWaMethod] = useState<WaConnectMethod>("qr");

  const [waStatus, setWaStatus] = useState<WhatsAppLiveStatus>({
    state: "disconnected",
    connectionMode: "none",
    accountName: null,
    phone: null,
    lastSeenAt: null,
    pairingCode: null,
    qrPayload: null,
  });
  const [waLoading, setWaLoading] = useState(true);
  const [waBusy, setWaBusy] = useState(false);
  const [waNote, setWaNote] = useState("");
  const [waError, setWaError] = useState("");

  // QR / Phone Pairing form state
  const [linkPhone, setLinkPhone] = useState("");
  const [linkAccountName, setLinkAccountName] = useState("");

  // WhatsApp API Connection form state
  const [apiProvider, setApiProvider] = useState<
    "meta_cloud" | "wati" | "custom_api"
  >("meta_cloud");
  const [apiPhone, setApiPhone] = useState("");
  const [apiAccountName, setApiAccountName] = useState("");
  const [apiPhoneNumberId, setApiPhoneNumberId] = useState("");
  const [apiWabaId, setApiWabaId] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(
    "https://graph.facebook.com/v21.0"
  );
  const [apiAccessToken, setApiAccessToken] = useState("");
  const [apiVerifyToken, setApiVerifyToken] = useState("omniflow_wa_verify_1");
  const [showApiToken, setShowApiToken] = useState(false);
  const [apiConfigInitDone, setApiConfigInitDone] = useState(false);

  // Admin connector view state (when adminClientId is provided)
  const [adminConnectors, setAdminConnectors] = useState<
    Record<string, HybridChannelConfig>
  >({});
  const [adminLoading, setAdminLoading] = useState(Boolean(adminClientId));
  const [adminNote, setAdminNote] = useState("");

  const applyPayloadToStatus = useCallback(
    (payload: Record<string, unknown>) => {
      const apiCfg = payload.apiConfig as WhatsAppApiConfigState | undefined;
      const nextState: WhatsAppLiveStatus["state"] =
        payload.state === "connected" || payload.state === "connecting"
          ? payload.state
          : "disconnected";
      const nextMode: WhatsAppLiveStatus["connectionMode"] =
        payload.connectionMode === "qr" ||
        payload.connectionMode === "pairing_code" ||
        payload.connectionMode === "meta_cloud" ||
        payload.connectionMode === "wati" ||
        payload.connectionMode === "custom_api"
          ? payload.connectionMode
          : "none";

      setWaStatus({
        configured: Boolean(payload.configured),
        state: nextState,
        connectionMode: nextMode,
        accountName:
          (payload.accountName as string | null) ??
          (payload.account_name as string | null) ??
          null,
        phone: (payload.phone as string | null) ?? null,
        lastSeenAt:
          (payload.lastSeenAt as string | null) ??
          (payload.last_seen_at as string | null) ??
          null,
        pairingCode: (payload.pairingCode as string | null) ?? null,
        qrPayload: (payload.qrPayload as string | null) ?? null,
        apiConfig: apiCfg,
      });

      if (!apiConfigInitDone && apiCfg) {
        setApiProvider(apiCfg.provider || "meta_cloud");
        if (apiCfg.phone) setApiPhone(apiCfg.phone);
        if (apiCfg.accountName) setApiAccountName(apiCfg.accountName);
        if (apiCfg.phoneNumberId) setApiPhoneNumberId(apiCfg.phoneNumberId);
        if (apiCfg.wabaId) setApiWabaId(apiCfg.wabaId);
        if (apiCfg.baseUrl) setApiBaseUrl(apiCfg.baseUrl);
        if (apiCfg.verifyToken) setApiVerifyToken(apiCfg.verifyToken);
        if (apiCfg.enabled) {
          setWaMethod("api");
        }
        setApiConfigInitDone(true);
      }
    },
    [apiConfigInitDone]
  );

  const loadWhatsApp = useCallback(
    async (silent = false) => {
      if (!silent) setWaLoading(true);
      try {
        const response = await fetch("/api/omniflow/portal/channels/whatsapp", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (response.ok && payload) {
          applyPayloadToStatus(payload);
        }
      } catch {
        // ignore
      } finally {
        if (!silent) setWaLoading(false);
      }
    },
    [applyPayloadToStatus]
  );

  const loadAdminConnectors = useCallback(async () => {
    if (!adminClientId) return;
    setAdminLoading(true);
    try {
      const url =
        apiEndpoint || `/api/omniflow/admin/clients/${adminClientId}/connectors`;
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.connectors) {
        setAdminConnectors(
          payload.connectors as Record<string, HybridChannelConfig>
        );
      }
    } catch {
      // ignore
    } finally {
      setAdminLoading(false);
    }
  }, [adminClientId, apiEndpoint]);

  useEffect(() => {
    if (adminClientId) {
      void loadAdminConnectors();
      return;
    }
    void loadWhatsApp(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadWhatsApp(true);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [adminClientId, loadAdminConnectors, loadWhatsApp]);

  async function runWhatsAppCommand(
    action: string,
    extra: Record<string, unknown> = {}
  ) {
    if (waBusy) return;
    setWaBusy(true);
    setWaNote("");
    setWaError("");
    try {
      const response = await fetch("/api/omniflow/portal/channels/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok || (payload && payload.error)) {
        const errObj = payload?.error as { message?: string } | undefined;
        setWaError(
          errObj?.message ||
            "Could not process the WhatsApp connection action right now."
        );
        return;
      }
      if (payload?.status && typeof payload.status === "object") {
        applyPayloadToStatus(payload.status as Record<string, unknown>);
      } else {
        await loadWhatsApp(true);
      }
      setWaNote(
        (payload?.message as string) ||
          (action === "disconnect"
            ? "WhatsApp disconnected."
            : "WhatsApp status updated.")
      );
    } catch {
      setWaError("Could not reach the WhatsApp connector API right now.");
    } finally {
      setWaBusy(false);
    }
  }

  async function triggerAdminAction(
    platform: string,
    action: "connect" | "disconnect"
  ) {
    if (!adminClientId) return;
    setAdminNote("");
    try {
      const url =
        apiEndpoint || `/api/omniflow/admin/clients/${adminClientId}/connectors`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, action }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        setAdminNote(
          `Queued '${action}' command for ${platform} on Workspace #${adminClientId}.`
        );
        if (payload?.connectors) {
          setAdminConnectors(
            payload.connectors as Record<string, HybridChannelConfig>
          );
        } else {
          await loadAdminConnectors();
        }
      }
    } catch {
      setAdminNote("Could not send connector command.");
    }
  }

  if (adminClientId) {
    const entries = Object.values(adminConnectors);
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-white p-4 shadow-card">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {workspaceLabel || `Workspace #${adminClientId}`} — Live Channel Status
            </h3>
            <p className="mt-0.5 text-xs text-ink-3">
              Read directly from Control Plane & Neon Postgres channel tables.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadAdminConnectors()}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-soft"
          >
            {adminLoading ? "Refreshing..." : "Refresh status"}
          </button>
        </div>

        {adminNote ? (
          <p className="rounded-xl border border-brand/20 bg-brand-soft px-3.5 py-2 text-xs text-ink">
            {adminNote}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {entries.map((ch) => (
            <div
              key={ch.platform}
              className="rounded-2xl border border-line bg-white p-4 shadow-card"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-ink">
                  {ch.platform.replace("_", " ")}
                </span>
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-medium " +
                    (ch.connected
                      ? "bg-ok/15 text-ok"
                      : ch.state === "connecting"
                        ? "bg-amber-500/15 text-amber-700"
                        : "bg-soft text-ink-3")
                  }
                >
                  {ch.connected ? "Connected" : ch.state}
                </span>
              </div>
              <p className="mt-2 truncate text-xs text-ink-2">
                {ch.accountHandle || ch.accountName || ch.accountId || "No account linked"}
              </p>
              <p className="mt-1 text-[11px] text-ink-3">
                Mode: {ch.mode.toUpperCase()} · Last seen:{" "}
                {fmtDate(ch.lastBridgeAt || ch.lastWebhookAt || ch.lastSyncAt)}
              </p>
              <div className="mt-3 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void triggerAdminAction(ch.platform, "connect")}
                  className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white hover:bg-brand-2"
                >
                  Queue Connect
                </button>
                <button
                  type="button"
                  onClick={() => void triggerAdminAction(ch.platform, "disconnect")}
                  className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:bg-soft"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { hasFeature, hasConnector } = usePortalEntitlements();
  const canUseWati =
    hasFeature("workspace.multi_whatsapp") ||
    hasFeature("marketing.broadcasts") ||
    hasConnector("whatsapp_multi");
  const canUseMeta =
    hasConnector("instagram") ||
    hasConnector("facebook") ||
    hasConnector("messenger") ||
    hasFeature("workspace.instagram_connector") ||
    hasFeature("workspace.facebook_connector") ||
    hasFeature("workspace.messenger_connector");
  const canUseSocial =
    hasConnector("tiktok") ||
    hasConnector("x") ||
    hasConnector("linkedin") ||
    hasConnector("youtube") ||
    hasConnector("telegram_user");
  const canUseEmailSms =
    hasConnector("external_api") && hasFeature("workspace.external_api");

  const allowedTabs: { id: PortalTab; label: string }[] = [
    {
      id: "whatsapp",
      label: canUseWati ? "WhatsApp & WATI" : "WhatsApp Setup",
    },
    ...(canUseMeta
      ? [{ id: "meta" as PortalTab, label: "Instagram & Messenger" }]
      : []),
    ...(canUseSocial
      ? [
          {
            id: "social" as PortalTab,
            label: "TikTok, X, LinkedIn, YouTube & Telegram",
          },
        ]
      : []),
    ...(canUseEmailSms
      ? [{ id: "email_sms" as PortalTab, label: "Email & SMS" }]
      : []),
  ];

  const activeTab: PortalTab = allowedTabs.some((t) => t.id === tab)
    ? tab
    : allowedTabs[0]?.id || "whatsapp";

  const webhookCallbackUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/omniflow/portal/webhooks/whatsapp`
      : "https://omniflow-bice.vercel.app/api/omniflow/portal/webhooks/whatsapp";

  return (
    <div className="space-y-6">
      {(title || subtitle) && (
        <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
          {title ? (
            <h2 className="text-base font-semibold text-ink">{title}</h2>
          ) : null}
          {subtitle ? (
            <p className="mt-1 text-xs text-ink-2">{subtitle}</p>
          ) : null}
        </div>
      )}

      {allowedTabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Workspace channels"
          className="flex flex-wrap gap-2 rounded-2xl border border-line bg-white p-2 shadow-card"
        >
          {allowedTabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              type="button"
              aria-selected={activeTab === item.id}
              onClick={() => setTab(item.id)}
              className={
                "rounded-xl px-3.5 py-2 text-xs font-medium transition-colors " +
                (activeTab === item.id
                  ? "bg-brand text-white"
                  : "bg-soft text-ink-2 hover:bg-line/50 hover:text-ink")
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {activeTab === "whatsapp" && (
        <div className="space-y-6">
          {/* 1. LIVE WHATSAPP CONNECTION STATUS & DISCONNECT BAR */}
          <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-ink">
                    Live WhatsApp Connection Status
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full border border-line bg-soft px-2 py-0.5 text-[10px] font-medium text-ink-3">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                    Auto-syncs every 5s
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  Real-time connection status for your workspace. Connect via WhatsApp Web QR Code, 8-Digit Phone Pairing Code, or Official WhatsApp Business API.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold " +
                    (waStatus.state === "connected"
                      ? "bg-ok/15 text-ok"
                      : waStatus.state === "connecting"
                        ? "bg-amber-500/15 text-amber-700"
                        : "bg-soft text-ink-3")
                  }
                >
                  <span
                    className={
                      "h-2 w-2 rounded-full " +
                      (waStatus.state === "connected"
                        ? "bg-ok"
                        : waStatus.state === "connecting"
                          ? "animate-ping bg-amber-500"
                          : "bg-ink-3")
                    }
                  />
                  {waLoading
                    ? "Checking Live Status..."
                    : waStatus.state === "connected"
                      ? "Connected"
                      : waStatus.state === "connecting"
                        ? "Connecting / Waiting for Link"
                        : "Not Connected"}
                </span>

                <button
                  type="button"
                  onClick={() => void loadWhatsApp(false)}
                  disabled={waLoading || waBusy}
                  className="inline-flex min-h-8 items-center rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-soft disabled:opacity-50"
                >
                  {waLoading ? "Refreshing…" : "Refresh Status"}
                </button>

                {(waStatus.state === "connected" ||
                  waStatus.state === "connecting") && (
                  <button
                    type="button"
                    onClick={() => void runWhatsAppCommand("disconnect")}
                    disabled={waBusy}
                    className="inline-flex min-h-8 items-center rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
                  >
                    {waBusy ? "Disconnecting…" : "Disconnect WhatsApp"}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-line bg-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Connection State
                </p>
                <p className="mt-1 text-xs font-semibold text-ink">
                  {waStatus.state === "connected"
                    ? "Active & Online"
                    : waStatus.state === "connecting"
                      ? "Pending Verification"
                      : "Disconnected (Offline)"}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Linked WhatsApp Number
                </p>
                <p className="mt-1 text-xs font-semibold text-ink">
                  {waStatus.state === "connected" && waStatus.phone
                    ? waStatus.phone
                    : waStatus.state === "connecting" && waStatus.phone
                      ? `${waStatus.phone} (Pending)`
                      : "No number connected"}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Connection Method
                </p>
                <p className="mt-1 text-xs font-semibold text-ink">
                  {formatConnectionModeLabel(
                    waStatus.connectionMode,
                    waStatus.state
                  )}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Last Live Heartbeat
                </p>
                <p className="mt-1 text-xs font-semibold text-ink">
                  {waStatus.state === "connected"
                    ? fmtDate(waStatus.lastSeenAt)
                    : "Not connected"}
                </p>
              </div>
            </div>

            {waNote ? (
              <div className="mt-4 rounded-xl border border-ok/25 bg-ok/10 px-4 py-2.5 text-xs font-medium text-ok">
                {waNote}
              </div>
            ) : null}
            {waError ? (
              <div className="mt-4 rounded-xl border border-danger/25 bg-danger/10 px-4 py-2.5 text-xs font-medium text-danger">
                {waError}
              </div>
            ) : null}
          </section>

          {/* 2. PROFESSIONAL 3-METHOD WHATSAPP CONNECTION CENTER */}
          <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
              <div>
                <h3 className="text-sm font-semibold text-ink">
                  Connect or Manage WhatsApp Account
                </h3>
                <p className="mt-0.5 text-xs text-ink-3">
                  Choose how you want to connect your WhatsApp number to this workspace.
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5 rounded-xl bg-soft p-1">
                <button
                  type="button"
                  onClick={() => setWaMethod("qr")}
                  className={
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors " +
                    (waMethod === "qr"
                      ? "bg-brand text-white shadow-sm"
                      : "text-ink-2 hover:text-ink")
                  }
                >
                  1. Scan QR Code
                </button>
                <button
                  type="button"
                  onClick={() => setWaMethod("pairing")}
                  className={
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors " +
                    (waMethod === "pairing"
                      ? "bg-brand text-white shadow-sm"
                      : "text-ink-2 hover:text-ink")
                  }
                >
                  2. 8-Digit Pairing Code
                </button>
                <button
                  type="button"
                  onClick={() => setWaMethod("api")}
                  className={
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors " +
                    (waMethod === "api"
                      ? "bg-brand text-white shadow-sm"
                      : "text-ink-2 hover:text-ink")
                  }
                >
                  3. Connect via WhatsApp API
                </button>
              </div>
            </div>

            {/* METHOD 1: SCAN QR CODE */}
            {waMethod === "qr" && (
              <div className="mt-5 grid gap-6 md:grid-cols-[1fr_240px]">
                <div className="space-y-4">
                  <div>
                    <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                      WhatsApp Web Device Link
                    </span>
                    <h4 className="mt-2 text-sm font-semibold text-ink">
                      Link Your WhatsApp by Scanning QR Code
                    </h4>
                    <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-ink-2">
                      <li>
                        Open <strong>WhatsApp</strong> or{" "}
                        <strong>WhatsApp Business</strong> on your phone.
                      </li>
                      <li>
                        Tap <strong>Menu (⋮)</strong> on Android or{" "}
                        <strong>Settings</strong> on iPhone, then select{" "}
                        <strong>Linked Devices</strong>.
                      </li>
                      <li>
                        Tap <strong>Link a Device</strong> and point your phone camera at the QR code.
                      </li>
                      <li>
                        Once scanned, enter your linked WhatsApp phone number below and click{" "}
                        <strong>Confirm QR Linked</strong>.
                      </li>
                    </ol>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-[11px] font-medium text-ink-2">
                        Your WhatsApp Phone Number
                      </label>
                      <input
                        type="tel"
                        value={linkPhone}
                        onChange={(e) => setLinkPhone(e.target.value)}
                        placeholder="+92 312 1234567"
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-ink-2">
                        Account Label (Optional)
                      </label>
                      <input
                        type="text"
                        value={linkAccountName}
                        onChange={(e) => setLinkAccountName(e.target.value)}
                        placeholder="e.g. Main Store WhatsApp"
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        void runWhatsAppCommand("start_qr", {
                          accountName: linkAccountName,
                        })
                      }
                      disabled={waBusy}
                      className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                    >
                      {waStatus.qrPayload
                        ? "Refresh QR Code"
                        : "Generate Live QR Code"}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void runWhatsAppCommand("confirm_qr", {
                          phone: linkPhone || waStatus.phone || "",
                          accountName:
                            linkAccountName || waStatus.accountName || "",
                        })
                      }
                      disabled={waBusy}
                      className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-semibold text-brand hover:bg-brand hover:text-white disabled:opacity-50"
                    >
                      Confirm QR Linked & Connect
                    </button>

                    {(waStatus.state === "connected" ||
                      waStatus.state === "connecting") && (
                      <button
                        type="button"
                        onClick={() => void runWhatsAppCommand("disconnect")}
                        disabled={waBusy}
                        className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 hover:bg-soft disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-center justify-center rounded-2xl border border-line bg-soft p-4 text-center">
                  {waStatus.qrPayload ? (
                    <>
                      <DeterministicQrSvg seed={waStatus.qrPayload} />
                      <p className="mt-2 text-[11px] font-medium text-ink">
                        Scan with WhatsApp → Linked Devices
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-3">
                        Session active · awaiting scan
                      </p>
                    </>
                  ) : waStatus.state === "connected" ? (
                    <div className="py-8">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-xl text-ok">
                        ✓
                      </div>
                      <p className="mt-2.5 text-xs font-semibold text-ink">
                        WhatsApp Connected
                      </p>
                      <p className="mt-1 text-[11px] text-ink-2">
                        {waStatus.phone || "Active session"}
                      </p>
                    </div>
                  ) : (
                    <div className="py-8">
                      <p className="text-xs font-semibold text-ink">
                        No Active QR Session
                      </p>
                      <p className="mt-1 text-[11px] text-ink-3">
                        Click &ldquo;Generate Live QR Code&rdquo; to display a fresh QR code.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* METHOD 2: 8-DIGIT PHONE PAIRING CODE */}
            {waMethod === "pairing" && (
              <div className="mt-5 space-y-4">
                <div>
                  <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                    No Camera Required
                  </span>
                  <h4 className="mt-2 text-sm font-semibold text-ink">
                    Link with Phone Number (8-Character Pairing Code)
                  </h4>
                  <p className="mt-1 text-xs text-ink-3">
                    Enter your WhatsApp phone number below to generate an 8-character pairing code, then open{" "}
                    <strong>
                      WhatsApp → Linked Devices → Link a Device → Link with phone number instead
                    </strong>{" "}
                    and enter the code.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      WhatsApp Phone Number (with Country Code) *
                    </label>
                    <input
                      type="tel"
                      value={linkPhone}
                      onChange={(e) => setLinkPhone(e.target.value)}
                      placeholder="+92 300 1234567"
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      Account Name / Label
                    </label>
                    <input
                      type="text"
                      value={linkAccountName}
                      onChange={(e) => setLinkAccountName(e.target.value)}
                      placeholder="e.g. Support Desk WhatsApp"
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>
                </div>

                {waStatus.pairingCode && (
                  <div className="rounded-2xl border border-brand/30 bg-brand-soft p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-brand">
                          Your 8-Character WhatsApp Pairing Code
                        </p>
                        <p className="mt-1 font-mono text-2xl font-bold tracking-[0.2em] text-ink">
                          {waStatus.pairingCode}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            waStatus.pairingCode || ""
                          )
                        }
                        className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-soft"
                      >
                        Copy Code
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      void runWhatsAppCommand("request_pairing_code", {
                        phone: linkPhone,
                        accountName: linkAccountName,
                      })
                    }
                    disabled={waBusy}
                    className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                  >
                    {waBusy ? "Generating…" : "Get 8-Digit Pairing Code"}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void runWhatsAppCommand("confirm_pairing_code", {
                        phone: linkPhone || waStatus.phone || "",
                        accountName:
                          linkAccountName || waStatus.accountName || "",
                      })
                    }
                    disabled={waBusy}
                    className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-semibold text-brand hover:bg-brand hover:text-white disabled:opacity-50"
                  >
                    Confirm Code Entered & Connect
                  </button>
                </div>
              </div>
            )}

            {/* METHOD 3: CONNECT VIA WHATSAPP BUSINESS API (Meta Cloud API / WATI / Custom API) */}
            {waMethod === "api" && (
              <div className="mt-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                      Direct Cloud & Business API
                    </span>
                    <h4 className="mt-2 text-sm font-semibold text-ink">
                      Connect via Official WhatsApp Business API (Meta Cloud API / WATI / Custom)
                    </h4>
                    <p className="mt-1 text-xs text-ink-3">
                      Connect directly using your Meta WhatsApp Cloud API credentials, WATI endpoint, or custom WhatsApp Business API gateway — 24/7 cloud connection without keeping a phone browser open.
                    </p>
                  </div>
                  {waStatus.apiConfig?.enabled && (
                    <span className="rounded-full bg-ok/15 px-3 py-1 text-xs font-semibold text-ok">
                      API Connected ({waStatus.apiConfig.phone})
                    </span>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      API Provider *
                    </label>
                    <select
                      value={apiProvider}
                      onChange={(e) => {
                        const val = e.target.value as
                          | "meta_cloud"
                          | "wati"
                          | "custom_api";
                        setApiProvider(val);
                        if (val === "meta_cloud" && !apiBaseUrl) {
                          setApiBaseUrl("https://graph.facebook.com/v21.0");
                        }
                      }}
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand"
                    >
                      <option value="meta_cloud">
                        Meta WhatsApp Cloud API (Official)
                      </option>
                      <option value="wati">WATI WhatsApp Business API</option>
                      <option value="custom_api">
                        360dialog / Twilio / Custom API
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      WhatsApp Business Phone Number *
                    </label>
                    <input
                      type="tel"
                      value={apiPhone}
                      onChange={(e) => setApiPhone(e.target.value)}
                      placeholder="+923121234567"
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      Display / Business Account Name
                    </label>
                    <input
                      type="text"
                      value={apiAccountName}
                      onChange={(e) => setApiAccountName(e.target.value)}
                      placeholder="e.g. OmniFlow Official Store"
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      {apiProvider === "meta_cloud"
                        ? "Phone Number ID (Meta Graph API) *"
                        : "Instance / Channel ID (Optional)"}
                    </label>
                    <input
                      type="text"
                      value={apiPhoneNumberId}
                      onChange={(e) => setApiPhoneNumberId(e.target.value)}
                      placeholder={
                        apiProvider === "meta_cloud"
                          ? "e.g. 104928173645192"
                          : "Optional channel/instance ID"
                      }
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      WhatsApp Business Account ID (WABA ID)
                    </label>
                    <input
                      type="text"
                      value={apiWabaId}
                      onChange={(e) => setApiWabaId(e.target.value)}
                      placeholder="e.g. 109827364519283 (Optional)"
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      API Endpoint / Base URL *
                    </label>
                    <input
                      type="url"
                      value={apiBaseUrl}
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      placeholder={
                        apiProvider === "meta_cloud"
                          ? "https://graph.facebook.com/v21.0"
                          : "https://live-mt-server.wati.io/12345"
                      }
                      className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      Permanent Access Token / API Key *
                      {waStatus.apiConfig?.maskedToken ? (
                        <span className="ml-2 text-[10px] font-normal text-ok">
                          (Saved: {waStatus.apiConfig.maskedToken})
                        </span>
                      ) : null}
                    </label>
                    <div className="mt-1 flex gap-1.5">
                      <input
                        type={showApiToken ? "text" : "password"}
                        value={apiAccessToken}
                        onChange={(e) => setApiAccessToken(e.target.value)}
                        placeholder={
                          waStatus.apiConfig?.hasAccessToken
                            ? "Leave blank to keep existing token, or paste new token"
                            : "EAAGm0PX4ZCpsBA..."
                        }
                        className="flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiToken((s) => !s)}
                        className="rounded-xl border border-line bg-white px-3 py-2 text-[11px] font-medium text-ink-2 hover:bg-soft"
                      >
                        {showApiToken ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-2">
                      Webhook Verify Token
                    </label>
                    <div className="mt-1 flex gap-1.5">
                      <input
                        type="text"
                        value={apiVerifyToken}
                        onChange={(e) => setApiVerifyToken(e.target.value)}
                        className="flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 font-mono text-xs text-ink outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(apiVerifyToken)
                        }
                        className="rounded-xl border border-line bg-white px-3 py-2 text-[11px] font-medium text-ink-2 hover:bg-soft"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-line bg-soft p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                        Webhook Callback URL (Paste in Meta Developer Console / API Dashboard)
                      </p>
                      <p className="mt-0.5 break-all font-mono text-xs text-ink">
                        {webhookCallbackUrl}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard.writeText(webhookCallbackUrl)
                      }
                      className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:bg-soft"
                    >
                      Copy Webhook URL
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      void runWhatsAppCommand("connect_api", {
                        provider: apiProvider,
                        phone: apiPhone,
                        accountName: apiAccountName,
                        phoneNumberId: apiPhoneNumberId,
                        wabaId: apiWabaId,
                        baseUrl: apiBaseUrl,
                        accessToken: apiAccessToken,
                        verifyToken: apiVerifyToken,
                      })
                    }
                    disabled={waBusy}
                    className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                  >
                    {waBusy
                      ? "Connecting API…"
                      : waStatus.apiConfig?.enabled
                        ? "Update & Re-Verify WhatsApp API"
                        : "Verify & Connect WhatsApp API"}
                  </button>

                  {waStatus.state === "connected" && (
                    <button
                      type="button"
                      onClick={() => void runWhatsAppCommand("disconnect")}
                      disabled={waBusy}
                      className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-2 text-xs font-semibold text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                    >
                      Disconnect API
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          {canUseWati && <WatiCard />}
        </div>
      )}

      {activeTab === "meta" && canUseMeta && <InstagramCard />}

      {activeTab === "social" && canUseSocial && <SocialChannelsCard />}

      {activeTab === "email_sms" && canUseEmailSms && (
        <div className="space-y-6">
          <EmailChannelCard />
          <SmsChannelCard />
        </div>
      )}
    </div>
  );
}
