import {
  ArrowRight,
  Brain,
  Inbox,
  MessagesSquare,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import type { AiIntelligenceContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Badge from "./ui/Badge";

/**
 * The dark cinematic section: "Meet OmniFlow" — one intelligence layer.
 * Message -> Understand -> Context -> Decide -> Act, rendered as a
 * processing pipeline over the night surface with ambient glow.
 * Server component; Reveal islands only.
 */
export default function AIIntelligence({
  content,
}: {
  content: AiIntelligenceContent;
}) {
  const steps = [
    {
      title: content.i1_title,
      desc: content.i1_desc,
      tags: content.i1_tags.split(",").map((tag) => tag.trim()),
      Icon: Brain,
    },
    {
      title: content.i2_title,
      desc: content.i2_desc,
      tags: content.i2_tags.split(",").map((tag) => tag.trim()),
      Icon: Workflow,
    },
    {
      title: content.i3_title,
      desc: content.i3_desc,
      tags: content.i3_tags.split(",").map((tag) => tag.trim()),
      Icon: Zap,
    },
  ];

  const pipeline = [
    { label: "Message", Icon: Inbox },
    { label: "Understand", Icon: Brain },
    { label: "Context", Icon: MessagesSquare },
    { label: "Decide", Icon: Workflow },
    { label: "Act", Icon: Zap },
  ];

  return (
    <Section id="intelligence" tone="night" className="overflow-hidden">
      <SectionHead
        dark
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      {/* the processing pipeline */}
      <Reveal>
        <div className="mx-auto mt-14 max-w-4xl rounded-xl3 border border-white/10 bg-white/[0.04] p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-center gap-y-4">
            {pipeline.map(({ label, Icon }, index) => (
              <div key={label} className="flex items-center">
                <div className="flex flex-col items-center gap-2 px-3 sm:px-4">
                  <span
                    aria-hidden
                    className="of-gradient inline-flex h-11 w-11 items-center justify-center rounded-xl2 shadow-[0_8px_24px_-10px_rgba(124,58,237,0.7)]"
                  >
                    <Icon className="h-5 w-5 text-white" />
                  </span>
                  <span className="text-[12px] font-medium text-snow">
                    {label}
                  </span>
                </div>
                {index < pipeline.length - 1 ? (
                  <span
                    aria-hidden
                    className="mb-5 h-px w-6 bg-gradient-to-r from-indigo-400/70 to-violet-400/50 sm:w-10"
                  />
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-[13px] text-night-muted">
            The AI never acts blindly — intent, business knowledge and your
            rules decide every action.
          </p>
        </div>
      </Reveal>

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        {steps.map(({ title, desc, tags, Icon }, index) => (
          <Reveal key={title} lift>
            <div className="h-full rounded-xl3 border border-white/10 bg-white/[0.04] p-6 transition-colors duration-300 hover:border-white/20">
              <div className="flex items-center justify-between">
                <span
                  aria-hidden
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 border border-white/10 bg-white/[0.06] text-indigo-300"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="font-display text-sm font-semibold text-white/25">
                  0{index + 1}
                </span>
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold text-snow">
                {title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-night-muted">
                {desc}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} tone="night" className="!text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <p className="mx-auto mt-10 flex max-w-2xl items-center justify-center gap-2 text-center text-sm text-night-muted">
          <Sparkles className="h-4 w-4 shrink-0 text-indigo-300" aria-hidden />
          The same intelligence powers replies, qualification, routing and
          follow-ups.
          <ArrowRight className="h-4 w-4 shrink-0 text-indigo-300" aria-hidden />
        </p>
      </Reveal>
    </Section>
  );
}
