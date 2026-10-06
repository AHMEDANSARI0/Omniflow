import Link from "next/link";
import { Suspense } from "react";

import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";
import SetupChecklist from "../components/SetupChecklist";
import RecoveryCard from "../components/RecoveryCard";
import OperationsCard from "../components/OperationsCard";
import PortalIcon from "../components/PortalIcon";
import { NAV_GROUPS } from "../components/portalNav";
import DailyBrief from "./DailyBrief";
import {
  ActivityCard,
  AiCard,
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

// §246: the global dashboard - live numbers from every part of the workspace.
// Each widget streams in on its own, so a slow service never holds the page.

export default async function ClientDashboardPage() {
  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const token = accessToken ?? "";

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-brand">
          Workspace {principal.clientId}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          Welcome{principal.displayName ? `, ${principal.displayName}` : ""} - live numbers from
          every part of your workspace.
        </p>
      </div>

      <SetupChecklist />

      {token && (
        <>
          <Suspense fallback={<div className="mb-6 h-24 animate-pulse rounded-2xl bg-white shadow-card" />}>
            <KpiStrip token={token} />
          </Suspense>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Suspense fallback={<CardSkeleton tall className="lg:col-span-2" />}>
              <TrafficCard token={token} />
            </Suspense>
            <Suspense fallback={<CardSkeleton tall />}>
              <RevenueCard token={token} />
            </Suspense>
          </div>
        </>
      )}

      <DailyBrief />

      {token && (
        <div className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Suspense fallback={<CardSkeleton />}>
            <SalesCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <AiCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <CsatCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <MarketingCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <FulfilmentCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <PlanCard token={token} />
          </Suspense>
        </div>
      )}

      <OperationsCard />

      <RecoveryCard />

      {token && (
        <div className="mb-8 grid gap-4 lg:grid-cols-2">
          <Suspense fallback={<CardSkeleton />}>
            <HotLeadsCard token={token} />
          </Suspense>
          <Suspense fallback={<CardSkeleton />}>
            <ActivityCard token={token} />
          </Suspense>
        </div>
      )}

      <section aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title" className="mb-3 text-sm font-semibold text-ink">
          Everything in your workspace
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="rounded-2xl border border-line bg-white p-4 shadow-card">
              <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2">
                <PortalIcon name={group.icon} className="h-3.5 w-3.5 text-brand" />
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition-colors duration-200 hover:bg-brand-soft hover:text-ink"
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
