import { Bot, Check, CornerDownRight, UserRound } from "lucide-react";
import type { UseCasesContent } from "../../lib/content-defaults";
import { getMarketingList } from "../../lib/marketing/cms";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import StatusIndicator from "./ui/StatusIndicator";

/**
 * Solutions by business type (§216): alternating rows, each with the
 * CMS copy (site_content.use_cases), a sample conversation
 * (lib/marketing/pages) and the automations it runs. Each row has a
 * stable anchor (#use-case-N) used by the footer. Server component.
 */
export default async function UseCases({ content }: { content: UseCasesContent }) {
  const samples = await getMarketingList("use_case_samples");
  const cases = [
    { label: content.u1_label, headline: content.u1_headline, desc: content.u1_desc, automations: content.u1_automations, status: content.u1_status },
    { label: content.u2_label, headline: content.u2_headline, desc: content.u2_desc, automations: content.u2_automations, status: content.u2_status },
    { label: content.u3_label, headline: content.u3_headline, desc: content.u3_desc, automations: content.u3_automations, status: content.u3_status },
    { label: content.u4_label, headline: content.u4_headline, desc: content.u4_desc, automations: content.u4_automations, status: content.u4_status },
    { label: content.u5_label, headline: content.u5_headline, desc: content.u5_desc, automations: content.u5_automations, status: content.u5_status },
  ]
    .map((item, index) => ({
      ...item,
      anchor: `use-case-${index + 1}`,
      sample: samples[index],
      automations: item.automations.split("|").map((a) => a.trim()).filter(Boolean),
    }))
    .filter((item) => item.label.trim());

  return (
    <Section id="use-cases" tone="white" labelledBy="use-cases-title">
      <Reveal>
        <SectionHead
          id="use-cases-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <div className="mt-14 space-y-6">
        {cases.map((item, index) => (
          <Reveal key={item.anchor}>
            <article
              id={item.anchor}
              className="grid scroll-mt-28 items-center gap-8 rounded-xl3 border border-line bg-white p-6 shadow-card sm:p-8 lg:grid-cols-2 lg:gap-12 lg:p-10"
            >
              <div className={index % 2 === 1 ? "lg:order-2" : ""}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2">{item.label}</p>
                <h3 className="mt-3 text-balance font-display text-2xl font-semibold leading-snug tracking-[-0.015em] text-ink sm:text-[28px]">
                  {item.headline}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{item.desc}</p>
                <ul className="mt-5 space-y-2">
                  {item.automations.map((automation) => (
                    <li key={automation} className="flex items-start gap-2 text-[14px] font-medium text-ink-2">
                      <CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                      {automation}
                    </li>
                  ))}
                </ul>
              </div>

              <div className={index % 2 === 1 ? "lg:order-1" : ""}>
                <div className="rounded-xl3 border border-line bg-soft/70 p-5 [background-image:radial-gradient(22rem_14rem_at_100%_0%,rgba(99,91,255,0.07),transparent_70%)]">
                  {item.sample ? (
                    <div className="space-y-2.5">
                      <p className="flex max-w-[85%] items-start gap-2 rounded-2xl rounded-tl-sm border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink">
                        <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
                        {item.sample.q}
                      </p>
                      <p className="ml-auto flex w-fit max-w-[88%] items-start gap-2 rounded-2xl rounded-tr-sm bg-brand px-3.5 py-2.5 text-[13px] text-white shadow-cta">
                        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        {item.sample.a}
                      </p>
                    </div>
                  ) : null}
                  {item.status ? (
                    <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
                      <Check className="h-4 w-4 text-ok" aria-hidden />
                      <StatusIndicator label={item.status} tone="success" />
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
