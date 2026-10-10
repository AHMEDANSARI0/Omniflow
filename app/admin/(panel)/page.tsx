import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import Icon from "../../components/ui/Icon";
import { createClient } from "../../../lib/supabase/server";
import {
  getAdminAiOverview,
  getAdminProviders,
  listAdminUsers,
  type AdminAiOverview,
} from "../../../lib/omniflow/admin-control-plane";
import { ADMIN_NAV } from "../../../lib/omniflow/admin-nav";
import { getAdminBilling } from "../../../lib/omniflow/admin-billing"; // §261
import { formatMoney } from "../../../lib/omniflow/admin-billing-core"; // §261
import {
  aiRates,
  humanize,
  leadStats,
  percent,
  problemRows,
  providerLabel,
  providerRows,
  relativeTime,
  signalLabel,
  usd,
  workspaceName,
  type DashboardLead,
} from "../../../lib/omniflow/admin-dashboard";

// §259: the dashboard is an overview of what exists today. Anything not
// collected yet is listed under "Not tracked yet" and shows no figure.
const RANGES = [7, 30];

const NOT_TRACKED = [
  {
    title: "Website visits and funnel",
    detail: "Page views, CTA clicks and form starts are not recorded yet. Needs a small tracking step on the marketing site.",
  },
  {
    title: "OmniFlow platform revenue",
    detail: "There is no billing system in the code yet, so there is no subscription income to total.",
  },
  {
    title: "Client sales across workspaces",
    detail: "Each workspace sees its own checkout sales. A total across workspaces needs one Control Plane report.",
  },
  {
    title: "AI key expiry and health",
    detail: "Expiry dates and key checks are not stored. Failed AI calls are the only signal today.",
  },
];

