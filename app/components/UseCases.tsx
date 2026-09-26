import { Bot, Check, CornerDownRight, UserRound } from "lucide-react";
import type { UseCasesContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

/**
 * Real-world automations per business type — every card shows a mini
 * conversation (customer -> AI -> action), not static icons.
 * Server component.
 */
export default function UseCases({
  content,
}: {
  content: UseCasesContent;
}) {
  const cases = [
    {
      label: content.u1_label,
      headline: content.u1_headline,
      desc: content.u1_desc,
      automations: content.u1_automations,
      status: content.u1_status,
      sample: { q: "Black hoodie medium available hai?", a: "Ji haan, medium available hai — order link bhej deti hoon." },
    },
    {
      label: content.u2_label,
      headline: content.u2_headline,
      desc: content.u2_desc,
      automations: content.u2_automations,
      status: content.u2_status,
      sample: { q: "Kal 5pm ki appointment chahiye", a: "Book ho gayi — reminder bhej dunga 4pm ko." },
    },
    {
      label: content.u3_label,
      headline: content.u3_headline,
      desc: content.u3_desc,
      automations: content.u3_automations,
      status: content.u3_status,
      sample: { q: "DHA me 2 bed budget?", a: "Aap ke budget range me 3 options hain — details bhejta hoon." },
    },
    {
      label: content.u4_label,
      headline: content.u4_headline,
      desc: content.u4_desc,
      automations: content.u4_automations,
      status: content.u4_status,
      sample: { q: "Aap ki services ke rates?", a: "Main aap ke requirement note kar ke team se connect kar raha hoon." },
    },
    {
      label: content.u5_label,
      headline: content.u5_headline,
      desc: content.u5_desc,
      automations: content.u5_automations,
      status: content.u5_status,
      sample: { q: "Order cancel karna hai", a: "Policy ke mutabiq ho sakta hai — aap ko human agent se mila raha hoon." },
    },
  ].map((item) => ({
    ...item,
    automations: item.automations.split("|").map((a) => a.trim()),
  }));

  return (
    <Section id="use-cases" tone="canvas">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      <div className="mt-14 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {cases.map(({ label, headline, desc, automations, status, sample }) => (
          <Reveal key={label} lift className="h-full">
            <Card className="flex h-full flex-col p-6">
              <Badge tone="brand">{label}</Badge>
              <h3 className="mt-4 font-display text-lg font-semibold leading-snug text-ink">
                {headline}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                {desc}
              </p>

              {/* the mini automation */}
              <div className="mt-5 space-y-1.5 rounded-xl2 border border-line bg-soft p-3.5">
                <p className="flex items-start gap-2 text-[11.5px] text-ink-2">
                  <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
                  {sample.q}
                </p>
                <p className="ml-auto flex w-fit items-start gap-2 rounded-lg border border-brand/20 bg-brand-soft px-2.5 py-1.5 text-[11.5px] font-medium text-brand-2">
                  <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {sample.a}
                </p>
              </div>

              <ul className="mt-5 space-y-2">
                {automations.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-[13px] font-medium text-ink-2">
                    <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>

              <p className="mt-auto flex items-center gap-2 pt-5 text-[12px] font-semibold text-ok">
                <Check className="h-3.5 w-3.5" aria-hidden />
                {status}
              </p>
            </Card>
          </Reveal>
        ))}

        {/* the "your business" tile */}
        <Reveal lift className="h-full">
          <Card gradientRing className="flex h-full flex-col items-start justify-center p-7">
            <Badge tone="ai">Your business</Badge>
            <h3 className="mt-4 font-display text-xl font-semibold leading-snug text-ink">
              Whatever your customers ask — OmniFlow learns your answers.
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
              Your products, your policies, your tone. The automation adapts
              to the way your business talks.
            </p>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}
