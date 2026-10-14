import Link from "next/link";
import { cache, type ReactNode } from "react";

import {
  getAiOverview,
  getAnalytics,
  getCsatSummary,
  getLoyaltyOverview,
  getOverview,
  getPlans,
  getRecentActivity,
  getRevenueSummary,
  getSalesOverview,
  listBroadcasts,
  listCodRequests,
  listCourierBookings,
  type AnalyticsDayPoint,
  type ServiceResult,
} from "../../../lib/omniflow/portal";
import PortalIcon, { type IconName } from "../components/PortalIcon";

// §246: the global dashboard. Every widget reads an endpoint the portal
// already serves (no new engine), streams in on its own and fails soft: a
// service that is down shows "not available" on its card, never a crash.

async function safe<T>(load: () => Promise<T | null>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

function okData<T>(result: ServiceResult<T> | null): T | null {
  return result && result.kind === "ok" ? result.data : null;
}

// One overview request per page render, shared by the KPI strip and hot leads.
const overviewOnce = cache((token: string) => safe(() => getOverview(token)));

const num = (value: number) => value.toLocaleString("en-US");
const rs = (value: number) => "Rs " + Math.round(value).toLocaleString("en-US");

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-";
  if (seconds < 90) return Math.round(seconds) + "s";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? minutes + "m" : Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? hours + "h ago" : Math.floor(hours / 24) + "d ago";
}

/* ---------- building blocks ---------- */

