import { ArrowRight } from "lucide-react";
import type { HowItWorksContent } from "../../lib/content-defaults";
import { HOW_IT_WORKS_MOCKUPS } from "../../lib/marketing/sections";
import { getCopy } from "../../lib/marketing/cms";
import { SITE_ROUTES } from "../../lib/marketing/site";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import Button from "./ui/Button";
import StepMockup from "./home/StepMockup";

/**
 * How it works (§216): four numbered steps (CMS copy), each with a
 * small CSS product mockup. Server component.
 */
export default async function HowItWorks({ content }: { content: HowItWorksContent }) {
  const section = (await getCopy("home_sections")).howItWorks;
  const steps = [
    { type: content.s1_type, title: content.s1_title, desc: content.s1_desc },
    { type: content.s2_type, title: content.s2_title, desc: content.s2_desc },
    { type: content.s3_type, title: content.s3_title, desc: content.s3_desc },
    { type: content.s4_type, title: content.s4_title, desc: content.s4_desc },
  ].filter((step) => step.title.trim());

  return (
    <Section id={section.id} tone="tint" labelledBy="how-title">
      <Reveal>
        <SectionHead
          id="how-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <ol className="mt-14 grid gap-5 md:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Reveal lift className="h-full">
              <article className="flex h-full flex-col gap-6 rounded-xl3 border border-line bg-white p-5 shadow-card sm:p-6 lg:flex-row lg:items-center">
                <div className="lg:w-[46%]">
                  <p className="flex items-center gap-2.5">
                    <span className="of-gradient-deep inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 font-display text-[12px] font-semibold tabular-nums text-white">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2">
                      {step.type}
                    </span>
                  </p>
                  <h3 className="mt-4 font-display text-xl font-semibold text-ink">{step.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{step.desc}</p>
                </div>
                <div className="lg:flex-1" aria-hidden>
                  <StepMockup kind={HOW_IT_WORKS_MOCKUPS[index] ?? "run"} />
                </div>
              </article>
            </Reveal>
          </li>
        ))}
      </ol>

      <Reveal className="mt-12 flex flex-col items-center gap-4 text-center">
        {content.bottom_note ? <p className="text-sm text-ink-2">{content.bottom_note}</p> : null}
        <Button href={SITE_ROUTES.start}>
          {section.cta}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </Reveal>
    </Section>
  );
}
