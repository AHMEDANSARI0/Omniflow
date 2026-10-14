import { ArrowRight, Check, PlayCircle } from "lucide-react";
import type { FinalCtaContent } from "../../lib/content-defaults";
import { SITE_ROUTES, finalCtaVisualAsset } from "../../lib/marketing/site";
import Reveal from "./Reveal";
import Button from "./ui/Button";
import Container from "./ui/Container";
import AIVisual from "./hero/AIVisual";

/**
 * The final CTA (§216): a light, brand-tinted panel (no dark band) with
 * a soft glow. An optional AI visual slot (finalCtaVisualAsset) sits
 * above the heading when an asset is configured. Server component.
 */
export default function FinalCTA({ content }: { content: FinalCtaContent }) {
  const notes = content.notes
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section id="get-started" aria-labelledby="cta-title" className="bg-white">
      <Container wide className="py-[var(--section-spacing,6rem)]">
        <Reveal>
          <div className="relative overflow-hidden rounded-[32px] border border-brand/15 bg-[linear-gradient(180deg,#F5F4FF_0%,#FFFFFF_70%)] px-6 py-16 text-center shadow-card sm:px-12 sm:py-20 lg:py-24">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_55%_at_50%_0%,rgba(99,91,255,0.16),transparent_70%),radial-gradient(40%_40%_at_90%_100%,rgba(14,165,233,0.08),transparent_70%)]" />
            <div aria-hidden className="of-grid-fade pointer-events-none absolute inset-0 opacity-60" />

            <div className="relative mx-auto max-w-3xl">
              {finalCtaVisualAsset ? (
                <AIVisual asset={finalCtaVisualAsset} fallback={null} className="mb-6 max-w-[180px]" />
              ) : null}
              <p className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
                {content.badge}
              </p>
              <h2
                id="cta-title"
                className="mt-5 text-balance font-display text-[34px] font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[58px]"
              >
                {content.heading_line1}{" "}
                <span className="of-gradient bg-clip-text text-transparent">{content.heading_line2}</span>
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-ink-2 sm:text-lg">
                {content.description}
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Button href={SITE_ROUTES.start} size="lg">
                  {content.primary_button}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
                <Button href={SITE_ROUTES.howItWorks} variant="secondary" size="lg">
                  <PlayCircle className="h-4 w-4 text-brand" aria-hidden />
                  {content.secondary_button}
                </Button>
              </div>
              {notes.length > 0 ? (
                <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                  {notes.map((note) => (
                    <li key={note} className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-2">
                      <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
