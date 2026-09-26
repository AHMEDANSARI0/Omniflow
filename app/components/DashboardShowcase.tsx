import {
  ArrowRight,
  Bot,
  Inbox,
  LayoutDashboard,
  Settings,
  Workflow,
} from "lucide-react";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Button from "./ui/Button";

/**
 * The product showcase: a real OmniFlow dashboard composition —
 * sidebar, stat cards, live conversation queue, automation activity.
 * Product visualization, not marketing copy. Server component.
 */
export default function DashboardShowcase() {
  const stats = [
    { label: "Conversations today", value: "128", trend: "+18%" },
    { label: "AI handled", value: "109", trend: "85%" },
    { label: "Human handoffs", value: "7", trend: "5%" },
    { label: "Leads qualified", value: "23", trend: "+6" },
  ];

  const queue = [
    {
      name: "Ahmed R.",
      text: "Black hoodie medium available hai?",
      tag: "Product inquiry",
      tone: "bg-brand-soft text-brand-2",
      state: "AI replied",
    },
    {
      name: "Sana K.",
      text: "Delivery Lahore mein kitne din?",
      tag: "Delivery",
      tone: "bg-flow-soft text-cyan-700",
      state: "AI replied",
    },
    {
      name: "Bilal M.",
      text: "Bulk order ka rate chahiye",
      tag: "High intent",
      tone: "bg-ai-soft text-ai",
      state: "Assigned to sales",
    },
    {
      name: "Hina S.",
      text: "Order cancel karna hai",
      tag: "Escalated",
      tone: "bg-warn-soft text-amber-600",
      state: "Human took over",
    },
  ];

  return (
    <Section id="dashboard" tone="canvas">
      <SectionHead
        eyebrow="The product"
        title={
          <>
            Everything happening in one place.
          </>
        }
        copy="Conversations, AI decisions, automations and customers — one dashboard your whole team understands in minutes."
      />

      <Reveal>
        <div className="mt-14 overflow-hidden rounded-xl3 border border-line bg-white shadow-card-hover">
          {/* window chrome */}
          <div className="flex items-center gap-2 border-b border-line bg-soft px-5 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-line-2" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-line-2" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-line-2" aria-hidden />
            <span className="ml-3 rounded-md border border-line bg-white px-2.5 py-1 text-[11px] text-ink-3">
              app.omniflow.pk/dashboard
            </span>
          </div>

          <div className="grid lg:grid-cols-[220px_1fr]">
            {/* sidebar */}
            <div className="hidden border-r border-line bg-white p-4 lg:block">
              {[
                { label: "Overview", Icon: LayoutDashboard, active: true },
                { label: "Conversations", Icon: Inbox, count: "4" },
                { label: "AI Agent", Icon: Bot },
                { label: "Automations", Icon: Workflow },
                { label: "Settings", Icon: Settings },
              ].map(({ label, Icon, active, count }) => (
                <div
                  key={label}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium ${
                    active
                      ? "border border-brand/20 bg-brand-soft text-brand-2"
                      : "text-ink-2"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                  {count ? (
                    <span className="ml-auto rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {count}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="bg-canvas p-5 sm:p-7">
              {/* stat cards */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {stats.map(({ label, value, trend }) => (
                  <div
                    key={label}
                    className="rounded-xl2 border border-line bg-white px-4 py-3.5 shadow-card"
                  >
                    <p className="text-[11px] font-medium text-ink-3">{label}</p>
                    <p className="mt-1 flex items-baseline gap-2">
                      <span className="font-display text-xl font-semibold text-ink">
                        {value}
                      </span>
                      <span className="text-[11px] font-semibold text-ok">
                        {trend}
                      </span>
                    </p>
                  </div>
                ))}
              </div>

              {/* conversation queue */}
              <div className="mt-4 rounded-xl2 border border-line bg-white shadow-card">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <p className="text-[13px] font-semibold text-ink">
                    Live conversations
                  </p>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ok">
                    <span aria-hidden className="of-pulse h-1.5 w-1.5 rounded-full bg-ok" />
                    WhatsApp connected
                  </span>
                </div>
                <ul className="divide-y divide-line/70">
                  {queue.map(({ name, text, tag, tone, state }) => (
                    <li
                      key={name}
                      className="flex items-center gap-3.5 px-4 py-3"
                    >
                      <span
                        aria-hidden
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-soft font-display text-[11px] font-semibold text-ink-2"
                      >
                        {name.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-ink">
                          {name}
                        </p>
                        <p className="truncate text-[12px] text-ink-2">{text}</p>
                      </div>
                      <span
                        className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold sm:inline-block ${tone}`}
                      >
                        {tag}
                      </span>
                      <span className="hidden shrink-0 text-[11px] font-medium text-ink-3 md:inline-block">
                        {state}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* automation activity strip */}
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl2 border border-line bg-white px-4 py-3.5 shadow-card">
                  <p className="text-[11px] font-medium text-ink-3">
                    Automation activity
                  </p>
                  <p className="mt-1 text-[13px] font-medium text-ink">
                    Follow-up sent to 14 interested buyers
                  </p>
                </div>
                <div className="rounded-xl2 border border-line bg-white px-4 py-3.5 shadow-card">
                  <p className="text-[11px] font-medium text-ink-3">
                    Workflow status
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-[13px] font-medium text-ink">
                    <span aria-hidden className="of-pulse h-1.5 w-1.5 rounded-full bg-ok" />
                    “Product inquiry” — running
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal>
        <div className="mt-10 text-center">
          <Button href="/dashboard/login" variant="secondary">
            Explore the dashboard
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
