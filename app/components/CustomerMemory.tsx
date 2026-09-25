import { BadgeCheck, History, Sparkles, Tag, UserRound } from "lucide-react";
import type { CustomerMemoryContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section from "./ui/Section";
import Badge from "./ui/Badge";

/**
 * Customer context: why an OmniFlow answer beats a generic chatbot
 * answer. A realistic profile card shows what the AI knows; the copy
 * explains why that matters. Server component with Reveal islands.
 */
export default function CustomerMemory({
  content,
}: {
  content: CustomerMemoryContent;
}) {
  const items = content.context_items
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <Section id="memory" tone="canvas">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <Reveal as="p" className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            {content.badge}
          </Reveal>
          <Reveal as="h2" className="mt-3 font-display text-[34px] font-semibold leading-[1.12] tracking-[-0.02em] text-ink sm:text-[40px] lg:text-[44px]">
            {content.heading_line1} {content.heading_line2}
          </Reveal>
          <Reveal as="p" className="mt-4 text-base leading-relaxed text-ink-2 sm:text-lg">
            {content.description}
          </Reveal>
          <Reveal>
            <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
              {items.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 rounded-xl2 border border-line bg-white px-3.5 py-2.5 text-[13px] font-medium text-ink-2 shadow-card"
                >
                  <BadgeCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal as="p" className="mt-6 text-sm text-ink-3">
            {content.bottom_note}
          </Reveal>
        </div>

        <Reveal lift>
          <div className="rounded-xl3 border border-line bg-white p-6 shadow-card-hover sm:p-7">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-3">
                Customer context
              </p>
              <Badge tone="success">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
                Context available
              </Badge>
            </div>

            <div className="mt-5 flex items-center gap-4">
              <span
                aria-hidden
                className="of-gradient inline-flex h-12 w-12 items-center justify-center rounded-full font-display text-base font-semibold text-white"
              >
                AK
              </span>
              <div>
                <p className="flex items-center gap-2 font-display text-base font-semibold text-ink">
                  Ahmed
                  <BadgeCheck className="h-4 w-4 text-ok" aria-hidden />
                </p>
                <p className="text-[13px] text-ink-2">Returning customer</p>
              </div>
            </div>

            <dl className="mt-6 space-y-3">
              <div className="flex items-center justify-between rounded-xl2 border border-line bg-soft px-4 py-3">
                <dt className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                  <Tag className="h-3.5 w-3.5 text-brand" aria-hidden />
                  Intent
                </dt>
                <dd className="text-[13px] font-semibold text-ink">
                  Product inquiry
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-xl2 border border-line bg-soft px-4 py-3">
                <dt className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                  <History className="h-3.5 w-3.5 text-brand" aria-hidden />
                  History
                </dt>
                <dd className="text-[13px] font-semibold text-ink">
                  12 conversations
                </dd>
              </div>
              <div className="rounded-xl2 border border-line bg-soft px-4 py-3">
                <dt className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                  <UserRound className="h-3.5 w-3.5 text-brand" aria-hidden />
                  Known context
                </dt>
                <dd className="mt-1.5 text-[13px] leading-relaxed text-ink">
                  Interested in the black hoodie · Asked about pricing last
                  week · Prefers evening delivery
                </dd>
              </div>
            </dl>

            <div className="mt-6 rounded-xl2 border border-brand/15 bg-brand-soft px-4 py-3.5">
              <p className="flex items-start gap-2 text-[13px] leading-relaxed text-brand-2">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                With this context, the reply already knows the product, the
                price and the customer — no questions needed.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
