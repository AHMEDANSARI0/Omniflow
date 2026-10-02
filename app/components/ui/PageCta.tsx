import { ArrowRight } from "lucide-react";
import type { PageCta as PageCtaCopy } from "../../../lib/marketing/pages";
import { SITE_ROUTES } from "../../../lib/marketing/site";
import Reveal from "../Reveal";
import Button from "./Button";
import Container from "./Container";

/**
 * Closing call to action for inner pages: a light brand-tinted panel
 * (replaces the old dark bands). Copy from lib/marketing/pages.
 */
export default function PageCta({ cta }: { cta: PageCtaCopy }) {
  return (
    <section aria-labelledby="page-cta-title" className="bg-white">
      <Container wide className="py-[var(--section-spacing,6rem)]">
        <Reveal>
          <div className="relative overflow-hidden rounded-[28px] border border-brand/15 bg-[linear-gradient(180deg,#F5F4FF_0%,#FFFFFF_75%)] px-6 py-14 text-center shadow-card sm:px-12 sm:py-16">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_60%_at_50%_0%,rgba(99,91,255,0.14),transparent_70%)]" />
            <div className="relative mx-auto max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
                {cta.eyebrow}
              </p>
              <h2
                id="page-cta-title"
                className="mt-4 text-balance font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.025em] text-ink sm:text-[40px]"
              >
                {cta.title}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-ink-2">{cta.copy}</p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button href={SITE_ROUTES.start} size="lg">
                  {cta.primary}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
                {cta.secondary ? (
                  <Button href={cta.secondary.href} variant="secondary" size="lg">
                    {cta.secondary.label}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
