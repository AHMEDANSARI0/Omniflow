// §260 Website analytics: how the public OmniFlow website is used. Numbers come
// from site_stats() in the database and are anonymous and aggregated (no IP
// addresses, no cookies). When the numbers cannot be read, the page says so
// instead of showing zeros.
import Link from "next/link";
import Icon from "../../../components/ui/Icon";
import {
  loadMaintenanceLog,
  loadSiteSettings,
  loadSiteStats,
  type MaintenanceRun,
} from "../../../../lib/omniflow/site-analytics";
import {
  barPercent,
  formatSeconds,
  percentOf,
  targetLabel,
  type SiteStats,
} from "../../../../lib/omniflow/site-analytics-core";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90];

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function share(part: number, whole: number): string {
  const value = percentOf(part, whole);
  return value === null ? "-" : `${value}%`;
}

function formatRunTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toISOString();
  }
}

export default async function WebsiteAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const requested = Number(range);
  const days = RANGES.includes(requested) ? requested : 30;

  const [stats, settings, runs] = await Promise.all([
    loadSiteStats(days),
    loadSiteSettings(),
    loadMaintenanceLog(5),
  ]);
  const timezone = settings?.timezone ?? stats?.timezone ?? "Asia/Karachi";
  const retention = settings?.retentionDays ?? 90;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Website analytics</h1>
          <p className="mt-1.5 text-sm text-ink-3">
            How visitors use the public OmniFlow website. Anonymous and aggregated: no IP addresses and no cookies.
          </p>
        </div>
        <nav aria-label="Date range" className="flex gap-1.5">
          {RANGES.map((value) => (
            <Link
              key={value}
              href={`/admin/analytics?range=${value}`}
              aria-current={value === days ? "page" : undefined}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                value === days ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2 hover:bg-soft"
              }`}
            >
              Last {value} days
            </Link>
          ))}
        </nav>
      </header>

      {stats ? (
        <Report stats={stats} days={days} retention={retention} timezone={timezone} runs={runs} />
      ) : (
        <section className="rounded-xl border border-line bg-white p-6 shadow-card">
          <div className="flex items-center gap-2">
            <Icon name="chart" className="h-5 w-5 text-brand" />
            <h2 className="text-sm font-semibold text-ink">Website analytics is not connected yet</h2>
          </div>
          <p className="mt-2 text-sm text-ink-2">
            Run db/site_analytics.sql once in the Supabase SQL editor, then set OF_ANALYTICS_SALT and CRON_SECRET in
            Vercel. Until then no visits are recorded and no numbers are shown.
          </p>
        </section>
      )}
    </div>
  );
}

function Report({
  stats,
  days,
  retention,
  timezone,
  runs,
}: {
  stats: SiteStats;
  days: number;
  retention: number;
  timezone: string;
  runs: MaintenanceRun[] | null;
}) {
  const t = stats.totals;
  return (
    <div className="space-y-6">
      {t.views === 0 ? (
        <p className="rounded-lg border border-line bg-soft px-4 py-3 text-sm text-ink-2">
          No visits in the last {days} days yet. Numbers appear after the first visits.
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi icon="users" label="Visitors" value={count(t.visitors)} hint={`Last ${days} days`} />
        <Kpi icon="eye" label="Page views" value={count(t.views)} hint={`Last ${days} days`} />
        <Kpi icon="clock" label="Average time on a page" value={formatSeconds(t.avgSeconds)} hint="Visits with a measured time" />
        <Kpi icon="target" label="Button and link clicks" value={count(t.ctaClicks)} hint={`${count(t.ctaVisitors)} visitors clicked`} />
        <Kpi icon="file" label="Form submits" value={count(t.formSubmits)} hint="Submit attempts, not confirmed sign-ups" />
        <Kpi icon="trending" label="Form conversion" value={share(t.formVisitors, t.visitors)} hint="Share of visitors who submitted a form" />
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Page views per day</h2>
        <DailyBars rows={stats.daily} />
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Visitor path</h2>
        <p className="mt-1 text-xs text-ink-3">Share of all visitors in this period.</p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          <FunnelStep label="Visited the website" value={t.visitors} whole={t.visitors} />
          <FunnelStep label="Clicked a button or link" value={t.ctaVisitors} whole={t.visitors} />
          <FunnelStep label="Submitted a form" value={t.formVisitors} whole={t.visitors} />
        </ol>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <RankList
          title="Top pages"
          unit="views"
          rows={stats.pages.map((p) => ({ label: p.path, value: p.views }))}
        />
        <RankList
          title="Where visitors come from"
          unit="visitors"
          rows={stats.sources.map((s) => ({ label: s.source, value: s.visitors }))}
        />
        <RankList
          title="Campaigns (UTM tags)"
          unit="views"
          rows={stats.campaigns.map((c) => ({
            label: c.utmCampaign ? `${c.utmSource} / ${c.utmCampaign}` : c.utmSource,
            value: c.views,
          }))}
        />
        <RankList
          title="Countries"
          unit="visitors"
          rows={stats.countries.map((c) => ({ label: c.country, value: c.visitors }))}
        />
        <RankList
          title="Devices"
          unit="visitors"
          rows={stats.devices.map((d) => ({ label: d.device, value: d.visitors }))}
        />
        <RankList
          title="Browsers"
          unit="visitors"
          rows={stats.browsers.map((b) => ({ label: b.browser, value: b.visitors }))}
        />
        <RankList
          title="Languages"
          unit="visitors"
          rows={stats.languages.map((l) => ({ label: l.lang, value: l.visitors }))}
        />
        <RankList
          title="Button and link clicks"
          unit="clicks"
          rows={stats.clicks.map((c) => ({ label: targetLabel(c.target), value: c.clicks }))}
        />
        <RankList
          title="Form submits"
          unit="submits"
          rows={stats.forms.map((f) => ({ label: targetLabel(f.target), value: f.submits }))}
        />
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-card">
        <div className="flex items-center gap-2">
          <Icon name="shield" className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-ink">Privacy and retention</h2>
        </div>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>No cookies or local storage. No IP address is stored: each visitor code is a one-way hash that changes every day.</li>
          <li>Visit records are kept for up to {retention} days, then deleted. No daily totals or lifetime counts are kept.</li>
          <li>The cleanup runs once a day, around 03:00 ({timezone}), through Vercel Cron.</li>
          <li>Visitors with Do Not Track turned on are not measured.</li>
        </ul>
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-3">Recent cleanup runs</h3>
        {runs === null ? (
          <p className="mt-2 text-sm text-ink-3">The cleanup log could not be read right now.</p>
        ) : runs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">No cleanup has run yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">Ran at</th>
                  <th className="py-1.5 pr-4 font-medium">Rows deleted</th>
                  <th className="py-1.5 font-medium">Keep (days)</th>
                </tr>
              </thead>
              <tbody className="text-ink-2">
                {runs.map((run) => (
                  <tr key={run.ranAt} className="border-t border-line">
                    <td className="py-1.5 pr-4">{formatRunTime(run.ranAt, timezone)}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{count(run.rawDeleted)}</td>
                    <td className="py-1.5 tabular-nums">{run.retentionDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
}: {
  icon: "users" | "eye" | "clock" | "target" | "file" | "trending";
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
        <Icon name={icon} className="h-4 w-4 text-brand" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-1 text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function DailyBars({ rows }: { rows: SiteStats["daily"] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-ink-3">No page views in this period.</p>;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.views), 0);
  return (
    <div className="mt-4">
      <div className="flex h-40 items-end gap-1" role="img" aria-label="Page views per day">
        {rows.map((row) => (
          <div
            key={row.day}
            className="flex h-full flex-1 items-end"
            title={`${row.day}: ${count(row.views)} views, ${count(row.visitors)} visitors`}
          >
            <div className="w-full rounded-t bg-brand" style={{ height: `${barPercent(row.views, max)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ink-3">
        <span>{rows[0].day}</span>
        <span>{rows[rows.length - 1].day}</span>
      </div>
    </div>
  );
}

function FunnelStep({ label, value, whole }: { label: string; value: number; whole: number }) {
  const pct = percentOf(value, whole);
  return (
    <li className="rounded-lg border border-line bg-soft p-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{count(value)}</div>
      <div className="mt-0.5 text-xs text-ink-2">{pct === null ? "No visitors yet" : `${pct}% of visitors`}</div>
    </li>
  );
}

function RankList({
  title,
  unit,
  rows,
}: {
  title: string;
  unit: string;
  rows: { label: string; value: number }[];
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <section className="rounded-xl border border-line bg-white p-5 shadow-card">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No data in this period.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.map((row, index) => (
            <li key={`${index}-${row.label}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-ink-2">{row.label}</span>
                <span className="shrink-0 tabular-nums text-ink">
                  {count(row.value)} <span className="text-xs text-ink-3">{unit}</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                <div className="h-full rounded-full bg-brand" style={{ width: `${barPercent(row.value, max)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
