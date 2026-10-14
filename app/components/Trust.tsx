import { Check, Eye, Hand, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { TrustContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import Card from "./ui/Card";

/**
 * Automation without losing control: the honest trust section (it
 * stands in for testimonials until there are real customer quotes).
 * Only claims the product actually stands behind. Server component.
 */
export default function Trust({ content }: { content: TrustContent }) {
  const points = [
    { title: content.p1_title, desc: content.p1_desc, Icon: SlidersHorizontal },
    { title: content.p2_title, desc: content.p2_desc, Icon: Hand },
    { title: content.p3_title, desc: content.p3_desc, Icon: Eye },
    { title: content.p4_title, desc: content.p4_desc, Icon: ShieldCheck },
  ].filter((point) => point.title.trim());
  const principles = content.principles
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <Section id="trust" tone="white" labelledBy="trust-title">
      <Reveal>
        <SectionHead
          id="trust-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <div className="mt-14 grid gap-5 sm:grid-cols-2">
        {points.map(({ title, desc, Icon }) => (
          <Reveal key={title} lift className="h-full">
            <Card className="flex h-full gap-4 p-6 sm:p-7">
              <span
                aria-hidden
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
              >
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-display text-[17px] font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{desc}</p>
              </div>
            </Card>
          </Reveal>
        ))}
      </div>

      {principles.length > 0 ? (
        <Reveal>
          <ul className="mt-10 flex flex-wrap items-center justify-center gap-2">
            {principles.map((item) => (
              <li
                key={item}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-soft px-3 py-1.5 text-[13px] font-medium text-ink-2"
              >
                <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>
      ) : null}
    </Section>
  );
}
