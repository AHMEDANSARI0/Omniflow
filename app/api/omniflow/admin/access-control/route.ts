import { createClient } from "../../../../../lib/supabase/server";
import {
  activateAllClientWorkspacesInControlPlane,
  ALL_ACTION_PERMISSIONS,
  bulkSetClientFeatures,
  CONNECTOR_CATALOG,
  FEATURE_CATALOG,
  getAllPlans,
  getAllRoles,
  listAccessAuditLogs,
  QUOTA_METRICS_META,
  resolveTenantEntitlements,
  saveCustomPlanTemplate,
  setClientConnectorEntitlement,
  setClientFeatureOverride,
  setClientPlanAndStatus,
  setClientQuotaConfig,
  setPlatformRestriction,
  type ActionPermission,
  type ConnectorId,
  type FeatureKey,
  type PlanTemplate,
  type QuotaMetricKey,
} from "../../../../../lib/omniflow/entitlements";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";
import { listAllWorkspacesAndUsers } from "../../../../lib/workspace-store";

async function requirePlatformAdmin() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .single();
  if (profile?.role && profile.role !== "admin") return null;
  return data.user;
}

export async function GET(request: Request) {
  const admin = await requirePlatformAdmin();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Platform Admin authentication required." } },
      401
    );
  }

  const url = new URL(request.url);
  const clientIdParam = url.searchParams.get("clientId");

  // Auto-sync and activate all client workspaces in Control Plane + AI Engine
  await activateAllClientWorkspacesInControlPlane(admin.email || "admin@omniflow.ai").catch(() => null);

  const [workspaces, plans, roles, auditLogs] = await Promise.all([
    listAllWorkspacesAndUsers(),
    getAllPlans(),
    getAllRoles(),
    listAccessAuditLogs(clientIdParam ? Number(clientIdParam) : undefined, 100),
  ]);

  const clientsWithEntitlements = await Promise.all(
    workspaces.map(async (ws) => {
      const ent = await resolveTenantEntitlements(ws.client_id, "owner");
      return {
        ...ws,
        entitlements: ent,
      };
    })
  );

  // Platform Overview Stats (Section 11.A)
  const totalClients = clientsWithEntitlements.length;
  const activeClients = clientsWithEntitlements.filter(
    (c) => c.entitlements.workspaceStatus === "Active"
  ).length;
  const suspendedClients = clientsWithEntitlements.filter(
    (c) => c.entitlements.workspaceStatus !== "Active"
  ).length;

  let basicOnlyClients = 0;
  let advancedClients = 0;
  const connectorUsage: Record<string, number> = {};
  let totalAiMessagesUsed = 0;
  let totalAutomationsUsed = 0;

  for (const c of clientsWithEntitlements) {
    const enabledAdvanced = FEATURE_CATALOG.filter(
      (f) => !f.defaultEnabled && c.entitlements.features[f.key]?.enabled
    );
    if (enabledAdvanced.length > 0) {
      advancedClients++;
    } else {
      basicOnlyClients++;
    }

    for (const conn of CONNECTOR_CATALOG) {
      if (c.entitlements.connectors[conn.id]?.enabled) {
        connectorUsage[conn.id] = (connectorUsage[conn.id] || 0) + 1;
      }
    }

    totalAiMessagesUsed +=
      c.entitlements.quotas.monthly_ai_messages?.usedValue || 0;
    totalAutomationsUsed +=
      c.entitlements.quotas.automation_executions?.usedValue || 0;
  }

  return safeJson(
    {
      overview: {
        totalClients,
        activeClients,
        suspendedClients,
        basicOnlyClients,
        advancedClients,
        connectorUsage,
        totalAiMessagesUsed,
        totalAutomationsUsed,
      },
      clients: clientsWithEntitlements,
      catalog: {
        features: FEATURE_CATALOG,
        connectors: CONNECTOR_CATALOG,
        quotas: QUOTA_METRICS_META,
        permissions: ALL_ACTION_PERMISSIONS,
      },
      plans,
      roles,
      auditLogs,
    },
    200
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const admin = await requirePlatformAdmin();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Platform Admin authentication required." } },
      401
    );
  }

  const adminEmail = admin.email || "admin@omniflow.ai";
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "");
  const clientId = Number(body.clientId || 0);
  const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;

  if (action === "set_plan_or_status") {
    if (!clientId) {
      return safeJson({ error: { code: "bad_request", message: "clientId is required." } }, 400);
    }
    const entitlements = await setClientPlanAndStatus({
      clientId,
      planId: typeof body.planId === "string" ? body.planId : undefined,
      workspaceStatus:
        body.workspaceStatus === "Active" ||
        body.workspaceStatus === "Suspended" ||
        body.workspaceStatus === "Locked"
          ? body.workspaceStatus
          : undefined,
      adminEmail,
      reason,
    });
    return safeJson({ ok: true, entitlements }, 200);
  }

  if (action === "set_feature") {
    if (!clientId || typeof body.featureKey !== "string") {
      return safeJson(
        { error: { code: "bad_request", message: "clientId and featureKey are required." } },
        400
      );
    }
    const entitlements = await setClientFeatureOverride({
      clientId,
      featureKey: body.featureKey as FeatureKey,
      enabled: Boolean(body.enabled),
      permissions: Array.isArray(body.permissions)
        ? (body.permissions as ActionPermission[])
        : undefined,
      expiresAt: typeof body.expiresAt === "string" && body.expiresAt ? body.expiresAt : null,
      complimentary: Boolean(body.complimentary),
      adminEmail,
      reason,
    });
    return safeJson({ ok: true, entitlements }, 200);
  }

  if (action === "bulk_features") {
    if (!clientId || !Array.isArray(body.featureKeys)) {
      return safeJson(
        { error: { code: "bad_request", message: "clientId and featureKeys[] are required." } },
        400
      );
    }
    const entitlements = await bulkSetClientFeatures({
      clientId,
      featureKeys: body.featureKeys as FeatureKey[],
      enabled: Boolean(body.enabled),
      adminEmail,
      reason,
    });
    return safeJson({ ok: true, entitlements }, 200);
  }

  if (action === "set_connector") {
    if (!clientId || typeof body.connectorId !== "string") {
      return safeJson(
        { error: { code: "bad_request", message: "clientId and connectorId are required." } },
        400
      );
    }
    const entitlements = await setClientConnectorEntitlement({
      clientId,
      connectorId: body.connectorId as ConnectorId,
      enabled: Boolean(body.enabled),
      maxAccounts: typeof body.maxAccounts === "number" ? body.maxAccounts : undefined,
      rateLimitPerMinute:
        typeof body.rateLimitPerMinute === "number" ? body.rateLimitPerMinute : undefined,
      permissions: Array.isArray(body.permissions)
        ? (body.permissions as ActionPermission[])
        : undefined,
      expiresAt: typeof body.expiresAt === "string" && body.expiresAt ? body.expiresAt : null,
      adminEmail,
      reason,
    });
    return safeJson({ ok: true, entitlements }, 200);
  }

  if (action === "set_quota") {
    if (!clientId || typeof body.metric !== "string") {
      return safeJson(
        { error: { code: "bad_request", message: "clientId and metric are required." } },
        400
      );
    }
    const enforcement =
      body.enforcement === "soft" || body.enforcement === "unlimited"
        ? body.enforcement
        : "hard";
    const limitValue =
      body.limitValue === null || body.limitValue === "" || enforcement === "unlimited"
        ? null
        : Number(body.limitValue);
    const entitlements = await setClientQuotaConfig({
      clientId,
      metric: body.metric as QuotaMetricKey,
      limitValue,
      enforcement,
      warningThresholdPct:
        typeof body.warningThresholdPct === "number" ? body.warningThresholdPct : undefined,
      resetUsed: Boolean(body.resetUsed),
      adminEmail,
      reason,
    });
    return safeJson({ ok: true, entitlements }, 200);
  }

  if (action === "save_plan_template") {
    const plan = body.plan as PlanTemplate | undefined;
    if (!plan || !plan.id || !plan.name) {
      return safeJson(
        { error: { code: "bad_request", message: "Valid plan template is required." } },
        400
      );
    }
    const saved = await saveCustomPlanTemplate(plan, adminEmail);
    return safeJson({ ok: true, plan: saved }, 200);
  }

  if (action === "set_platform_restriction") {
    const targetType = body.targetType === "connector" ? "connector" : "feature";
    const targetKey = String(body.targetKey || "") as FeatureKey | ConnectorId;
    await setPlatformRestriction({
      targetType,
      targetKey,
      disabled: Boolean(body.disabled),
      adminEmail,
      reason,
    });
    return safeJson({ ok: true }, 200);
  }

  if (action === "activate_all_workspaces") {
    const result = await activateAllClientWorkspacesInControlPlane(adminEmail);
    return safeJson({ ok: true, ...result }, 200);
  }

  return safeJson(
    { error: { code: "bad_request", message: `Unknown action '${action}'.` } },
    400
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
