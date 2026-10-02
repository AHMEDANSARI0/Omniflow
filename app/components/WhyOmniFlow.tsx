import { Clock, GitBranch, Layers, UserCheck } from "lucide-react";
import type { WhyOmniFlowContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import { WHY_OMNIFLOW_STATES } from "../../lib/marketing/sections";

/**
 * The editorial "why" — four principles as numbered editorial rows
 * with small state visuals. Server component.
 */
export default function WhyOmniFlow({
  content,
}: {
  content: WhyOmniFlowContent;
}) {
  const blocks = [
    { title: content.b1_title, desc: content.b1_desc, Icon: Clock },
    { title: content.b2_title, desc: content.b2_desc, Icon: GitBranch },
    { title: content.b3_title, desc: content.b3_desc, Icon: UserCheck },
    { title: content.b4_title, desc: content.b4_desc, Icon: Layers },
  ]
    .map((block, index) => ({ ...block, state: WHY_OMNIFLOW_STATES[index] ?? "" }))
    .filter((block) => block.title.trim());

  return (
    <Section id="why-omniflow" tone="canvas">
      <SectionHead
        align="left"
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
          </>
        }
        copy={content.description}
      />

      <div className="mt-12 divide-y divide-line border-y border-line">
        {blocks.map(({ title, desc, Icon, state }, index) => (
          <Reveal key={title}>
            <div className="grid items-center gap-5 py-7 sm:grid-cols-[auto_1fr_auto] sm:gap-8">
              <span className="font-display text-sm font-semibold text-ink-2">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="max-w-2xl">
                <h3 className="flex items-center gap-3 font-display text-xl font-semibold text-ink">
                  <span
                    aria-hidden
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand/15 bg-brand-soft text-brand"
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  {title}
                </h3>
                <p className="mt-2 pl-12 text-[14.5px] leading-relaxed text-ink-2">
                  {desc}
                </p>
              </div>
              <span className="hidden rounded-full border border-line bg-white px-3.5 py-1.5 text-[11.5px] font-semibold text-ink-2 sm:inline-block">
                {state}
              </span>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
