"use client";

import { useCallback, useEffect, useState } from "react";
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
  qrImageData: string | null;
  pairingCode: string | null;
  statusNote: string | null;
  apiConfig?: WhatsAppApiConfigState;
}

const COUNTRY_DIAL_CODES = [
  { label: "Pakistan (+92)", dial: "+92" },
  { label: "United Arab Emirates (+971)", dial: "+971" },
  { label: "Saudi Arabia (+966)", dial: "+966" },
  { label: "United Kingdom (+44)", dial: "+44" },
  { label: "United States / Canada (+1)", dial: "+1" },
  { label: "India (+91)", dial: "+91" },
  { label: "Australia (+61)", dial: "+61" },
  { label: "Germany (+49)", dial: "+49" },
  { label: "Turkey (+90)", dial: "+90" },
  { label: "Malaysia (+60)", dial: "+60" },
  { label: "Custom (+...)", dial: "" },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
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
  if (state === "disconnected") return "Not linked";
  switch (mode) {
    case "meta_cloud":
      return "Meta Cloud API";
    case "wati":
      return "WATI Business API";
    case "custom_api":
      return "Custom Business API";
    case "pairing_code":
      return "Phone Pairing Code";
    case "qr":
      return "WhatsApp Web (QR)";
    default:
      return state === "connected" ? "WhatsApp Web" : "Pending link";
  }
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
    qrImageData: null,
    pairingCode: null,
    statusNote: null,
  });
  const [waLoading, setWaLoading] = useState(true);
  const [waBusy, setWaBusy] = useState(false);
  const [waNote, setWaNote] = useState("");
  const [waError, setWaError] = useState("");

  // Official "Link with phone number" state
  const [countryDial, setCountryDial] = useState("+92");
  const [nationalPhone, setNationalPhone] = useState("");
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
        qrImageData: (payload.qrImageData as string | null) ?? null,
        pairingCode: (payload.pairingCode as string | null) ?? null,
        statusNote: (payload.statusNote as string | null) ?? null,
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
    }, 2500);
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
      if (action === "disconnect") {
        setWaNote("WhatsApp disconnected.");
      } else if (typeof payload?.message === "string") {
        setWaNote(payload.message);
      }
    } catch {
      setWaError("Could not reach the WhatsApp connector API right now.");
    } finally {
      setWaBusy(false);
    }
  }

  function handleRequestOfficialPairingCode() {
    const rawTrimmed = nationalPhone.trim();
    const combined = rawTrimmed.startsWith("+")
      ? rawTrimmed
      : `${countryDial}${rawTrimmed.replace(/^0+/, "")}`;
    void runWhatsAppCommand("request_pairing_code", {
      phone: combined,
      accountName: linkAccountName,
    });
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

  const pairingChars = (waStatus.pairingCode || "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 8)
    .split("");

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
          {/* UNIFIED PROFESSIONAL WHATSAPP CONNECTION CARD */}
          <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
            {/* Top Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-base font-semibold text-ink">
                    WhatsApp Connection
                  </h2>
                  <span
                    className={
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium " +
                      (waStatus.state === "connected"
                        ? "bg-ok/15 text-ok"
                        : waStatus.state === "connecting"
                          ? "bg-amber-500/15 text-amber-700"
                          : "bg-soft text-ink-3")
                    }
                  >
                    <span
                      className={
                        "h-1.5 w-1.5 rounded-full " +
                        (waStatus.state === "connected"
                          ? "bg-ok"
                          : waStatus.state === "connecting"
                            ? "animate-pulse bg-amber-500"
                            : "bg-ink-3")
                      }
                    />
                    {waLoading
                      ? "Checking…"
                      : waStatus.state === "connected"
                        ? "Connected"
                        : waStatus.state === "connecting"
                          ? "Waiting for Link"
                          : "Disconnected"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  Connect your WhatsApp number using QR code, phone number linking code, or official Cloud API.
                </p>
              </div>

              {/* Clean Segmented Mode Switcher */}
              <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-soft p-1">
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
                  QR Code
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
                  Phone Number
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
                  Business API
                </button>
              </div>
            </div>

            {/* Compact Live Status Strip */}
            <div className="grid gap-4 border-b border-line bg-soft/50 px-6 py-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Status
                </p>
                <p className="mt-0.5 text-xs font-semibold text-ink">
                  {waStatus.state === "connected"
                    ? "Active & Online"
                    : waStatus.state === "connecting"
                      ? "Awaiting Device Link"
                      : "Not Connected"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Linked Number
                </p>
                <p className="mt-0.5 text-xs font-semibold text-ink">
                  {waStatus.phone || "Not linked"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Method
                </p>
                <p className="mt-0.5 text-xs font-semibold text-ink">
                  {formatConnectionModeLabel(
                    waStatus.connectionMode,
                    waStatus.state
                  )}
                </p>
              </div>
              <div className="flex items-center justify-start gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={() => void loadWhatsApp(false)}
                  disabled={waLoading || waBusy}
                  className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-medium text-ink-2 hover:bg-soft disabled:opacity-50"
                >
                  {waLoading ? "Refreshing…" : "Refresh"}
                </button>
                {(waStatus.state === "connected" ||
                  waStatus.state === "connecting") && (
                  <button
                    type="button"
                    onClick={() => void runWhatsAppCommand("disconnect")}
                    disabled={waBusy}
                    className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] font-semibold text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
                  >
                    {waBusy ? "Disconnecting…" : "Disconnect"}
                  </button>
                )}
              </div>
            </div>

            {/* Feedback Banner (only when user triggers an action or error) */}
            {(waNote || waError) && (
              <div className="border-b border-line px-6 py-2.5">
                {waError ? (
                  <p className="text-xs font-medium text-danger">{waError}</p>
                ) : (
                  <p className="text-xs font-medium text-ink-2">{waNote}</p>
                )}
              </div>
            )}

            {/* Main Body */}
            <div className="p-6">
              {/* TAB 1: QR CODE */}
              {waMethod === "qr" && (
                <div className="grid items-center gap-8 md:grid-cols-[1fr_240px]">
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">
                        Link WhatsApp by Scanning QR Code
                      </h3>
                      <p className="mt-1 text-xs text-ink-3">
                        Scan the official WhatsApp Web QR code with your phone to link your account directly to this workspace.
                      </p>
                    </div>

                    <div className="space-y-2.5">
                      <div className="flex items-start gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
                          1
                        </span>
                        <p className="text-xs text-ink-2">
                          Open <strong>WhatsApp</strong> or{" "}
                          <strong>WhatsApp Business</strong> on your phone.
                        </p>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
                          2
                        </span>
                        <p className="text-xs text-ink-2">
                          Tap <strong>Menu (⋮)</strong> or{" "}
                          <strong>Settings</strong>, then select{" "}
                          <strong>Linked Devices → Link a Device</strong>.
                        </p>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
                          3
                        </span>
                        <p className="text-xs text-ink-2">
                          Point your phone camera at the QR code on the right. Your status will update to <strong>Connected</strong> automatically.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() =>
                          void runWhatsAppCommand("start_qr", {
                            accountName: linkAccountName,
                          })
                        }
                        disabled={waBusy}
                        className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-2 disabled:opacity-50"
                      >
                        {waBusy
                          ? "Generating QR…"
                          : waStatus.qrImageData
                            ? "Refresh QR Code"
                            : "Generate QR Code"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setWaMethod("pairing")}
                        className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-soft hover:text-ink"
                      >
                        Link with phone number instead →
                      </button>
                    </div>
                  </div>

                  {/* QR Code Frame */}
                  <div className="flex h-60 flex-col items-center justify-center rounded-2xl border border-line bg-soft/60 p-4 text-center">
                    {waStatus.state === "connected" ? (
                      <div className="space-y-2">
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-lg font-bold text-ok">
                          ✓
                        </div>
                        <p className="text-xs font-semibold text-ink">
                          WhatsApp Connected
                        </p>
                        <p className="text-[11px] text-ink-3">
                          {waStatus.phone || "Active session"}
                        </p>
                      </div>
                    ) : waStatus.qrImageData ? (
                      <>
                        <div className="rounded-xl border border-line bg-white p-2 shadow-sm">
                          <img
                            src={waStatus.qrImageData}
                            alt="WhatsApp Web QR Code"
                            className="h-44 w-44 object-contain"
                          />
                        </div>
                        <p className="mt-2 text-[11px] font-medium text-ink-2">
                          Scan with WhatsApp
                        </p>
                      </>
                    ) : waStatus.state === "connecting" &&
                      waStatus.connectionMode === "qr" ? (
                      <div className="space-y-2.5 px-2">
                        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" />
                        <p className="text-xs font-medium text-ink">
                          Generating QR code…
                        </p>
                        <p className="text-[11px] text-ink-3">
                          Wait a moment for the live QR code to appear.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3 px-3">
                        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white text-sm font-semibold text-ink-2 shadow-sm">
                          QR
                        </div>
                        <p className="text-xs font-medium text-ink">
                          No Active QR Session
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void runWhatsAppCommand("start_qr", {
                              accountName: linkAccountName,
                            })
                          }
                          disabled={waBusy}
                          className="rounded-lg bg-brand px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                        >
                          Generate QR Code
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: LINK WITH PHONE NUMBER */}
              {waMethod === "pairing" && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      Link with Phone Number
                    </h3>
                    <p className="mt-1 text-xs text-ink-3">
                      Select your country and enter your WhatsApp phone number to receive an official 8-character linking code.
                    </p>
                  </div>

                  <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
                    <div>
                      <label className="block text-[11px] font-medium text-ink-2">
                        Country
                      </label>
                      <select
                        value={countryDial}
                        onChange={(e) => setCountryDial(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                      >
                        {COUNTRY_DIAL_CODES.map((c) => (
                          <option key={c.label} value={c.dial}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-ink-2">
                        WhatsApp Phone Number *
                      </label>
                      <div className="mt-1 flex items-center rounded-xl border border-line bg-soft px-3 py-2 focus-within:border-brand focus-within:bg-white">
                        {countryDial ? (
                          <span className="mr-2 select-none border-r border-line pr-2 font-mono text-xs font-semibold text-ink-2">
                            {countryDial}
                          </span>
                        ) : null}
                        <input
                          type="tel"
                          value={nationalPhone}
                          onChange={(e) => setNationalPhone(e.target.value)}
                          placeholder={
                            countryDial === "+92"
                              ? "331 3194929"
                              : "+92 331 3194929"
                          }
                          className="w-full bg-transparent text-xs text-ink placeholder:text-ink-3 outline-none"
                        />
                      </div>
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
                      />
                    </div>
                  </div>

                  {/* 8-CHARACTER PAIRING CODE DISPLAY */}
                  {pairingChars.length === 8 ? (
                    <div className="max-w-2xl rounded-2xl border border-brand/25 bg-brand-soft/40 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold text-ink">
                            Enter this 8-character code on your phone ({waStatus.phone})
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-3">
                            Tap the WhatsApp notification on your phone, or open{" "}
                            <strong>
                              WhatsApp → Linked Devices → Link a Device → Link with phone number instead
                            </strong>
                            .
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              waStatus.pairingCode || ""
                            )
                          }
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-soft"
                        >
                          Copy Code
                        </button>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-1.5">
                        {pairingChars.slice(0, 4).map((ch, idx) => (
                          <span
                            key={`p1-${idx}`}
                            className="flex h-11 w-10 items-center justify-center rounded-xl border border-line bg-white font-mono text-lg font-bold text-ink shadow-sm"
                          >
                            {ch}
                          </span>
                        ))}
                        <span className="px-1 font-mono text-lg font-bold text-ink-3">
                          -
                        </span>
                        {pairingChars.slice(4, 8).map((ch, idx) => (
                          <span
                            key={`p2-${idx}`}
                            className="flex h-11 w-10 items-center justify-center rounded-xl border border-line bg-white font-mono text-lg font-bold text-ink shadow-sm"
                          >
                            {ch}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : waStatus.state === "connecting" &&
                    waStatus.connectionMode === "pairing_code" ? (
                    <div className="flex max-w-2xl items-center gap-3 rounded-xl border border-line bg-soft p-3.5">
                      <div className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-line border-t-brand" />
                      <p className="text-xs text-ink-2">
                        Requesting 8-character linking code for{" "}
                        <strong>{waStatus.phone || "your number"}</strong>…
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleRequestOfficialPairingCode}
                      disabled={waBusy || !nationalPhone.trim()}
                      className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-2 disabled:opacity-50"
                    >
                      {waBusy
                        ? "Requesting Code…"
                        : pairingChars.length === 8
                          ? "Get New Code"
                          : "Get 8-Character Code"}
                    </button>

                    <button
                      type="button"
                      onClick={() => setWaMethod("qr")}
                      className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-soft hover:text-ink"
                    >
                      ← Back to QR Code
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 3: BUSINESS API */}
              {waMethod === "api" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">
                        Connect via WhatsApp Business API
                      </h3>
                      <p className="mt-1 text-xs text-ink-3">
                        Connect directly using Meta WhatsApp Cloud API, WATI, or a custom WhatsApp Business API gateway.
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
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
                        placeholder="+923313194929"
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                        className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                          className="flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand focus:bg-white"
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
                          className="flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 font-mono text-xs text-ink outline-none focus:border-brand focus:bg-white"
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
                          Webhook Callback URL
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
                        Copy URL
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
                          ? "Update WhatsApp API"
                          : "Verify & Connect API"}
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
            </div>
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
