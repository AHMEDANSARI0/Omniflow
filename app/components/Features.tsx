import {
  Brain,
  CornerDownRight,
  GitBranch,
  Layers,
  MessagesSquare,
  Route,
  Timer,
  UserCheck,
} from "lucide-react";
import type { FeaturesContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

/**
 * The capability grid — six real product features, each with its own
 * mini visual instead of a generic icon row. Server component.
 */
export default function Features({
  content,
}: {
  content: FeaturesContent;
}) {
  const capabilities = content.capabilities
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  const features = [
    {
      title: content.f1_title,
      desc: content.f1_desc,
      Icon: MessagesSquare,
      visual: "chat" as const,
    },
    {
      title: content.f2_title,
      desc: content.f2_desc,
      Icon: Brain,
      visual: "intent" as const,
    },
    {
      title: content.f3_title,
      desc: content.f3_desc,
      Icon: Timer,
      visual: "timer" as const,
    },
    {
      title: content.f4_title,
      desc: content.f4_desc,
      Icon: Route,
      visual: "route" as const,
    },
    {
      title: content.f5_title,
      desc: content.f5_desc,
      Icon: GitBranch,
      visual: "workflow" as const,
    },
    {
      title: content.f6_title,
      desc: content.f6_desc,
      Icon: Layers,
      visual: "channels" as const,
    },
  ];

  return (
    <Section id="features" tone="canvas">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(({ title, desc, Icon, visual }) => (
          <Reveal key={title} lift>
            <Card className="flex h-full flex-col p-6">
              <FeatureVisual kind={visual} />
              <div className="mt-5 flex items-center gap-3">
                <span
                  aria-hidden
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand/15 bg-brand-soft text-brand"
                >
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                {desc}
              </p>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
          {capabilities.map((item) => (
            <Badge key={item} tone="neutral">
              {item}
            </Badge>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}

/** Mini product visuals — every card shows its concept, not a doodad. */
function FeatureVisual({ kind }: { kind: "chat" | "intent" | "timer" | "route" | "workflow" | "channels" }) {
  if (kind === "chat") {
    return (
      <div className="space-y-1.5 rounded-xl2 border border-line bg-soft p-3.5">
        <p className="w-fit rounded-lg rounded-tl-sm border border-line bg-white px-2.5 py-1.5 text-[11px] text-ink-2">
          Order kab aay ga?
        </p>
        <p className="ml-auto w-fit rounded-lg rounded-tr-sm border border-brand/20 bg-brand-soft px-2.5 py-1.5 text-[11px] font-medium text-brand-2">
          Kal tak pohanch jay ga ✓
        </p>
      </div>
    );
  }
  if (kind === "intent") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl2 border border-line bg-soft p-3.5">
        <Badge tone="brand">Intent: order status</Badge>
        <Badge tone="ai">High intent</Badge>
        <Badge tone="success">Qualified</Badge>
      </div>
    );
  }
  if (kind === "timer") {
    return (
      <div className="rounded-xl2 border border-line bg-soft p-3.5">
        <div className="flex items-center justify-between text-[11px] font-medium text-ink-2">
          <span>Follow-up</span>
          <span className="text-ink-3">in 24h</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          <div className="of-gradient h-full w-2/3 rounded-full" />
        </div>
      </div>
    );
  }
  if (kind === "route") {
    return (
      <div className="flex items-center gap-2 rounded-xl2 border border-line bg-soft p-3.5 text-[11px] font-medium">
        <span className="rounded-lg border border-line bg-white px-2 py-1 text-ink-2">
          Sales
        </span>
        <CornerDownRight className="h-3.5 w-3.5 text-brand" aria-hidden />
        <span className="rounded-lg border border-brand/20 bg-brand-soft px-2 py-1 text-brand-2">
          Ahmed (closer)
        </span>
      </div>
    );
  }
  if (kind === "workflow") {
    return (
      <div className="flex items-center gap-1.5 rounded-xl2 border border-line bg-soft p-3.5 text-[10.5px] font-semibold">
        {["Trigger", "AI", "Action"].map((node, index) => (
          <span key={node} className="flex items-center gap-1.5">
            <span className="rounded-lg border border-line bg-white px-2 py-1 text-ink-2">
              {node}
            </span>
            {index < 2 ? (
              <span aria-hidden className="h-px w-3 bg-brand/50" />
            ) : null}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 rounded-xl2 border border-line bg-soft p-3.5">
      {["WA", "IG", "MS", "TG"].map((code, index) => (
        <span
          key={code}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border text-[10px] font-bold ${
            index === 0
              ? "border-ok/25 bg-ok-soft text-ok"
              : "border-line bg-white text-ink-3"
          }`}
        >
          {code}
        </span>
      ))}
      <UserCheck className="ml-auto h-4 w-4 text-brand" aria-hidden />
    </div>
  );
}
