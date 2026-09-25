import {
  ArrowRight,
  Bot,
  GitBranch,
  MousePointerClick,
  Send,
  Zap,
} from "lucide-react";
import type { HowItWorksContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Badge from "./ui/Badge";
import Button from "./ui/Button";

/**
 * "Build once. Let OmniFlow run." — the workflow builder story:
 * Trigger -> AI -> Condition -> Actions, drawn as builder nodes on a
 * light canvas. Server component.
 */
export default function HowItWorks({
  content,
}: {
  content: HowItWorksContent;
}) {
  const steps = [
    {
      type: content.s1_type,
      title: content.s1_title,
      desc: content.s1_desc,
      Icon: MousePointerClick,
    },
    {
      type: content.s2_type,
      title: content.s2_title,
      desc: content.s2_desc,
      Icon: Bot,
    },
    {
      type: content.s3_type,
      title: content.s3_title,
      desc: content.s3_desc,
      Icon: GitBranch,
    },
    {
      type: content.s4_type,
      title: content.s4_title,
      desc: content.s4_desc,
      Icon: Zap,
    },
  ];

  return (
    <Section id="how-it-works" tone="white">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      {/* the builder canvas */}
      <Reveal>
        <div className="of-dot-grid relative mx-auto mt-14 max-w-4xl overflow-hidden rounded-xl3 border border-line bg-canvas p-5 sm:p-8">
          <div className="grid gap-4 sm:grid-cols-2">
            {steps.slice(0, 2).map(({ type, title, desc, Icon }, index) => (
              <NodeCard
                key={type}
                type={type}
                title={title}
                desc={desc}
                Icon={Icon}
                tone={index === 0 ? "brand" : "ai"}
              />
            ))}
          </div>

          {/* connector */}
          <div className="flex items-center justify-center py-1">
            <span aria-hidden className="h-8 w-px bg-gradient-to-b from-brand to-ai" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
            <NodeCard
              type={steps[2].type}
              title={steps[2].title}
              desc={steps[2].desc}
              Icon={steps[2].Icon}
              tone="flow"
            />
            <div className="hidden items-center justify-center lg:flex lg:flex-col lg:justify-center lg:gap-1">
              <span className="rounded-lg border border-ok/25 bg-ok-soft px-2.5 py-1 text-[11px] font-semibold text-ok">
                YES
              </span>
              <span aria-hidden className="h-6 w-px bg-line-2" />
              <span className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-3">
                NO
              </span>
            </div>
            <div className="rounded-xl3 border border-ok/20 bg-ok-soft/60 p-5">
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-ok" aria-hidden />
                <p className="text-[13px] font-semibold text-ink">
                  Actions
                </p>
                <Badge tone="success" className="ml-auto">
                  automated
                </Badge>
              </div>
              <ul className="mt-3 space-y-2 text-[13px] font-medium text-ink-2">
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-3.5 w-3.5 text-ok" aria-hidden />
                  Send product information
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-3.5 w-3.5 text-ok" aria-hidden />
                  Send order link
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-3.5 w-3.5 text-ok" aria-hidden />
                  Schedule follow-up
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-3.5 w-3.5 text-ok" aria-hidden />
                  Notify sales for high-intent leads
                </li>
              </ul>
            </div>
          </div>

          <p className="mt-5 text-center text-[13px] text-ink-3">
            {steps[3].type}: {steps[3].title} — {steps[3].desc}
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="mt-10 flex flex-col items-center gap-3">
          <p className="text-sm text-ink-2">{content.bottom_note}</p>
          <Button href="/dashboard/login" variant="secondary" size="sm">
            Try the builder
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}

function NodeCard({
  type,
  title,
  desc,
  Icon,
  tone,
}: {
  type: string;
  title: string;
  desc: string;
  Icon: typeof Zap;
  tone: "brand" | "ai" | "flow";
}) {
  const tones = {
    brand: "border-brand/20 bg-brand-soft text-brand-2",
    ai: "border-ai/20 bg-ai-soft text-ai",
    flow: "border-flow/25 bg-flow-soft text-cyan-700",
  } as const;
  return (
    <div className="rounded-xl3 border border-line bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border ${tones[tone]}`}
        >
          <Icon className="h-4.5 w-4.5" />
        </span>
        <Badge tone={tone === "flow" ? "flow" : tone}>{type}</Badge>
      </div>
      <p className="mt-3.5 text-[15px] font-semibold text-ink">{title}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{desc}</p>
    </div>
  );
}
