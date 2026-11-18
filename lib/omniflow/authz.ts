import "server-only";

import {
  getControlPlanePrincipal,
  type OmniFlowPrincipal,
} from "./control-plane";
import {
  checkAndConsumeQuota,
  resolveTenantEntitlements,
  type ActionPermission,
  type ConnectorId,
  type FeatureKey,
  type QuotaMetricKey,
  type ResolvedTenantEntitlements,
} from "./entitlements";
import { requirePortalAccessToken } from "./portal";
import { safeJson } from "./request-security";

export interface AuthorizationCheckOptions {
  feature?: FeatureKey;
  permission?: ActionPermission;
  connector?: ConnectorId;
  quotaMetric?: QuotaMetricKey;
  quotaAmount?: number;
  requestedClientId?: number | null;
}

export type AuthorizationOutcome =
  | {
      ok: true;
      principal: OmniFlowPrincipal;
      accessToken: string;
      entitlements: ResolvedTenantEntitlements;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      response: Response;
    };

function deny(status: number, code: string, message: string): AuthorizationOutcome {
  return {
    ok: false,
    status,
    code,
    message,
    response: safeJson({ error: { code, message } }, status),
  };
}

/**
 * Centralized 8-step Backend Authorization Service (Section 12):
 * 1. Authenticated user
 * 2. Active tenant membership
 * 3. Correct tenant context (blocks cross-tenant IDOR)
 * 4. Active workspace (blocks Suspended/Locked workspaces)
 * 5. Feature entitlement
 * 6. Required action permission (RBAC role x Feature permission)
 * 7. Connector authorization (independent from feature permissions)
 * 8. Usage quota enforcement (hard/soft/unlimited)
 */
export async function authorizePortalOperation(
  options: AuthorizationCheckOptions = {},
  explicitPrincipal?: OmniFlowPrincipal,
  explicitToken?: string
): Promise<AuthorizationOutcome> {
  // 1. Authenticated user
  const accessToken = explicitToken ?? (await requirePortalAccessToken());
  if (!accessToken) {
    return deny(401, "unauthorized", "Authentication required.");
  }

  let principal: OmniFlowPrincipal | null = explicitPrincipal ?? null;
  if (!principal) {
    try {
      principal = await getControlPlanePrincipal(accessToken);
    } catch {
      return deny(401, "unauthorized", "Session expired or invalid.");
    }
  }

  // 2. Active tenant membership
  if (!principal || !principal.clientId || principal.clientId <= 0) {
    return deny(403, "no_tenant_membership", "No active workspace membership found.");
  }

  // 3. Correct tenant context (Prevent Cross-Tenant Data Access / IDOR)
  if (
    options.requestedClientId !== undefined &&
    options.requestedClientId !== null &&
    Number(options.requestedClientId) !== Number(principal.clientId)
  ) {
    return deny(
      403,
      "cross_tenant_forbidden",
      "Cross-tenant access denied: tenant context mismatch."
    );
  }

  // Resolve tenant entitlements using 5-layer priority hierarchy
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );

  // 4. Active workspace check
  if (entitlements.workspaceStatus !== "Active") {
    return deny(
      403,
      "workspace_inactive",
      `Workspace #${principal.clientId} is ${entitlements.workspaceStatus}. Contact Platform Admin.`
    );
  }

  // 5. Feature entitlement check
  if (options.feature) {
    const grant = entitlements.features[options.feature];
    if (!grant || !grant.enabled) {
      return deny(
        403,
        "feature_not_entitled",
        `Feature '${options.feature}' is not enabled for this workspace. Contact Platform Admin to unlock it.`
      );
    }

    // 6. Action permission check (RBAC role + feature grant)
    const requiredPerm: ActionPermission = options.permission || "read";
    if (!grant.permissions.includes(requiredPerm)) {
      return deny(
        403,
        "permission_denied",
        `Your role ('${entitlements.role}') does not have '${requiredPerm}' permission on '${options.feature}'.`
      );
    }
  } else if (options.permission) {
    if (!entitlements.rolePermissions.includes(options.permission)) {
      return deny(
        403,
        "permission_denied",
        `Your role ('${entitlements.role}') does not allow '${options.permission}'.`
      );
    }
  }

  // 7. Connector authorization check
  if (options.connector) {
    const connGrant = entitlements.connectors[options.connector];
    if (!connGrant || !connGrant.enabled) {
      return deny(
        403,
        "connector_not_entitled",
        `Connector '${options.connector}' is not authorized for this workspace. Contact Platform Admin.`
      );
    }
    const requiredPerm: ActionPermission = options.permission || "read";
    if (!connGrant.permissions.includes(requiredPerm)) {
      return deny(
        403,
        "connector_permission_denied",
        `Role '${entitlements.role}' lacks '${requiredPerm}' permission on connector '${options.connector}'.`
      );
    }
  }

  // 8. Usage quota check & atomic consumption
  if (options.quotaMetric) {
    const quotaCheck = await checkAndConsumeQuota(
      principal.clientId,
      options.quotaMetric,
      options.quotaAmount ?? 1,
      {
        feature: options.feature,
        connector: options.connector,
        actor: principal.email,
      }
    );
    if (!quotaCheck.allowed) {
      return deny(
        429,
        "quota_exceeded",
        quotaCheck.reason || `Quota exceeded for '${options.quotaMetric}'.`
      );
    }
  }

  return {
    ok: true,
    principal,
    accessToken,
    entitlements,
  };
}
