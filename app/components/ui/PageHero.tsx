import type { ReactNode } from "react";
import Container from "./Container";

/**
 * Shared inner-page hero: light canvas with the soft glow, eyebrow,
 * display title and supporting copy. Every marketing page opens the
 * same way — hierarchy by construction.
 */
export default function PageHero({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  copy?: string;
  children?: ReactNode;
}) {
  return (
    <section className="of-hero-glow relative overflow-hidden bg-canvas">
      <Container className="pb-14 pt-28 sm:pb-16 sm:pt-32 lg:pt-36">
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            {eyebrow}
          </p>
          <h1 className="mt-4 font-display text-[38px] font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-[50px] lg:text-[58px]">
            {title}
          </h1>
          {copy ? (
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
              {copy}
            </p>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>
      </Container>
    </section>
  );
}
