import { Eye, Hand, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { TrustContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

/**
 * Automation without losing control — the honest trust section.
 * Only claims the product actually stands behind. Server component.
 */
export default function Trust({ content }: { content: TrustContent }) {
  const points = [
    { title: content.p1_title, desc: content.p1_desc, Icon: SlidersHorizontal },
    { title: content.p2_title, desc: content.p2_desc, Icon: Hand },
    { title: content.p3_title, desc: content.p3_desc, Icon: Eye },
    { title: content.p4_title, desc: content.p4_desc, Icon: ShieldCheck },
  ];
  const principles = content.principles
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <Section id="trust" tone="soft">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      <div className="mt-14 grid gap-5 sm:grid-cols-2">
        {points.map(({ title, desc, Icon }) => (
          <Reveal key={title} lift>
            <Card className="flex h-full gap-4 p-6">
              <span
                aria-hidden
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
              >
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
                  {desc}
                </p>
              </div>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
          {principles.map((item) => (
            <Badge key={item} tone="brand">
              {item}
            </Badge>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
