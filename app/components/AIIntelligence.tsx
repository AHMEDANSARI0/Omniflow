import type { AiIntelligenceContent } from "../../lib/content-defaults";
import { STORY_NODES } from "../../lib/marketing/workflow";
import { STORY_SECTION } from "../../lib/marketing/sections";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import WorkflowNode from "./ui/WorkflowNode";

/*
 * Desktop snake layout: row 1 runs left -> right, row 2 runs right -> left,
 * so the path reads as one continuous flow. Static class strings keep
 * Tailwind able to see them.
 */
const PLACEMENT = [
  "lg:col-start-1 lg:row-start-1",
  "lg:col-start-2 lg:row-start-1",
  "lg:col-start-3 lg:row-start-1",
  "lg:col-start-3 lg:row-start-2",
  "lg:col-start-2 lg:row-start-2",
  "lg:col-start-1 lg:row-start-2",
];

function Connectors({ index, last }: { index: number; last: boolean }) {
  if (last) return null;
  return (
    <>
      {/* phones/tablets: vertical link to the next node */}
      <span
        aria-hidden
        className="of-connector of-connector-v absolute left-10 top-full h-5 w-[2px] lg:hidden"
      />
      {/* desktop */}
      {index < 2 ? (
        <span aria-hidden className="of-connector absolute left-full top-1/2 hidden h-[2px] w-12 lg:block" />
      ) : null}
      {index === 2 ? (
        <span aria-hidden className="of-connector of-connector-v absolute left-1/2 top-full hidden h-14 w-[2px] lg:block" />
      ) : null}
      {index > 2 ? (
        <span
          aria-hidden
          className="of-connector absolute right-full top-1/2 hidden h-[2px] w-12 [&::after]:[animation-direction:reverse] lg:block"
        />
      ) : null}
    </>
  );
}

/**
 * The OmniFlow core story (§216): connected workflow nodes from customer
 * message to automated action, then the three CMS-driven pillars
 * (Understand / Decide / Act). Server component; reveals are CSS.
 */
export default function AIIntelligence({ content }: { content: AiIntelligenceContent }) {
  const pillars = [
    { title: content.i1_title, desc: content.i1_desc, tags: content.i1_tags },
    { title: content.i2_title, desc: content.i2_desc, tags: content.i2_tags },
    { title: content.i3_title, desc: content.i3_desc, tags: content.i3_tags },
  ]
    .filter((pillar) => pillar.title.trim())
    .map((pillar) => ({
      ...pillar,
      tags: pillar.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    }));

  return (
    <Section id={STORY_SECTION.id} tone="white" labelledBy="story-title">
      <Reveal>
        <SectionHead
          id="story-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <div className="relative mt-16">
        <div aria-hidden className="of-grid-fade pointer-events-none absolute -inset-x-10 -inset-y-12 opacity-50" />
        <ol className="relative mx-auto grid max-w-xl gap-5 lg:max-w-none lg:grid-cols-3 lg:gap-x-12 lg:gap-y-14">
          {STORY_NODES.map((node, index) => (
            <li key={node.key} className={`relative ${PLACEMENT[index]}`}>
              <Reveal className="h-full">
                <WorkflowNode
                  index={index + 1}
                  icon={node.icon}
                  label={node.label}
                  description={node.description}
                  status={node.status}
                  highlight={index === STORY_NODES.length - 1}
                />
              </Reveal>
              <Connectors index={index} last={index === STORY_NODES.length - 1} />
            </li>
          ))}
        </ol>
      </div>

      <Reveal as="p" className="mx-auto mt-10 max-w-2xl text-center text-sm text-ink-3">
        {STORY_SECTION.footnote}
      </Reveal>

      {pillars.length > 0 ? (
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {pillars.map((pillar, index) => (
            <Reveal key={pillar.title} lift className="h-full">
              <div className="h-full rounded-xl3 border border-line bg-soft/60 p-6">
                <p className="font-display text-xs font-semibold tabular-nums text-brand-2">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold text-ink">{pillar.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{pillar.desc}</p>
                {pillar.tags.length > 0 ? (
                  <ul className="mt-4 flex flex-wrap gap-1.5">
                    {pillar.tags.map((tag) => (
                      <li
                        key={tag}
                        className="rounded-full border border-line bg-white px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2"
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Reveal>
          ))}
        </div>
      ) : null}
    </Section>
  );
}
