import { ArrowRight, MessageCircleQuestion } from "lucide-react";
import type { FaqContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section from "./ui/Section";

/**
 * FAQ — native details/summary accordion (works without JS), same
 * design system. The page-level FAQ JSON-LD lives in app/page.tsx.
 * Server component.
 */
export default function FAQ({ content }: { content: FaqContent }) {
  const pairs = [
    { q: content.q1, a: content.a1 },
    { q: content.q2, a: content.a2 },
    { q: content.q3, a: content.a3 },
    { q: content.q4, a: content.a4 },
    { q: content.q5, a: content.a5 },
    { q: content.q6, a: content.a6 },
  ];

  return (
    <Section id="faq" tone="canvas">
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <Reveal as="p" className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            {content.badge}
          </Reveal>
          <Reveal as="h2" className="mt-3 font-display text-[34px] font-semibold leading-[1.12] tracking-[-0.02em] text-ink sm:text-[40px]">
            {content.heading_line1} {content.heading_line2}
          </Reveal>
          <Reveal as="p" className="mt-4 text-base leading-relaxed text-ink-2">
            {content.description}
          </Reveal>
          <Reveal>
            <div className="mt-7 rounded-xl3 border border-line bg-white p-5 shadow-card">
              <p className="flex items-center gap-2.5 text-sm font-medium text-ink">
                <MessageCircleQuestion className="h-4.5 w-4.5 text-brand" aria-hidden />
                {content.contact_text}
              </p>
              <a
                href={"mailto:" + content.contact_email}
                className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-2"
              >
                {content.contact_email}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            </div>
          </Reveal>
        </div>

        <div className="space-y-3">
          {pairs.map(({ q, a }) => (
            <Reveal key={q}>
              <details className="group rounded-xl3 border border-line bg-white shadow-card transition-colors open:border-brand/25">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-medium text-ink [&::-webkit-details-marker]:hidden">
                  {q}
                  <span
                    aria-hidden
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-ink-2 transition-transform duration-300 group-open:rotate-45 group-open:border-brand/30 group-open:text-brand"
                  >
                    +
                  </span>
                </summary>
                <p className="border-t border-line px-5 py-4 text-sm leading-relaxed text-ink-2">
                  {a}
                </p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