async function loadLeads(): Promise<DashboardLead[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("leads").select("status, created_at");
  if (error) throw new Error("leads unavailable");
  return (data ?? []) as DashboardLead[];
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rawRange } = await searchParams;
  const range = RANGES.includes(Number(rawRange)) ? Number(rawRange) : RANGES[0];
  const now = Date.now();

  // Each source fails on its own: one broken feed never blanks the whole page.
  const [leadsResult, aiResult, providersResult, usersResult, billingResult] = await Promise.allSettled([
    loadLeads(),
    getAdminAiOverview(range),
    getAdminProviders(),
    listAdminUsers(),
    getAdminBilling(),
  ]);
  const billing = billingResult.status === "fulfilled" ? billingResult.value.overview : null; // §261
  const leads = leadsResult.status === "fulfilled" ? leadsResult.value : null;
  const ai: AdminAiOverview | null = aiResult.status === "fulfilled" ? aiResult.value : null;
  const providers = providersResult.status === "fulfilled" ? providersResult.value.groups : null;
  const users = usersResult.status === "fulfilled" ? usersResult.value : null;

  const totals = ai?.totals ?? null;
  const stats = leads ? leadStats(leads, now, range) : null;
  const rates = totals ? aiRates(totals) : null;
  const lockedAccounts = users ? users.filter((user) => user.locked).length : null;
  const problems = ai ? problemRows(ai.workspaces) : [];
  const names = new Map((ai?.workspaces ?? []).map((ws) => [ws.client_id, workspaceName(ws)]));
  const keys = providerRows(providers);
  const cost = totals && totals.priced ? totals.cost_usd : null;
  const dashboardSections = ADMIN_NAV.filter((item) => item.href !== "/admin");

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
          <p className="mt-1.5 text-sm text-ink-3">Website, leads, customers and AI in one place.</p>
        </div>
        <nav aria-label="Date range" className="flex rounded-xl border border-line bg-white p-1 text-xs shadow-card">
          {RANGES.map((days) => (
            <Link
              key={days}
              href={`/admin?range=${days}`}
              aria-current={days === range ? "true" : undefined}
              className={`rounded-lg px-3 py-1.5 font-medium transition-colors duration-200 ${
                days === range ? "bg-brand-soft text-ink" : "text-ink-3 hover:text-ink"
              }`}
            >
              Last {days} days
            </Link>
          ))}
        </nav>
      </div>

      {/* Health: what answered, and whether the AI is allowed to run */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Health
          label="Website data"
          ok={leads !== null}
          value={leads !== null ? "Connected" : "Unavailable"}
          detail={leads !== null ? "Leads are read from the website database." : "Leads could not be read. Try again shortly."}
        />
        <Health
          label="Control Plane"
          ok={ai !== null}
          value={ai !== null ? "Connected" : "Unavailable"}
          detail={ai !== null ? "Updated " + relativeTime(ai.generated_at, now) + "." : "AI and customer numbers appear once it answers."}
        />
        <Health
          label="AI engine"
          ok={ai ? !ai.controls.kill_switch : null}
          value={ai ? (ai.controls.kill_switch ? "Paused" : "Running") : "Unknown"}
          detail={
            ai
              ? ai.controls.kill_switch
                ? "Kill switch is on, so AI calls are blocked."
                : "Autonomy cap: " + ai.controls.autonomy_cap + "."
              : "No AI status yet."
          }
        />
      </div>

      {/* Headline numbers for the selected range */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Leads"
          value={stats ? String(stats.total) : "—"}
          detail={stats ? stats.recent + " new in the last " + range + " days" : "Unavailable right now"}
        />
        <Kpi
          label="Customer workspaces"
          value={totals ? String(totals.workspaces) : "—"}
          detail={
            lockedAccounts === null
              ? "Locked accounts unavailable"
              : lockedAccounts + " locked account" + (lockedAccounts === 1 ? "" : "s")
          }
        />
        <Kpi
          label="Answered by AI"
          value={totals ? String(totals.answers) : "—"}
          detail={
            totals && rates
              ? percent(rates.automationRate) + " of replies · " + totals.handoffs + " handed to a person"
              : "Unavailable right now"
          }
        />
        <Kpi
          label="AI calls"
          value={totals ? String(totals.calls) : "—"}
          detail={
            totals && rates
              ? totals.failed + " failed (" + percent(rates.failureRate) + ") · " + usd(cost)
              : "Unavailable right now"
          }
        />
      </div>

      {/* §261: client billing - what is still owed and which plans are running out */}
      <section aria-labelledby="billing-card" className="mb-6 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="billing-card" className="text-sm font-semibold text-ink">Client billing</h2>
            <p className="mt-1 text-xs text-ink-3">Payments still due, plans expiring, and plans moved to Free.</p>
          </div>
          <Link href="/admin/customers/billing" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink">
            Open client billing
          </Link>
        </div>
        {billing ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-ink-3">Payment pending</dt>
              <dd className="mt-1 text-lg font-semibold text-ink">{formatMoney(billing.totals.payment_pending, billing.settings.currency)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Expiring soon</dt>
              <dd className="mt-1 text-lg font-semibold text-ink">{billing.totals.expiring_soon}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">In grace or expired</dt>
              <dd className="mt-1 text-lg font-semibold text-ink">{billing.totals.grace + billing.totals.expired}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Moved to Free</dt>
              <dd className="mt-1 text-lg font-semibold text-ink">{billing.totals.dropped_to_free}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 text-sm text-ink-3">Client billing is unavailable right now.</p>
        )}
      </section>

      {/* Who has a problem, and whether each provider key is set */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Panel
          title="Customers needing attention"
          note={"Open problems in the last " + range + " days, most serious first."}
          className="lg:col-span-2"
        >
          {ai === null ? (
            <Empty>Customer signals appear once the Control Plane answers.</Empty>
          ) : problems.length === 0 ? (
            <Empty>No open problems in the last {range} days.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {problems.slice(0, 8).map((row) => (
                <li key={row.client_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{row.name}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {row.signals.map((signal) => (
                        <span
                          key={signal.kind}
                          className="rounded-md border border-line bg-soft px-2 py-0.5 text-[11px] text-ink-2"
                        >
                          {signalLabel(signal)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Link href="/admin/ai-control" className="shrink-0 text-xs text-ink-3 transition-colors duration-200 hover:text-brand">
                    Open AI Control
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="AI provider keys" note="Set or not set, per provider group.">
          {providers === null ? (
            <Empty>Could not load provider status.</Empty>
          ) : (
            <ul className="space-y-2.5">
              {keys.map((row) => (
                <li key={row.group} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink-2">{providerLabel(row.group)}</span>
                  <span className={row.configured ? "text-ok" : "text-amber-700"}>
                    {row.configured ? "Set" : "Not set"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
            Expiry dates are not stored, so a dead key shows up only as failed AI calls. Manage keys in Integrations.
          </p>
        </Panel>
      </div>

      {/* What happened, and where the leads are */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Panel title="Recent AI activity" note="Who, what and when. Message text is never shown here." className="lg:col-span-2">
          {ai === null ? (
            <Empty>Unavailable right now.</Empty>
          ) : ai.recent.length === 0 ? (
            <Empty>No AI activity in this range.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {ai.recent.slice(0, 8).map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{humanize(event.action)}</p>
                    <p className="mt-0.5 truncate text-xs text-ink-3">
                      {[humanize(event.category), names.get(event.client_id) ?? "Workspace #" + event.client_id]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-3">{relativeTime(event.created_at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Leads by status" note={stats ? stats.total + " in total" : undefined}>
          {stats === null ? (
            <Empty>Unavailable right now.</Empty>
          ) : stats.total === 0 ? (
            <Empty>No leads yet.</Empty>
          ) : (
            <ul className="space-y-3">
              {(["new", "contacted", "closed", "other"] as const)
                .filter((key) => key !== "other" || stats.byStatus.other > 0)
                .map((key) => {
                  const count = stats.byStatus[key];
                  const width = Math.round((count / stats.total) * 100);
                  return (
                    <li key={key}>
                      <div className="flex justify-between text-xs">
                        <span className="capitalize text-ink-2">{key}</span>
                        <span className="font-semibold text-ink">{count}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-soft">
                        <div className="h-full rounded-full bg-brand" style={{ width: width + "%" }} />
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Not tracked yet"
        note="These numbers are not collected anywhere yet, so the dashboard shows no figure for them."
        className="mb-8"
      >
        <ul className="grid gap-4 sm:grid-cols-2">
          {NOT_TRACKED.map((item) => (
            <li key={item.title} className="rounded-xl border border-dashed border-line-2 p-4">
              <p className="text-sm font-medium text-ink">{item.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">{item.detail}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading" className="mb-3 text-sm font-semibold text-ink">
          Sections
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {dashboardSections.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group rounded-2xl border border-line bg-white p-5 shadow-card transition-colors duration-300 hover:border-brand/20"
            >
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl border border-brand/20 bg-brand/[0.05] text-brand">
                <Icon name={item.icon} className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-semibold text-ink">{item.label}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{item.description}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors duration-300 group-hover:text-brand">
                Open
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function Panel({
  title,
  note,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-white p-5 shadow-card ${className}`}>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {note && <p className="mt-1 text-xs leading-relaxed text-ink-3">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{detail}</p>
    </div>
  );
}

function Health({
  label,
  ok,
  value,
  detail,
}: {
  label: string;
  ok: boolean | null;
  value: string;
  detail: string;
}) {
  const dot = ok === null ? "bg-line-2" : ok ? "bg-ok" : "bg-danger";
  return (
    <div className="flex gap-3 rounded-2xl border border-line bg-white p-4 shadow-card">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-3">{label}</p>
        <p className="text-sm font-semibold text-ink">{value}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{detail}</p>
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-3">{children}</p>;
}
