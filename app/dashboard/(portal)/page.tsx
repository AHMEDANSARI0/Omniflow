import Link from "next/link";
import { Suspense } from "react";

import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../lib/omniflow/entitlements";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";
import SetupChecklist from "../components/SetupChecklist";
import RecoveryCard from "../components/RecoveryCard";
import OperationsCard from "../components/OperationsCard";
import PortalIcon from "../components/PortalIcon";
import { filterNavGroupsByEntitlements } from "../components/portalNav";
import DailyBrief from "./DailyBrief";
import LivePortalStats from "./analytics/LivePortalStats";
import {
  CardSkeleton,
  CsatCard,
  FulfilmentCard,
  HotLeadsCard,
  KpiStrip,
  MarketingCard,
  PlanCard,
  RevenueCard,
  SalesCard,
  TrafficCard,
} from "./DashboardWidgets";

export default async function ClientDashboardPage() {
  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const token = accessToken ?? "";
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );

  const enabledFeatures = Object.values(entitlements.features)
    .filter((f) => f.enabled)
    .map((f) => f.featureKey);
  const visibleGroups = filterNavGroupsByEntitlements(enabledFeatures);

  const hasSales = Boolean(entitlements.features["sales.sales_desk"]?.enabled);
  const hasMarketing = Boolean(entitlements.features["marketing.broadcasts"]?.enabled);
  const hasAnalytics = Boolean(
    entitlements.features["insights.advanced_analytics"]?.enabled ||
      entitlements.features["insights.business_insights"]?.enabled
  );
  const hasCourier = Boolean(
    entitlements.features["sales.courier"]?.enabled ||
      entitlements.features["sales.cod"]?.enabled
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-brand">
            Workspace {principal.clientId} · {entitlements.planName}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Dashboard & Business Analytics
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Welcome{principal.displayName ? `, ${principal.displayName}` : ""} —
            real-time WhatsApp automation performance, customer conversations, and resolution analytics.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/channels/whatsapp"
            className="inline-flex min-h-9 items-center rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 shadow-2xs hover:bg-soft hover:text-ink"
          >
            WhatsApp Setup
          </Link>
          <Link
            href="/dashboard/conversations"
            className="inline-flex min-h-9 items-center rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-brand-2"
          >
            Open Inbox
          </Link>
        </div>
      </div>

      <SetupChecklist />

      {/* Complete Business & Automation Analytics (KPIs + 7-Day Chart + Resolution Split + Quotas) */}
      <LivePortalStats />

      {token && hasAnalytics && (
        <>
          <Suspense
            fallback={
              <div className="mb-6 h-24 animate-pulse rounded-2xl bg-white shadow-card" />
            }
          >
            <KpiStrip token={token} />
          </Suspense>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Suspense fallback={<CardSkeleton tall className="lg:col-span-2" />}>
              <TrafficCard token={token} />
            </Suspense>
            {hasSales && (
              <Suspense fallback={<CardSkeleton tall />}>
                <RevenueCard token={token} />
              </Suspense>
            )}
          </div>
        </>
      )}

      {hasAnalytics && <DailyBrief />}

      {token && (hasSales || hasMarketing || hasCourier || hasAnalytics) && (
        <div className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {hasSales && (
            <Suspense fallback={<CardSkeleton />}>
              <SalesCard token={token} />
            </Suspense>
          )}
          {hasMarketing && (
            <Suspense fallback={<CardSkeleton />}>
              <MarketingCard token={token} />
            </Suspense>
          )}
          {hasCourier && (
            <Suspense fallback={<CardSkeleton />}>
              <FulfilmentCard token={token} />
            </Suspense>
          )}
          {hasAnalytics && (
            <>
              <Suspense fallback={<CardSkeleton />}>
                <CsatCard token={token} />
              </Suspense>
              <Suspense fallback={<CardSkeleton />}>
                <PlanCard token={token} />
              </Suspense>
            </>
          )}
        </div>
      )}

      {hasAnalytics && <OperationsCard />}
      {hasSales && <RecoveryCard />}

      {token && hasSales && (
        <div className="mb-8 grid gap-4 lg:grid-cols-2">
          <Suspense fallback={<CardSkeleton />}>
            <HotLeadsCard token={token} />
          </Suspense>
        </div>
      )}

      <section aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title" className="mb-3 text-sm font-semibold text-ink">
          Enabled in your workspace
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {visibleGroups.map((group) => (
            <div
              key={group.id}
              className="rounded-2xl border border-line bg-white p-4 shadow-card"
            >
              <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2">
                <PortalIcon name={group.icon} className="h-3.5 w-3.5 text-brand" />
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition-colors duration-200 hover:bg-brand-soft hover:text-ink"
                    >
                      <PortalIcon name={item.icon} className="h-4 w-4 text-ink-3" />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
