import type { ReactNode } from "react";
import Container from "./Container";
import type { PageHeroCopy } from "../../../lib/marketing/pages";

/**
 * Shared inner-page hero: light canvas with the soft glow and a faint
 * grid, an eyebrow pill, a display title and supporting copy. Pass
 * `hero` (centralized copy) or explicit eyebrow/title/copy.
 */
export default function PageHero({
  hero,
  eyebrow,
  title,
  copy,
  children,
}: {
  hero?: PageHeroCopy;
  eyebrow?: string;
  title?: ReactNode;
  copy?: string;
  children?: ReactNode;
}) {
  const eyebrowText = hero?.eyebrow ?? eyebrow ?? "";
  const titleNode = hero ? (
    <>
      {hero.title}{" "}
      <span className="of-gradient bg-clip-text text-transparent">{hero.emphasis}</span>
      {hero.after ? <> {hero.after}</> : null}
    </>
  ) : (
    title
  );
  const copyText = hero?.copy ?? copy;

  return (
    <section className="of-hero-glow relative overflow-hidden">
      <div aria-hidden className="of-grid-fade pointer-events-none absolute inset-0 opacity-70" />
      <Container className="relative pb-16 pt-36 text-center sm:pb-20 sm:pt-40 lg:pt-44">
        <div className="mx-auto max-w-3xl">
          {eyebrowText ? (
            <p className="of-enter inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
              {eyebrowText}
            </p>
          ) : null}
          <h1
            className="of-enter mt-5 text-balance font-display text-[38px] font-semibold leading-[1.06] tracking-[-0.03em] text-ink sm:text-[52px] lg:text-[60px]"
            style={{ ["--of-delay" as string]: "60ms" }}
          >
            {titleNode}
          </h1>
          {copyText ? (
            <p
              className="of-enter mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-ink-2 sm:text-lg"
              style={{ ["--of-delay" as string]: "120ms" }}
            >
              {copyText}
            </p>
          ) : null}
          {children ? (
            <div
              className="of-enter mt-8 flex flex-wrap justify-center gap-3"
              style={{ ["--of-delay" as string]: "180ms" }}
            >
              {children}
            </div>
          ) : null}
        </div>
      </Container>
    </section>
  );
}
