import { ArrowRight, Sparkles } from "lucide-react";
import { DASHBOARD_PREVIEW, type DashboardTone } from "../../lib/marketing/dashboard";
import { DASHBOARD_SECTION } from "../../lib/marketing/sections";
import { SITE_ROUTES } from "../../lib/marketing/site";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Button from "./ui/Button";
import Icon from "./ui/Icon";
import CountUp from "./ui/CountUp";
import StatusIndicator from "./ui/StatusIndicator";

const TAG_TONES: Record<DashboardTone, string> = {
  brand: "border-brand/20 bg-brand-soft text-brand-2",
  flow: "border-flow/20 bg-flow-soft text-sky-700",
  ai: "border-ai/20 bg-ai-soft text-violet-700",
  warn: "border-warn/25 bg-warn-soft text-amber-700",
};

/**
 * Dashboard preview (§216): a browser-framed product UI rendered from
 * lib/marketing/dashboard.ts (sample data, labelled as such). Stats
 * count up once in view; everything else is static server HTML.
 */
export default function DashboardShowcase() {
  const d = DASHBOARD_PREVIEW;
  return (
    <Section id={DASHBOARD_SECTION.id} tone="canvas" labelledBy="dashboard-title" wide>
      <Reveal>
        <SectionHead
          id="dashboard-title"
          eyebrow={DASHBOARD_SECTION.eyebrow}
          title={DASHBOARD_SECTION.title}
          copy={DASHBOARD_SECTION.copy}
        />
      </Reveal>

      <Reveal className="mt-14">
        <figure className="relative">
          <div aria-hidden className="absolute -inset-x-8 -top-10 bottom-10 rounded-[48px] bg-[radial-gradient(50%_60%_at_50%_30%,rgba(99,91,255,0.14),transparent)]" />
          <div className="relative overflow-hidden rounded-[22px] border border-line bg-white shadow-[0_2px_6px_rgba(16,24,40,0.04),0_40px_80px_-40px_rgba(16,24,40,0.3)]">
            {/* browser chrome */}
            <div className="flex items-center gap-3 border-b border-line bg-soft/80 px-4 py-2.5">
              <span aria-hidden className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#F97066]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#FDB022]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#32D583]" />
              </span>
              <span className="mx-auto truncate rounded-md border border-line bg-white px-3 py-0.5 text-[11.5px] text-ink-3">
                {d.address}
              </span>
            </div>

            <div className="grid lg:grid-cols-[200px_1fr]">
              {/* sidebar */}
              <nav aria-label="Dashboard preview sections" className="hidden border-r border-line bg-soft/40 p-3 lg:block">
                <ul className="space-y-0.5">
                  {d.nav.map((item) => (
                    <li
                      key={item.label}
                      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium ${
                        "active" in item && item.active ? "bg-white text-ink shadow-[0_1px_2px_rgba(16,24,40,0.06)]" : "text-ink-2"
                      }`}
                    >
                      <Icon name={item.icon} className="h-4 w-4" />
                      <span className="flex-1">{item.label}</span>
                      {"badge" in item && item.badge ? (
                        <span className="rounded-full bg-brand px-1.5 text-[10.5px] font-semibold text-white">{item.badge}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </nav>

              <div className="min-w-0 p-4 sm:p-6">
                <div className="flex items-baseline justify-between">
                  <p className="font-display text-lg font-semibold text-ink">{d.title}</p>
                  <p className="text-[12px] text-ink-3">{d.subtitle}</p>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
                  {d.stats.map((stat) => (
                    <div key={stat.label} className="rounded-xl2 border border-line bg-white p-4">
                      <dt className="text-[12px] font-medium text-ink-3">{stat.label}</dt>
                      <dd className="mt-1 font-display text-2xl font-semibold text-ink tabular-nums sm:text-[28px]">
                        <CountUp value={stat.value} suffix={stat.suffix} />
                      </dd>
                      <dd className="mt-0.5 text-[11.5px] font-medium text-ok">{stat.trend}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <section aria-label={d.queueTitle} className="rounded-xl2 border border-line">
                    <div className="flex items-center justify-between border-b border-line px-4 py-3">
                      <h3 className="text-[13.5px] font-semibold text-ink">{d.queueTitle}</h3>
                      <StatusIndicator label={`${d.queue.length} open`} tone="success" pulse size="xs" />
                    </div>
                    <ul className="divide-y divide-line">
                      {d.queue.map((row) => (
                        <li key={row.name} className="flex items-center gap-3 px-4 py-3">
                          <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-soft text-[11px] font-semibold text-ink-2">
                            {row.name.split(" ").map((part) => part[0]).join("")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="text-[13px] font-semibold text-ink">{row.name}</span>
                              <span className={`hidden rounded-full border px-1.5 py-px text-[10.5px] font-semibold sm:inline ${TAG_TONES[row.tone]}`}>
                                {row.tag}
                              </span>
                            </span>
                            <span className="block truncate text-[12.5px] text-ink-2">{row.text}</span>
                          </span>
                          <span className="hidden shrink-0 text-[11.5px] font-medium text-ink-3 md:inline">{row.state}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <div className="space-y-4">
                    <section aria-label={d.channelsTitle} className="rounded-xl2 border border-line p-4">
                      <h3 className="text-[13.5px] font-semibold text-ink">{d.channelsTitle}</h3>
                      <ul className="mt-3 space-y-2">
                        {d.channels.map((channel) => (
                          <li key={channel.name} className="flex items-center justify-between text-[13px]">
                            <span className="font-medium text-ink-2">{channel.name}</span>
                            <StatusIndicator
                              label={channel.state}
                              tone={channel.ok ? "success" : "brand"}
                              size="xs"
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                    <section aria-label={d.activityTitle} className="rounded-xl2 border border-line p-4">
                      <h3 className="text-[13.5px] font-semibold text-ink">{d.activityTitle}</h3>
                      <ul className="mt-3 space-y-2.5">
                        {d.activity.map((item) => (
                          <li key={item.label} className="flex items-start gap-2 text-[12.5px]">
                            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                            <span className="flex-1 text-ink-2">{item.label}</span>
                            <span className="shrink-0 text-[11px] text-ink-3">{item.time}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <figcaption className="mt-4 text-center text-xs text-ink-3">{d.caption}</figcaption>
        </figure>
      </Reveal>

      <div className="mt-8 text-center">
        <Button href={SITE_ROUTES.start} variant="secondary">
          {DASHBOARD_SECTION.cta}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </Section>
  );
}
