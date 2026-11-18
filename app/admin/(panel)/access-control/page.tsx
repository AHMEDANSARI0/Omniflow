"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  AccessAuditEntry,
  ActionPermission,
  ConnectorCatalogItem,
  ConnectorId,
  FeatureCategory,
  FeatureDefinition,
  FeatureKey,
  PlanTemplate,
  QuotaMetricKey,
  ResolvedTenantEntitlements,
  RoleDefinition,
} from "../../../../lib/omniflow/entitlements";

type AdminSectionTab =
  | "overview"
  | "features"
  | "connectors"
  | "quotas"
  | "plans"
  | "roles"
  | "audit";

interface ClientWithEntitlements {
  id: number;
  client_id: number;
  workspace_name: string;
  email: string;
  display_name: string;
  status: string;
  entitlements: ResolvedTenantEntitlements;
}

interface AccessControlPayload {
  overview: {
    totalClients: number;
    activeClients: number;
    suspendedClients: number;
    basicOnlyClients: number;
    advancedClients: number;
    connectorUsage: Record<string, number>;
    totalAiMessagesUsed: number;
    totalAutomationsUsed: number;
  };
  clients: ClientWithEntitlements[];
  catalog: {
    features: FeatureDefinition[];
    connectors: ConnectorCatalogItem[];
    quotas: {
      metric: QuotaMetricKey;
      label: string;
      resetPeriod: string;
      basicDefault: number | null;
    }[];
    permissions: ActionPermission[];
  };
  plans: Record<string, PlanTemplate>;
  roles: Record<string, RoleDefinition>;
  auditLogs: AccessAuditEntry[];
}

const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  basic_whatsapp: "Default Basic WhatsApp Automation",
  sales: "Sales & Commercial CRM",
  marketing: "Marketing & Campaigns",
  automation: "Advanced Automation & Workflows",
  content: "Content, Knowledge Base & Media",
  insights: "Business Insights & Analytics",
  ai: "Advanced AI & Sandbox",
  workspace: "Workspace, Connectors, API & Team",
};

