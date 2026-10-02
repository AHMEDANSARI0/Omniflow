import { ArrowRight, Check, Clock, GitBranch, Sparkles, UserRound } from "lucide-react";
import type { FeatureVisual as FeatureVisualKind } from "../../../lib/marketing/sections";
import type { Integration } from "../../../lib/marketing/integrations";
import { getCopy, getMarketingList } from "../../../lib/marketing/cms";
import StatusIndicator, { AvailabilityBadge } from "../ui/StatusIndicator";
import { IntegrationLogo } from "../ui/IntegrationCard";

async function Conversation() {
  const data = (await getCopy("home_mockups")).features.conversation;
  return (
    <div className="space-y-2.5">
      <p className="max-w-[80%] rounded-2xl rounded-tl-sm border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        {data.customer}
      </p>
      <div className="ml-auto max-w-[86%]">
        <p className="rounded-2xl rounded-tr-sm bg-brand px-3.5 py-2.5 text-[13px] leading-snug text-white shadow-cta">
          {data.ai}
        </p>
        <p className="mt-1.5 flex items-center justify-end gap-1 text-[11px] font-medium text-ink-3">
          <Sparkles className="h-3 w-3 text-brand" aria-hidden />
          {data.meta}
        </p>
      </div>
    </div>
  );
}

async function Qualification() {
  const data = (await getCopy("home_mockups")).features.qualification;
  return (
    <div className="rounded-xl2 border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-ink-3">{data.name}</p>
        <StatusIndicator label={data.verdict} tone="success" size="xs" />
      </div>
      <p className="mt-1 font-display text-3xl font-semibold text-ink tabular-nums">{data.score}</p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-soft">
        <div className="of-gradient h-full rounded-full" style={{ width: `${data.score}%` }} />
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {data.signals.map((signal) => (
          <li key={signal} className="inline-flex items-center gap-1 rounded-full bg-soft px-2 py-0.5 text-[11px] font-medium text-ink-2">
            <Check className="h-3 w-3 text-ok" aria-hidden />
            {signal}
          </li>
        ))}
      </ul>
    </div>
  );
}

async function FollowUp() {
  const data = (await getCopy("home_mockups")).features.followUp;
  return (
    <ol className="relative space-y-3 pl-6">
      <span aria-hidden className="absolute bottom-2 left-[9px] top-2 w-px bg-line-2" />
      {data.steps.map((step, index) => (
        <li key={step.label} className="relative">
          <span
            aria-hidden
            className={`absolute -left-6 top-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-white ${
              index === 0 ? "bg-brand" : "bg-line-2"
            }`}
          />
          <div className="flex items-center justify-between rounded-xl border border-line bg-white px-3 py-2">
            <span className="text-[13px] font-semibold text-ink">{step.label}</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3">
              <Clock className="h-3 w-3" aria-hidden />
              {step.time}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

async function Routing() {
  const data = (await getCopy("home_mockups")).features.routing;
  return (
    <div className="flex items-center gap-3">
      <div className="rounded-xl border border-line bg-white px-3 py-2.5 text-[12px] font-semibold text-ink">
        <GitBranch className="mb-1 h-4 w-4 text-brand" aria-hidden />
        {data.from}
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <ul className="flex-1 space-y-1.5">
        {data.routes.map((route) => (
          <li
            key={route.label}
            className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold ${
              route.active ? "border-brand/30 bg-brand-soft text-brand-2" : "border-line bg-white text-ink-3"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="h-3 w-3" aria-hidden />
              {route.label}
            </span>
            {route.active ? <Check className="h-3.5 w-3.5" aria-label="Selected" /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

async function Workflow() {
  const data = (await getCopy("home_mockups")).features.workflow;
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {data.nodes.map((node, index) => (
        <li key={node} className="flex items-center gap-1.5">
          <span className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            {node}
          </span>
          {index < data.nodes.length - 1 ? (
            <ArrowRight className="h-3.5 w-3.5 text-brand" aria-hidden />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

async function Channels() {
  const [mockups, integrations] = await Promise.all([getCopy("home_mockups"), getMarketingList("integrations")]);
  const names = mockups.features.channels.names;
  const items = names
    .map((name) => integrations.find((item) => item.name === name))
    .filter((item): item is Integration => Boolean(item));
  return (
    <ul className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 rounded-xl border border-line bg-white p-2">
          <IntegrationLogo integration={item} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold text-ink">{item.name}</span>
            <AvailabilityBadge status={item.status} size="xs" />
          </span>
        </li>
      ))}
    </ul>
  );
}

async function Handoff() {
  const data = (await getCopy("home_mockups")).features.handoff;
  return (
    <div className="space-y-2.5">
      {data.rows.map((row) => (
        <div
          key={row.name}
          className={`flex items-center justify-between rounded-xl2 border px-3.5 py-2.5 text-[12.5px] ${
            row.human ? "border-ok/25 bg-ok-soft" : "border-line bg-white"
          }`}
        >
          <span className={`font-medium ${row.human ? "text-ok" : "text-ink-2"}`}>
            {row.name} · {row.detail}
          </span>
          <StatusIndicator label={row.owner} tone={row.human ? "success" : "brand"} size="xs" />
        </div>
      ))}
      <p className="pt-1 text-[11.5px] text-ink-3">{data.note}</p>
    </div>
  );
}

/** Small CSS product visual for a feature (decorative, data-driven). */
export default function FeatureVisual({ kind }: { kind: FeatureVisualKind }) {
  const body = {
    conversation: <Conversation />,
    qualification: <Qualification />,
    "follow-up": <FollowUp />,
    routing: <Routing />,
    workflow: <Workflow />,
    channels: <Channels />,
    handoff: <Handoff />,
  }[kind];
  return (
    <div
      aria-hidden
      className="rounded-xl3 border border-line bg-soft/70 p-4 sm:p-5 [background-image:radial-gradient(22rem_14rem_at_100%_0%,rgba(99,91,255,0.07),transparent_70%)]"
    >
      {body}
    </div>
  );
}
