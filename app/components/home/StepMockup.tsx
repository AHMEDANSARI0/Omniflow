import type { ReactNode } from "react";
import { Check, FileText, GitBranch, MessageCircle, Zap } from "lucide-react";
import type { StepMockup as StepMockupKind } from "../../../lib/marketing/sections";
import { STEP_MOCKUP_DATA } from "../../../lib/marketing/sections";
import { statusForChannel } from "../../../lib/marketing/integrations";
import StatusIndicator, { AvailabilityBadge } from "../ui/StatusIndicator";

/** Window chrome shared by the step mockups. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl2 border border-line bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-center gap-1.5 border-b border-line bg-soft/70 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-line-2" />
        <span className="h-2 w-2 rounded-full bg-line-2" />
        <span className="h-2 w-2 rounded-full bg-line-2" />
        <span className="ml-2 text-[11px] font-semibold text-ink-3">{title}</span>
      </div>
      <div className="p-3.5">{children}</div>
    </div>
  );
}

function Channels() {
  const data = STEP_MOCKUP_DATA.channels;
  return (
    <Frame title={data.title}>
      <ul className="space-y-2">
        {data.rows.map((row) => (
          <li key={row.name} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
            <MessageCircle className="h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-semibold text-ink">{row.name}</span>
              <span className="block truncate text-[11px] text-ink-3">{row.detail}</span>
            </span>
            <AvailabilityBadge status={statusForChannel(row.name)} size="xs" />
          </li>
        ))}
      </ul>
    </Frame>
  );
}

function Knowledge() {
  const data = STEP_MOCKUP_DATA.knowledge;
  return (
    <Frame title={data.title}>
      <ul className="space-y-2">
        {data.items.map((item) => (
          <li key={item.name} className="flex items-center gap-3 rounded-lg bg-soft/70 px-3 py-2">
            <FileText className="h-4 w-4 shrink-0 text-flow" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-semibold text-ink">{item.name}</span>
              <span className="block truncate text-[11px] text-ink-3">{item.detail}</span>
            </span>
            <Check className="h-3.5 w-3.5 text-ok" aria-label="Added" />
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-soft">
          <div className="of-gradient h-full w-full rounded-full" />
        </div>
        <StatusIndicator label={data.status} tone="success" size="xs" className="ml-3" />
      </div>
    </Frame>
  );
}

function Workflow() {
  const data = STEP_MOCKUP_DATA.workflow;
  const icons = [Zap, GitBranch, Check];
  return (
    <Frame title={data.title}>
      <ol className="space-y-0">
        {data.nodes.map((node, index) => {
          const NodeIcon = icons[index % icons.length];
          return (
            <li key={node.label} className="relative">
              <div className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
                  <NodeIcon className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{node.kind}</span>
                  <span className="block truncate text-[12.5px] font-semibold text-ink">{node.label}</span>
                </span>
              </div>
              {index < data.nodes.length - 1 ? (
                <span aria-hidden className="of-connector of-connector-v absolute left-[26px] top-full block h-2.5 w-[2px]" />
              ) : null}
              {index < data.nodes.length - 1 ? <div className="h-2.5" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}

function Run() {
  const data = STEP_MOCKUP_DATA.run;
  return (
    <Frame title={data.title}>
      <div className="space-y-2">
        <p className="max-w-[85%] rounded-xl rounded-tl-sm bg-soft px-3 py-2 text-[12.5px] text-ink">
          {data.message}
        </p>
        <p className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-brand px-3 py-2 text-[12.5px] text-white">
          {data.reply}
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {data.results.map((result) => (
          <li key={result}>
            <StatusIndicator label={result} tone="success" size="xs" />
          </li>
        ))}
      </ul>
    </Frame>
  );
}

/** CSS-only product mockup for one How-it-works step. */
export default function StepMockup({ kind }: { kind: StepMockupKind }) {
  switch (kind) {
    case "channels":
      return <Channels />;
    case "knowledge":
      return <Knowledge />;
    case "workflow":
      return <Workflow />;
    case "run":
      return <Run />;
    default:
      return null;
  }
}