export default function AdminAccessControlPage() {
  const [data, setData] = useState<AccessControlPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<AdminSectionTab>("features");
  const [selectedClientId, setSelectedClientId] = useState<number>(0);
  const [changeReason, setChangeReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New Custom Plan form state
  const [newPlanId, setNewPlanId] = useState("");
  const [newPlanName, setNewPlanName] = useState("");
  const [newPlanDesc, setNewPlanDesc] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/omniflow/admin/access-control", {
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => null)) as AccessControlPayload | null;
      if (!res.ok || !payload) {
        setError("Could not load Platform Access Control state.");
        return;
      }
      setData(payload);
      if (!selectedClientId && payload.clients.length > 0) {
        setSelectedClientId(payload.clients[0].client_id);
      }
    } catch {
      setError("Network error while loading Access Control.");
    } finally {
      setLoading(false);
    }
  }, [selectedClientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedClient =
    data?.clients.find((c) => c.client_id === selectedClientId) ??
    data?.clients[0] ??
    null;

  async function mutate(body: Record<string, unknown>, successMsg: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/omniflow/admin/access-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          reason:
            changeReason.trim() ||
            (typeof body.reason === "string" ? body.reason : "Platform Admin update"),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error?.message || "Update failed.");
        return;
      }
      setNotice(successMsg);
      await load();
    } catch {
      setError("Network error during update.");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-6xl py-12 text-center">
        <p className="text-sm text-ink-3">Loading Centralized Access Control Engine...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl py-12 text-center">
        <p className="text-sm text-danger">{error || "Unavailable"}</p>
      </div>
    );
  }

  const ent = selectedClient?.entitlements;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-line bg-white p-6 shadow-card">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-brand">
            Platform Admin · Centralized Entitlements
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            Hybrid WhatsApp & Access Control Center
          </h1>
          <p className="mt-1 text-xs text-ink-2">
            Every new client receives Basic WhatsApp Automation by default. Grant or revoke any advanced module, sub-feature, connector, RBAC permission, or usage quota per client.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/customers"
            className="rounded-xl border border-line bg-soft px-3.5 py-2 text-xs font-medium text-ink-2 hover:bg-line/50 hover:text-ink"
          >
            Workspaces & Clients →
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Section 11.A: Platform Overview Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Total Clients</p>
          <p className="mt-1 text-xl font-semibold text-ink">{data.overview.totalClients}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Active / Suspended</p>
          <p className="mt-1 text-xl font-semibold text-ok">
            {data.overview.activeClients}{" "}
            <span className="text-xs font-normal text-ink-3">
              / {data.overview.suspendedClients}
            </span>
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Basic WhatsApp Only</p>
          <p className="mt-1 text-xl font-semibold text-ink">{data.overview.basicOnlyClients}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Advanced Unlocked</p>
          <p className="mt-1 text-xl font-semibold text-brand">{data.overview.advancedClients}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">AI Messages Used</p>
          <p className="mt-1 text-xl font-semibold text-ink">{data.overview.totalAiMessagesUsed}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Automations Run</p>
          <p className="mt-1 text-xl font-semibold text-ink">{data.overview.totalAutomationsUsed}</p>
        </div>
      </div>

      {/* Section 11.B: Client Selector + Plan & Status Controls */}
      <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="grid gap-4 lg:grid-cols-4">
          <label className="block text-xs font-medium text-ink-2">
            Target Client Workspace
            <select
              value={selectedClient?.client_id ?? 0}
              onChange={(e) => setSelectedClientId(Number(e.target.value))}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-ink"
            >
              {data.clients.map((c) => (
                <option key={c.client_id} value={c.client_id}>
                  #{c.client_id} — {c.workspace_name} ({c.email}) [{c.entitlements.planName}]
                </option>
              ))}
            </select>
          </label>

          {ent && (
            <>
              <label className="block text-xs font-medium text-ink-2">
                Assigned Plan Template
                <select
                  value={ent.planId}
                  disabled={busy}
                  onChange={(e) =>
                    void mutate(
                      {
                        action: "set_plan_or_status",
                        clientId: ent.clientId,
                        planId: e.target.value,
                      },
                      `Assigned plan '${e.target.value}' to Workspace #${ent.clientId}.`
                    )
                  }
                  className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
                >
                  {Object.values(data.plans).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-medium text-ink-2">
                Workspace Status
                <select
                  value={ent.workspaceStatus}
                  disabled={busy}
                  onChange={(e) =>
                    void mutate(
                      {
                        action: "set_plan_or_status",
                        clientId: ent.clientId,
                        workspaceStatus: e.target.value,
                      },
                      `Workspace #${ent.clientId} status changed to ${e.target.value}.`
                    )
                  }
                  className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
                >
                  <option value="Active">Active</option>
                  <option value="Suspended">Suspended (Blocks All Access)</option>
                  <option value="Locked">Locked</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-ink-2">
                Audit Reason (Recorded in Audit Log)
                <input
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                  placeholder="e.g. Approved Instagram + Sales CRM upgrade"
                  className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
                />
              </label>
            </>
          )}
        </div>

        {notice ? (
          <p className="mt-3 rounded-xl border border-ok/20 bg-ok-soft px-3.5 py-2 text-xs text-ok">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-xl border border-danger/20 bg-danger-soft px-3.5 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      {/* Section Tabs */}
      <div className="flex flex-wrap gap-2 rounded-2xl border border-line bg-white p-2 shadow-card">
        {(
          [
            { id: "features", label: "C. Feature Access Manager" },
            { id: "connectors", label: "D. Connector Manager" },
            { id: "quotas", label: "E. Usage & Quota Manager" },
            { id: "plans", label: "F. Plans & Templates" },
            { id: "roles", label: "G. Roles & Permissions" },
            { id: "audit", label: "H. Access Audit Logs" },
          ] as { id: AdminSectionTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "rounded-xl px-3.5 py-2 text-xs font-medium transition-colors " +
              (tab === t.id
                ? "bg-brand text-white"
                : "bg-soft text-ink-2 hover:bg-line/50 hover:text-ink")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* C. FEATURE ACCESS MANAGER */}
      {tab === "features" && ent && (
        <div className="space-y-6">
          {(Object.keys(CATEGORY_LABELS) as FeatureCategory[]).map((cat) => {
            const catFeatures = data.catalog.features.filter(
              (f) => f.category === cat
            );
            return (
              <section
                key={cat}
                className="rounded-2xl border border-line bg-white p-5 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">
                      {CATEGORY_LABELS[cat]}
                    </h2>
                    <p className="text-xs text-ink-3">
                      {cat === "basic_whatsapp"
                        ? "Default basic WhatsApp automation modules enabled for every new client."
                        : "Disabled by default — explicitly unlock per client."}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Enable all ${catFeatures.length} features in '${CATEGORY_LABELS[cat]}' for Workspace #${ent.clientId}?`
                          )
                        ) {
                          void mutate(
                            {
                              action: "bulk_features",
                              clientId: ent.clientId,
                              featureKeys: catFeatures.map((f) => f.key),
                              enabled: true,
                            },
                            `Enabled all ${CATEGORY_LABELS[cat]} features for Workspace #${ent.clientId}.`
                          );
                        }
                      }}
                      className="rounded-lg border border-line bg-soft px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:bg-brand-soft hover:text-brand"
                    >
                      Enable Category
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Disable all ${catFeatures.length} features in '${CATEGORY_LABELS[cat]}' for Workspace #${ent.clientId}?`
                          )
                        ) {
                          void mutate(
                            {
                              action: "bulk_features",
                              clientId: ent.clientId,
                              featureKeys: catFeatures.map((f) => f.key),
                              enabled: false,
                            },
                            `Disabled all ${CATEGORY_LABELS[cat]} features for Workspace #${ent.clientId}.`
                          );
                        }
                      }}
                      className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-3 hover:bg-danger-soft hover:text-danger"
                    >
                      Disable Category
                    </button>
                  </div>
                </div>

                <div className="mt-4 divide-y divide-line">
                  {catFeatures.map((def) => {
                    const grant = ent.features[def.key];
                    const isEnabled = Boolean(grant?.enabled);
                    return (
                      <div
                        key={def.key}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-60 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-ink">
                              {def.label}
                            </span>
                            <code className="rounded bg-soft px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
                              {def.key}
                            </code>
                            <span className="rounded-full bg-soft px-2 py-0.5 text-[10px] text-ink-3">
                              {grant?.source.replace("_", " ")}
                            </span>
                            {grant?.expiresAt ? (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-800">
                                Expires: {new Date(grant.expiresAt).toLocaleDateString()}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-xs text-ink-3">
                            {def.description}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                {
                                  action: "set_feature",
                                  clientId: ent.clientId,
                                  featureKey: def.key,
                                  enabled: !isEnabled,
                                },
                                `${!isEnabled ? "Enabled" : "Disabled"} '${def.label}' for Workspace #${ent.clientId}.`
                              )
                            }
                            className={
                              "min-w-24 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors " +
                              (isEnabled
                                ? "bg-ok text-white hover:bg-ok/90"
                                : "border border-line bg-soft text-ink-3 hover:bg-line/60 hover:text-ink")
                            }
                          >
                            {isEnabled ? "ON (Enabled)" : "OFF (Locked)"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* D. CONNECTOR MANAGER */}
      {tab === "connectors" && ent && (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">
            Independent Connector Entitlements
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Granting a connector (e.g. Instagram) allows the client to link that channel without automatically unlocking advanced marketing or workflow modules.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.catalog.connectors.map((conn) => {
              const grant = ent.connectors[conn.id];
              const isEnabled = Boolean(grant?.enabled);
              return (
                <div
                  key={conn.id}
                  className="rounded-2xl border border-line bg-soft/50 p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink">
                      {conn.label}
                    </span>
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold " +
                        (isEnabled
                          ? "bg-ok/15 text-ok"
                          : "bg-line/50 text-ink-3")
                      }
                    >
                      {isEnabled ? "Authorized" : "Revoked"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-3">{conn.description}</p>
                  <p className="mt-2 text-[11px] text-ink-2">
                    Max accounts: <strong>{grant?.maxAccounts ?? 1}</strong> · Rate limit:{" "}
                    <strong>{grant?.rateLimitPerMinute ?? 60}/min</strong>
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          {
                            action: "set_connector",
                            clientId: ent.clientId,
                            connectorId: conn.id,
                            enabled: !isEnabled,
                            maxAccounts: grant?.maxAccounts ?? conn.defaultMaxAccounts,
                          },
                          `${!isEnabled ? "Granted" : "Revoked"} connector '${conn.label}' for Workspace #${ent.clientId}.`
                        )
                      }
                      className={
                        "rounded-xl px-3 py-1.5 text-xs font-semibold " +
                        (isEnabled
                          ? "border border-danger/30 bg-white text-danger hover:bg-danger-soft"
                          : "bg-brand text-white hover:bg-brand-2")
                      }
                    >
                      {isEnabled ? "Revoke Access" : "Grant Connector"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* E. USAGE & QUOTA MANAGER */}
      {tab === "quotas" && ent && (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">
            Usage Limits & Quota Enforcement
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Configure Hard, Soft, or Unlimited quotas per metric and reset current counters.
          </p>

          <div className="mt-4 divide-y divide-line">
            {data.catalog.quotas.map((qMeta) => {
              const q = ent.quotas[qMeta.metric];
              return (
                <div
                  key={qMeta.metric}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-xs font-semibold text-ink">{qMeta.label}</p>
                    <p className="text-[11px] text-ink-3">
                      Used: <strong>{q?.usedValue ?? 0}</strong> /{" "}
                      <strong>
                        {q?.enforcement === "unlimited" || q?.limitValue === null
                          ? "Unlimited"
                          : q.limitValue}
                      </strong>{" "}
                      ({q?.enforcement.toUpperCase()})
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const raw = window.prompt(
                          `Set new limit for ${qMeta.label} (leave empty for Unlimited):`,
                          q?.limitValue === null ? "" : String(q?.limitValue ?? 1000)
                        );
                        if (raw === null) return;
                        const isUnlim = raw.trim() === "";
                        void mutate(
                          {
                            action: "set_quota",
                            clientId: ent.clientId,
                            metric: qMeta.metric,
                            limitValue: isUnlim ? null : Number(raw),
                            enforcement: isUnlim ? "unlimited" : "hard",
                          },
                          `Updated quota '${qMeta.label}' for Workspace #${ent.clientId}.`
                        );
                      }}
                      className="rounded-xl border border-line bg-soft px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-brand-soft hover:text-brand"
                    >
                      Set Limit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          {
                            action: "set_quota",
                            clientId: ent.clientId,
                            metric: qMeta.metric,
                            limitValue: q?.limitValue ?? null,
                            enforcement: q?.enforcement ?? "hard",
                            resetUsed: true,
                          },
                          `Reset usage counter for '${qMeta.label}' on Workspace #${ent.clientId}.`
                        )
                      }
                      className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-3 hover:bg-soft hover:text-ink"
                    >
                      Reset Used (0)
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* F. PLANS & TEMPLATES */}
      {tab === "plans" && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.values(data.plans).map((plan) => (
              <div
                key={plan.id}
                className="rounded-2xl border border-line bg-white p-5 shadow-card"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">{plan.name}</h3>
                  <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand">
                    {plan.enabledFeatures.length} features
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-3">{plan.description}</p>
                <p className="mt-2 text-[11px] text-ink-2">
                  Connectors: {plan.enabledConnectors.join(", ")}
                </p>
                {ent && (
                  <button
                    type="button"
                    disabled={busy || ent.planId === plan.id}
                    onClick={() =>
                      void mutate(
                        {
                          action: "set_plan_or_status",
                          clientId: ent.clientId,
                          planId: plan.id,
                        },
                        `Assigned template '${plan.name}' to Workspace #${ent.clientId}.`
                      )
                    }
                    className="mt-3 w-full rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                  >
                    {ent.planId === plan.id
                      ? "Currently Assigned"
                      : `Assign to Workspace #${ent.clientId}`}
                  </button>
                )}
              </div>
            ))}
          </div>

          <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">
              Create Reusable Custom Access Template
            </h3>
            <p className="mt-0.5 text-xs text-ink-3">
              Clone the current client&apos;s enabled features and connectors into a reusable plan template.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <input
                value={newPlanId}
                onChange={(e) => setNewPlanId(e.target.value)}
                placeholder="Template ID (e.g. retail_plus)"
                className="rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
              />
              <input
                value={newPlanName}
                onChange={(e) => setNewPlanName(e.target.value)}
                placeholder="Display Name (e.g. Retail Plus)"
                className="rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
              />
              <input
                value={newPlanDesc}
                onChange={(e) => setNewPlanDesc(e.target.value)}
                placeholder="Short description..."
                className="rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink"
              />
            </div>
            <button
              type="button"
              disabled={busy || !newPlanId.trim() || !newPlanName.trim() || !ent}
              onClick={() => {
                if (!ent) return;
                const enabledFeatures = (
                  Object.keys(ent.features) as FeatureKey[]
                ).filter((k) => ent.features[k]?.enabled);
                const enabledConnectors = (
                  Object.keys(ent.connectors) as ConnectorId[]
                ).filter((k) => ent.connectors[k]?.enabled);
                void mutate(
                  {
                    action: "save_plan_template",
                    plan: {
                      id: newPlanId.trim().toLowerCase().replace(/\s+/g, "_"),
                      name: newPlanName.trim(),
                      description:
                        newPlanDesc.trim() ||
                        "Custom access template created by Platform Admin.",
                      isSystem: false,
                      enabledFeatures,
                      enabledConnectors,
                      quotas: data.plans.basic_whatsapp.quotas,
                    },
                  },
                  `Saved custom plan template '${newPlanName.trim()}'.`
                );
              }}
              className="mt-3 rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
            >
              Save Current Client Access as Template
            </button>
          </section>
        </div>
      )}

      {/* G. ROLES & PERMISSIONS */}
      {tab === "roles" && (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">
            Workspace Roles & Permission Matrix
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Roles determine what a team member can do within the workspace&apos;s enabled entitlements. A role never overrides a disabled workspace entitlement.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.values(data.roles).map((r) => (
              <div
                key={r.id}
                className="rounded-2xl border border-line bg-soft/50 p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">{r.name}</span>
                  <code className="text-[10px] text-ink-3">{r.id}</code>
                </div>
                <p className="mt-1 text-xs text-ink-3">{r.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {r.permissions.map((p) => (
                    <span
                      key={p}
                      className="rounded-md bg-white px-2 py-0.5 text-[10px] font-medium text-brand"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* H. ACCESS AUDIT LOGS */}
      {tab === "audit" && (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">
            Platform Access Audit History
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Immutable log of every entitlement, connector, plan, status, and quota change.
          </p>

          {data.auditLogs.length === 0 ? (
            <p className="mt-4 text-xs text-ink-3">No audit entries recorded yet.</p>
          ) : (
            <div className="mt-4 divide-y divide-line">
              {data.auditLogs.map((log) => (
                <div key={log.id} className="py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-ink">
                      {log.action} ·{" "}
                      <span className="text-brand">{log.targetKey}</span> (Workspace #
                      {log.clientId})
                    </span>
                    <span className="text-[11px] text-ink-3">
                      {new Date(log.createdAt).toLocaleString()} · by {log.adminEmail}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-2">
                    Reason: {log.reason}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
