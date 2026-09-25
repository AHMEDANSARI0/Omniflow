import { ArrowRight, Check } from "lucide-react";
import type { FinalCtaContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Button from "./ui/Button";
import Container from "./ui/Container";

/**
 * The final CTA — the one intentional gradient moment of the page.
 * Server component.
 */
export default function FinalCTA({ content }: { content: FinalCtaContent }) {
  const notes = content.notes
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section id="get-started" className="relative overflow-hidden">
      <div className="of-cta-gradient">
        <Container className="py-20 text-center sm:py-24 lg:py-28">
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">
              {content.badge}
            </p>
          </Reveal>
          <Reveal>
            <h2 className="mx-auto mt-4 max-w-3xl font-display text-[36px] font-semibold leading-[1.08] tracking-[-0.02em] text-white sm:text-[46px] lg:text-[54px]">
              {content.heading_line1} {content.heading_line2}.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/85 sm:text-lg">
              {content.description}
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button href="/dashboard/login" variant="dark" size="lg">
                {content.primary_button}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                href="/#how-it-works"
                variant="night-outline"
                size="lg"
                className="border-white/40"
              >
                {content.secondary_button}
              </Button>
            </div>
          </Reveal>
          {notes.length > 0 ? (
            <Reveal>
              <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                {notes.map((note) => (
                  <span
                    key={note}
                    className="inline-flex items-center gap-2 text-[13px] font-medium text-white/80"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    {note}
                  </span>
                ))}
              </div>
            </Reveal>
          ) : null}
        </Container>
      </div>
    </section>
  );
}
