import { BadgeCheck, Sparkles, UserRound } from "lucide-react";
import type { CustomerMemoryContent } from "../../lib/content-defaults";
import { getCopy } from "../../lib/marketing/cms";
import Reveal from "./Reveal";
import Section from "./ui/Section";
import Icon from "./ui/Icon";
import StatusIndicator from "./ui/StatusIndicator";

/**
 * Customer context: why an OmniFlow answer beats a generic chatbot
 * answer. A sample profile card (lib/marketing/sections) shows what the
 * AI knows; CMS copy explains why it matters. Server component.
 */
export default async function CustomerMemory({ content }: { content: CustomerMemoryContent }) {
  const items = content.context_items
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  const profile = (await getCopy("home_mockups")).profile;

  return (
    <Section id="memory" tone="white" labelledBy="memory-title">
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <Reveal as="p"
            className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
            {content.badge}
          </Reveal>
          <Reveal as="h2"
            className="mt-4 text-balance font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-ink sm:text-[42px] lg:text-[50px]"
          >
            <span id="memory-title">
              {content.heading_line1}{" "}
              <span className="of-gradient bg-clip-text text-transparent">{content.heading_line2}</span>
            </span>
          </Reveal>
          <Reveal as="p" className="mt-4 text-pretty text-base leading-relaxed text-ink-2 sm:text-lg">
            {content.description}
          </Reveal>
          <Reveal>
            <ul className="mt-7 grid gap-2.5 sm:grid-cols-2">
              {items.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 rounded-xl2 border border-line bg-white px-3.5 py-2.5 text-[13.5px] font-medium text-ink-2 shadow-card"
                >
                  <BadgeCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>
          {content.bottom_note ? (
            <Reveal as="p" className="mt-6 text-sm text-ink-3">
              {content.bottom_note}
            </Reveal>
          ) : null}
        </div>

        <Reveal lift>
          <div className="relative">
            <div aria-hidden className="absolute -inset-6 rounded-[36px] bg-[radial-gradient(closest-side,rgba(99,91,255,0.12),transparent)]" />
            <div className="relative rounded-xl3 border border-line bg-white p-6 shadow-card-hover sm:p-7">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-3">{profile.heading}</p>
                <StatusIndicator label={profile.status} tone="success" />
              </div>

              <div className="mt-5 flex items-center gap-4">
                <span
                  aria-hidden
                  className="of-gradient-deep inline-flex h-12 w-12 items-center justify-center rounded-full font-display text-base font-semibold text-white"
                >
                  {profile.initials}
                </span>
                <div>
                  <p className="flex items-center gap-2 font-display text-base font-semibold text-ink">
                    {profile.name}
                    <BadgeCheck className="h-4 w-4 text-ok" aria-hidden />
                  </p>
                  <p className="text-[13px] text-ink-2">{profile.segment}</p>
                </div>
              </div>

              <dl className="mt-6 space-y-3">
                {profile.facts.map((fact) => (
                  <div
                    key={fact.label}
                    className="flex items-center justify-between rounded-xl2 border border-line bg-soft/50 px-4 py-3"
                  >
                    <dt className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                      <Icon name={fact.icon} className="h-3.5 w-3.5 text-brand" />
                      {fact.label}
                    </dt>
                    <dd className="text-[13px] font-semibold text-ink">{fact.value}</dd>
                  </div>
                ))}
                <div className="rounded-xl2 border border-line bg-soft/50 px-4 py-3">
                  <dt className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
                    <UserRound className="h-3.5 w-3.5 text-brand" aria-hidden />
                    {profile.knownLabel}
                  </dt>
                  <dd className="mt-1.5 text-[13px] leading-relaxed text-ink">{profile.known}</dd>
                </div>
              </dl>

              <div className="mt-6 rounded-xl2 border border-brand/15 bg-brand-soft px-4 py-3.5">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-brand-2">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                  {profile.insight}
                </p>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
