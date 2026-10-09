import { ArrowRight, MessageCircleQuestion, Plus } from "lucide-react";
import type { FaqContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section from "./ui/Section";

/**
 * FAQ: native details/summary accordion (works without JS). The
 * page-level FAQ JSON-LD lives in app/page.tsx. Server component.
 */
export default function FAQ({ content }: { content: FaqContent }) {
  const pairs = [
    { q: content.q1, a: content.a1 },
    { q: content.q2, a: content.a2 },
    { q: content.q3, a: content.a3 },
    { q: content.q4, a: content.a4 },
    { q: content.q5, a: content.a5 },
    { q: content.q6, a: content.a6 },
  ].filter((pair) => pair.q.trim() && pair.a.trim());

  return (
    <Section id="faq" tone="canvas" labelledBy="faq-title">
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal
            as="p"
            className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
            {content.badge}
          </Reveal>
          <Reveal
            as="h2"
            className="mt-4 text-balance font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-ink sm:text-[42px]"
          >
            <span id="faq-title">
              {content.heading_line1}{" "}
              <span className="of-gradient bg-clip-text text-transparent">{content.heading_line2}</span>
            </span>
          </Reveal>
          <Reveal as="p" className="mt-4 text-base leading-relaxed text-ink-2">
            {content.description}
          </Reveal>
          <Reveal>
            <div className="mt-7 rounded-xl3 border border-line bg-white p-5 shadow-card">
              <p className="flex items-center gap-2.5 text-sm font-semibold text-ink">
                <MessageCircleQuestion className="h-[18px] w-[18px] text-brand" aria-hidden />
                {content.contact_text}
              </p>
              <a
                href={"mailto:" + content.contact_email}
                className="-my-1 mt-3 inline-flex items-center gap-2 rounded py-1 text-sm font-semibold text-brand-2 hover:text-brand hover:underline hover:underline-offset-4"
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
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl3 px-5 py-4 text-[15.5px] font-semibold text-ink transition-colors hover:bg-soft/60 [&::-webkit-details-marker]:hidden">
                  {q}
                  <span
                    aria-hidden
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-ink-2 transition-transform duration-300 group-open:rotate-45 group-open:border-brand/30 group-open:bg-brand-soft group-open:text-brand"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                </summary>
                <p className="px-5 pb-5 text-[14.5px] leading-relaxed text-ink-2">{a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