export function Card({
  title,
  icon,
  href,
  linkLabel = "Open",
  className = "",
  children,
}: {
  title: string;
  icon: IconName;
  href?: string;
  linkLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={"min-w-0 rounded-2xl border border-line bg-white p-5 shadow-card " + className}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <PortalIcon name={icon} className="h-3.5 w-3.5" />
          </span>
          {title}
        </h2>
        {href && (
          <Link href={href} className="-my-2 flex items-center gap-1 rounded-md px-1 py-2 text-xs font-medium text-brand hover:bg-brand-soft/70 hover:underline">
            {linkLabel}
            <PortalIcon name="arrowRight" className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function Unavailable() {
  return <p className="py-6 text-center text-xs text-ink-3">Not available right now.</p>;
}

export function CardSkeleton({ className = "", tall = false }: { className?: string; tall?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={
        "animate-pulse rounded-2xl border border-line bg-white p-5 shadow-card " +
        (tall ? "h-72 " : "h-48 ") +
        className
      }
    >
      <div className="h-4 w-32 rounded bg-soft" />
      <div className="mt-6 h-8 w-24 rounded bg-soft" />
      <div className="mt-3 h-3 w-full rounded bg-soft" />
      <div className="mt-2 h-3 w-2/3 rounded bg-soft" />
    </div>
  );
}

function Metric({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-lg font-semibold text-ink">{value}</p>
      {sub ? <p className={"truncate text-[11px] " + (tone || "text-ink-3")}>{sub}</p> : null}
    </div>
  );
}

function BarList({ rows, tone = "bg-brand" }: { rows: { label: string; value: number; hint?: string }[]; tone?: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-ink-2">{row.label}</span>
            <span className="shrink-0 font-medium text-ink">{row.hint ?? num(row.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-soft">
            <div className={"h-1.5 rounded-full " + tone} style={{ width: (row.value / max) * 100 + "%" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TrendChart({ points }: { points: AnalyticsDayPoint[] }) {
  if (points.length < 2) {
    return <p className="py-10 text-center text-xs text-ink-3">The trend appears after two days of messages.</p>;
  }
  const W = 600;
  const H = 160;
  const max = Math.max(1, ...points.map((p) => Math.max(p.inbound, p.outbound)));
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 8);
  const line = (key: "inbound" | "outbound") =>
    points.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[key]).toFixed(1)).join(" ");
  const inTotal = points.reduce((sum, p) => sum + p.inbound, 0);
  const outTotal = points.reduce((sum, p) => sum + p.outbound, 0);
  const mid = points[Math.floor(points.length / 2)];

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-brand" /> Received {num(inTotal)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-flow" /> Sent {num(outTotal)}
        </span>
        <span className="ml-auto">peak {num(max)}/day</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Messages per day: ${inTotal} received and ${outTotal} sent over ${points.length} days`}
        className="h-40 w-full overflow-visible"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="currentColor" className="text-line" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={line("inbound") + ` L${W} ${H} L0 ${H} Z`} className="fill-brand/10" />
        <path d={line("inbound")} fill="none" stroke="currentColor" strokeWidth="2" className="text-brand" vectorEffect="non-scaling-stroke" />
        <path d={line("outbound")} fill="none" stroke="currentColor" strokeWidth="2" className="text-flow" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-ink-3">
        <span>{points[0].day}</span>
        <span>{mid.day}</span>
        <span>{points[points.length - 1].day}</span>
      </div>
    </div>
  );
}

/* ---------- widgets ---------- */

export async function KpiStrip({ token }: { token: string }) {
  const overview = await overviewOnce(token);
  if (!overview) return null;
  const tiles: { label: string; value: number; sub?: string; icon: IconName; href: string }[] = [
    { label: "New chats · 24h", value: overview.newChats, icon: "conversations", href: "/dashboard/conversations" },
    { label: "Inbound · 24h", value: overview.inboundMessages, icon: "inbox", href: "/dashboard/analytics" },
    { label: "Team replies · 24h", value: overview.teamReplies, icon: "team", href: "/dashboard/team" },
    {
      label: "Open now",
      value: overview.openNow,
      sub: overview.unassignedOpen > 0 ? overview.unassignedOpen + " unassigned" : "all assigned",
      icon: "activity",
      href: "/dashboard/conversations",
    },
    {
      label: "Needs reply",
      value: overview.needsReplyOpen,
      sub: overview.needsReplyOverdue > 0 ? overview.needsReplyOverdue + " overdue" : "customer sent the last message",
      icon: "quickReplies",
      href: "/dashboard/conversations?needs_reply=overdue",
    },
  ];
  return (
    <div className="mb-6 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="min-w-0 rounded-2xl border border-line bg-white px-4 py-3.5 shadow-card transition-colors duration-200 hover:border-brand/25"
          >
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-3">
              <PortalIcon name={tile.icon} className="h-3.5 w-3.5 text-brand" />
              <span className="truncate">{tile.label}</span>
            </p>
            <p className="mt-1 text-2xl font-semibold text-ink">{num(tile.value)}</p>
            {tile.sub ? <p className="mt-0.5 truncate text-[10px] text-ink-3">{tile.sub}</p> : null}
          </Link>
        ))}
      </div>
      {overview.needsReplyOverdue > 0 && (
        <Link
          href="/dashboard/conversations?needs_reply=overdue"
          className="flex items-center justify-between gap-3 rounded-2xl border border-red-400/20 bg-red-400/[0.06] px-5 py-3.5 transition-colors duration-200 hover:bg-red-400/[0.10]"
        >
          <span className="flex items-center gap-2 text-sm text-danger">
            <PortalIcon name="alert" />
            {overview.needsReplyOverdue}{" "}
            {overview.needsReplyOverdue === 1 ? "customer is" : "customers are"} waiting longer than the reply SLA.
          </span>
          <span className="shrink-0 text-xs font-medium text-danger">Review overdue</span>
        </Link>
      )}
      {overview.unassignedOpen > 0 && (
        <Link
          href="/dashboard/conversations"
          className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] px-5 py-3.5 transition-colors duration-200 hover:bg-amber-400/[0.09]"
        >
          <span className="flex items-center gap-2 text-sm text-amber-700">
            <PortalIcon name="customers" />
            {overview.unassignedOpen} open {overview.unassignedOpen === 1 ? "chat has" : "chats have"} no assignee.
          </span>
          <span className="shrink-0 text-xs font-medium text-amber-700">Open inbox</span>
        </Link>
      )}
    </div>
  );
}

export async function TrafficCard({ token }: { token: string }) {
  const data = await safe(() => getAnalytics(token));
  return (
    <Card title="Conversations & messages" icon="analytics" href="/dashboard/analytics" linkLabel="Analytics" className="lg:col-span-2">
      {!data ? (
        <Unavailable />
      ) : (
        <>
          <TrendChart points={data.perDay} />
          <div className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
            <Metric label={`Conversations · ${data.days}d`} value={num(data.window.conversations)} />
            <Metric label="Instant AI answers" value={num(data.window.instantAnswers)} sub={num(data.window.followupsDelivered) + " follow-ups sent"} />
            <Metric
              label="Resolution rate"
              value={data.service.resolutionRate === null ? "-" : data.service.resolutionRate.toFixed(1) + "%"}
              sub={num(data.service.answeredConversations) + " answered"}
            />
            <Metric label="First response" value={duration(data.service.frtMedianSeconds)} sub="median" />
          </div>
        </>
      )}
    </Card>
  );
}

export async function RevenueCard({ token }: { token: string }) {
  const revenue = await safe(() => getRevenueSummary(token, 30));
  return (
    <Card title="Revenue · 30 days" icon="revenue" href="/dashboard/growth" linkLabel="Growth">
      {!revenue ? (
        <Unavailable />
      ) : (
        <>
          <p className="text-3xl font-semibold tracking-tight text-ink">{rs(revenue.revenue)}</p>
          <p className={"mt-1 text-xs " + (revenue.deltaPercent === null ? "text-ink-3" : revenue.deltaPercent >= 0 ? "text-ok" : "text-danger")}>
            {revenue.deltaPercent === null
              ? "No prior period to compare"
              : (revenue.deltaPercent >= 0 ? "+" : "") + revenue.deltaPercent + "% vs previous 30 days"}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <Metric label="Orders" value={num(revenue.orders)} sub={"AOV " + (revenue.aov === null ? "-" : rs(revenue.aov))} />
            <Metric label="Buyers" value={num(revenue.newBuyers + revenue.repeatBuyers)} sub={num(revenue.repeatBuyers) + " repeat"} />
            <Metric
              label="Cancelled"
              value={num(revenue.cancelled)}
              sub={revenue.cancelledRate === null ? undefined : revenue.cancelledRate + "% of decided"}
              tone={revenue.cancelledRate !== null && revenue.cancelledRate > 10 ? "text-danger" : ""}
            />
            <Metric label="Open carts" value={num(revenue.openCarts)} sub={rs(revenue.pipelineValue) + " in pipeline"} />
          </div>
        </>
      )}
    </Card>
  );
}

export async function SalesCard({ token }: { token: string }) {
  const sales = okData(await safe(() => getSalesOverview(token)));
  const heat = (["hot", "warm", "cold"] as const).map((key) => {
    const row = sales?.totals[key] ?? { chats: 0, bought: 0 };
    return {
      label: key[0].toUpperCase() + key.slice(1) + " leads",
      value: row.chats,
      hint: num(row.chats) + " chats · " + (row.chats ? Math.round((row.bought / row.chats) * 100) : 0) + "% bought",
    };
  });
  return (
    <Card title="Sales leads" icon="salesDesk" href="/dashboard/sales" linkLabel="Sales desk">
      {!sales ? (
        <Unavailable />
      ) : (
        <>
          <BarList rows={heat} tone="bg-amber-400" />
          <p className="mt-4 text-[11px] text-ink-3">
            Lead heat from the last {sales.days} days of chats, and how many went on to buy.
          </p>
        </>
      )}
    </Card>
  );
}

export async function AiCard({ token }: { token: string }) {
  const ai = await safe(() => getAiOverview(token, 7));
  // This payload is passed through un-normalised, so read it defensively.
  const categories = Array.isArray(ai?.by_category) ? ai.by_category : [];
  const escalations = ai?.escalations ?? null;
  const usage = ai?.usage?.totals ?? null;
  return (
    <Card title="AI agent · 7 days" icon="ai" href="/dashboard/ai-report" linkLabel="AI report">
      {!ai ? (
        <Unavailable />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metric label="AI actions" value={num(Number(ai.total) || 0)} />
            <Metric
              label="Approvals"
              value={typeof ai.approvals_pending === "number" ? num(ai.approvals_pending) : "-"}
              sub="waiting"
            />
            <Metric
              label="Escalations"
              value={escalations ? num(escalations.open) : "-"}
              sub={escalations && escalations.open_high > 0 ? escalations.open_high + " high" : "open"}
              tone={escalations && escalations.open_high > 0 ? "text-danger" : ""}
            />
          </div>
          {categories.some((c) => c.count > 0) && (
            <div className="mt-4 border-t border-line pt-4">
              <BarList
                rows={[...categories].sort((a, b) => b.count - a.count).slice(0, 4).map((c) => ({ label: c.label, value: c.count }))}
                tone="bg-ai"
              />
            </div>
          )}
          {usage && (
            <p className="mt-4 text-[11px] text-ink-3">
              {num(usage.calls)} model calls
              {usage.failed > 0 ? " · " + num(usage.failed) + " failed" : ""}
              {typeof usage.cost_usd === "number" ? " · $" + usage.cost_usd.toFixed(2) : ""}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export async function CsatCard({ token }: { token: string }) {
  const csat = await safe(() => getCsatSummary(token));
  return (
    <Card title="Customer satisfaction" icon="star" href="/dashboard/analytics" linkLabel="Details">
      {!csat ? (
        <Unavailable />
      ) : (
        <>
          <p className="text-3xl font-semibold tracking-tight text-ink">
            {csat.average === null ? "-" : csat.average.toFixed(1)}
            <span className="text-sm font-normal text-ink-3"> / {csat.dist.length || 5}</span>
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {num(csat.total)} ratings · {num(csat.pending)} waiting for an answer
          </p>
          {csat.dist.length > 0 && (
            <div className="mt-4">
              <BarList
                rows={csat.dist.map((count, index) => ({ label: index + 1 + " star", value: count })).reverse()}
                tone="bg-ok"
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export async function MarketingCard({ token }: { token: string }) {
  const [broadcasts, loyaltyResult] = await Promise.all([
    safe(() => listBroadcasts(token)),
    safe(() => getLoyaltyOverview(token)),
  ]);
  const loyalty = okData(loyaltyResult);
  const recent = broadcasts?.broadcasts.slice(0, 3) ?? [];
  return (
    <Card title="Marketing" icon="marketing" href="/dashboard/broadcasts" linkLabel="Broadcasts">
      {!broadcasts && !loyalty ? (
        <Unavailable />
      ) : (
        <>
          {loyalty && (
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Reminders sent" value={num(loyalty.totals.sent)} />
              <Metric label="Came back" value={num(loyalty.totals.returned)} />
              <Metric label="Won back" value={rs(loyalty.totals.revenue)} />
            </div>
          )}
          {broadcasts && (
            <ul className={"space-y-2 " + (loyalty ? "mt-4 border-t border-line pt-4" : "")}>
              {recent.length === 0 && <li className="text-xs text-ink-3">No broadcasts sent yet.</li>}
              {recent.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-ink-2">{row.body || "Broadcast " + row.id}</span>
                  <span className="shrink-0 text-ink-3">
                    {num(row.done ?? 0)}/{num(row.recipientCount)}
                    {row.failed ? <span className="text-danger"> · {num(row.failed)} failed</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

const statusLabel = (key: string) => (key ? key[0].toUpperCase() + key.slice(1).replace(/_/g, " ") : "Unknown");

export async function FulfilmentCard({ token }: { token: string }) {
  const [cod, courier] = await Promise.all([
    safe(() => listCodRequests(token, "pending")),
    safe(() => listCourierBookings(token)),
  ]);
  // The courier payload is passed through un-normalised, so read it defensively.
  const statuses = Object.entries(courier?.summary ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const shipments = Array.isArray(courier?.bookings) ? courier.bookings.length : 0;
  return (
    <Card title="Orders & delivery" icon="courier" href="/dashboard/courier" linkLabel="Courier">
      {!cod && !courier ? (
        <Unavailable />
      ) : (
        <>
          {cod && (
            <Link href="/dashboard/cod" className="flex items-center justify-between rounded-xl bg-soft px-3 py-2.5 hover:bg-brand-soft">
              <span className="flex items-center gap-2 text-xs text-ink-2">
                <PortalIcon name="cod" className="h-4 w-4 text-brand" /> COD orders waiting to confirm
              </span>
              <span className="text-lg font-semibold text-ink">{num(cod.counts.pending ?? 0)}</span>
            </Link>
          )}
          {courier && (
            <div className="mt-4">
              {statuses.length === 0 ? (
                <p className="text-xs text-ink-3">No courier bookings yet.</p>
              ) : (
                <>
                  <BarList rows={statuses.slice(0, 4).map(([key, value]) => ({ label: statusLabel(key), value }))} tone="bg-flow" />
                  <p className="mt-3 text-[11px] text-ink-3">Status of your last {num(shipments)} shipments.</p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const USAGE_ROWS = [
  { label: "Broadcasts this month", key: "broadcasts_per_month" },
  { label: "Knowledge-base entries", key: "kb_entries" },
  { label: "Keyword alerts", key: "alert_rules" },
  { label: "Courier companies", key: "courier_providers" },
];

export async function PlanCard({ token }: { token: string }) {
  const plans = await safe(() => getPlans(token));
  return (
    <Card title="Plan & usage" icon="settings" href="/dashboard/settings" linkLabel="Manage">
      {!plans ? (
        <Unavailable />
      ) : (
        <>
          <span className="rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-[10px] text-brand">
            {plans.plan === "legacy" ? "Unlimited" : plans.plan || "Plan"}
          </span>
          <ul className="mt-4 space-y-3">
            {USAGE_ROWS.map((row) => {
              const used = Number(plans.usage?.[row.key] ?? 0);
              const limit = plans.limits?.[row.key] ?? null;
              return (
                <li key={row.key}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="text-ink-2">{row.label}</span>
                    <span className="text-ink">
                      {num(used)} / {limit === null ? "no limit" : num(limit)}
                    </span>
                  </div>
                  {limit !== null && limit > 0 && (
                    <div className="h-1.5 rounded-full bg-soft">
                      <div
                        className={"h-1.5 rounded-full " + (used >= limit ? "bg-danger" : "bg-brand")}
                        style={{ width: Math.min(100, (used / limit) * 100) + "%" }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

export async function HotLeadsCard({ token }: { token: string }) {
  const overview = await overviewOnce(token);
  const leads = overview?.hotLeads ?? [];
  return (
    <Card title="Hot leads" icon="flame" href="/dashboard/sales" linkLabel="Sales desk">
      {!overview ? (
        <Unavailable />
      ) : leads.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-3">No open chats are flagged hot right now.</p>
      ) : (
        <ul className="space-y-2">
          {leads.map((lead) => (
            <li key={"hot-lead-" + String(lead.id)}>
              <Link
                href={"/dashboard/conversations?q=" + encodeURIComponent(lead.contactId)}
                className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 transition-colors duration-200 hover:border-amber-400/40"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-400/10 text-amber-700">
                    <PortalIcon name="flame" className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{lead.contactName || lead.contactId}</span>
                    {lead.preview && <span className="block truncate text-[10px] text-ink-3">{lead.preview}</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                    {lead.leadScore !== null ? "score " + lead.leadScore : "hot"}
                  </span>
                  <span className="block text-[10px] text-ink-3">{whenLabel(lead.lastMessageAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export async function ActivityCard({ token }: { token: string }) {
  const activity = await safe(() => getRecentActivity(token));
  return (
    <Card title="Recent activity" icon="activity" href="/dashboard/activity" linkLabel="All activity">
      {!activity ? (
        <Unavailable />
      ) : activity.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-3">Nothing has happened yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {activity.slice(0, 6).map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 text-xs">
              <span className="min-w-0 truncate text-ink-2">
                {item.label}
                {item.note ? <span className="text-ink-3"> - {item.note}</span> : null}
              </span>
              <span className="shrink-0 text-ink-3">{item.timeAgo}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
