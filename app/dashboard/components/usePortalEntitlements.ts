"use client";

import { useCallback, useEffect, useState } from "react";

export interface PortalEntitlementSnapshot {
  clientId: number;
  workspaceStatus: "Active" | "Suspended" | "Locked";
  planId: string;
  planName: string;
  role: string;
  rolePermissions: string[];
  enabledFeatures: string[];
  enabledConnectors: string[];
  allowedInboxChannels: string[];
}

const DEFAULT_BASIC_FEATURES_LIST = [
  "basic.dashboard",
  "basic.whatsapp_connect",
  "basic.inbox",
  "basic.customers",
  "basic.hybrid_ai",
  "basic.business_config",
  "basic.quick_replies",
  "basic.activity_reports",
];

let cachedSnapshot: PortalEntitlementSnapshot | null = null;
let lastFetchTime = 0;

function computeAllowedInboxChannels(
  connectors: Set<string>,
  features: Set<string>
): string[] {
  const out: string[] = [];
  if (connectors.has("whatsapp") || features.has("basic.whatsapp_connect")) {
    out.push("whatsapp");
  }
  if (connectors.has("instagram") && features.has("workspace.instagram_connector")) {
    out.push("instagram");
  }
  if (connectors.has("messenger") && features.has("workspace.messenger_connector")) {
    out.push("messenger");
  }
  if (connectors.has("tiktok")) out.push("tiktok");
  if (connectors.has("x")) out.push("x");
  if (connectors.has("linkedin")) out.push("linkedin");
  if (connectors.has("youtube")) out.push("youtube");
  if (connectors.has("telegram_user")) {
    out.push("telegram");
    out.push("telegram_user");
  }
  if (connectors.has("external_api") && features.has("workspace.external_api")) {
    out.push("email");
    out.push("sms");
  }
  if (features.has("marketing.growth")) {
    out.push("website");
  }
  return out.length > 0 ? out : ["whatsapp"];
}

export function usePortalEntitlements() {
  const [snapshot, setSnapshot] = useState<PortalEntitlementSnapshot>(() => {
    if (cachedSnapshot) return cachedSnapshot;
    return {
      clientId: 0,
      workspaceStatus: "Active",
      planId: "basic_whatsapp",
      planName: "Basic WhatsApp",
      role: "owner",
      rolePermissions: ["read", "create", "update", "delete", "execute"],
      enabledFeatures: DEFAULT_BASIC_FEATURES_LIST,
      enabledConnectors: ["whatsapp"],
      allowedInboxChannels: ["whatsapp"],
    };
  });
  const [loaded, setLoaded] = useState<boolean>(Boolean(cachedSnapshot));

  const refresh = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && cachedSnapshot && now - lastFetchTime < 8_000) {
      setSnapshot(cachedSnapshot);
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch("/api/omniflow/portal/entitlements", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => null);
      const ent = payload?.entitlements;
      if (!ent) return;

      const enabledFeatures = Object.values(
        (ent.features || {}) as Record<string, { featureKey: string; enabled: boolean }>
      )
        .filter((f) => f && f.enabled)
        .map((f) => f.featureKey);

      const enabledConnectors = Object.values(
        (ent.connectors || {}) as Record<string, { connectorId: string; enabled: boolean }>
      )
        .filter((c) => c && c.enabled)
        .map((c) => c.connectorId);

      const fSet = new Set(enabledFeatures);
      const cSet = new Set(enabledConnectors);
      const next: PortalEntitlementSnapshot = {
        clientId: Number(ent.clientId || 0),
        workspaceStatus: ent.workspaceStatus || "Active",
        planId: ent.planId || "basic_whatsapp",
        planName: ent.planName || "Basic WhatsApp",
        role: ent.role || "owner",
        rolePermissions: Array.isArray(ent.rolePermissions)
          ? ent.rolePermissions
          : ["read", "create", "update", "delete", "execute"],
        enabledFeatures,
        enabledConnectors,
        allowedInboxChannels: computeAllowedInboxChannels(cSet, fSet),
      };
      cachedSnapshot = next;
      lastFetchTime = Date.now();
      setSnapshot(next);
      setLoaded(true);
    } catch {
      // keep fallback
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(true), 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const featureSet = new Set(snapshot.enabledFeatures);
  const connectorSet = new Set(snapshot.enabledConnectors);
  const permSet = new Set(snapshot.rolePermissions);

  return {
    loaded,
    snapshot,
    hasFeature: (key: string) => featureSet.has(key),
    hasConnector: (id: string) => connectorSet.has(id),
    hasPermission: (perm: string) => permSet.has(perm),
    allowedInboxChannels: snapshot.allowedInboxChannels,
    refresh,
  };
}
