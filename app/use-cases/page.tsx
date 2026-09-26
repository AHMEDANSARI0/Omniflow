import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";
import UseCases from "../components/UseCases";

export const metadata: Metadata = {
  title: "Use cases",
  description:
    "E-commerce, service businesses, real estate, agencies and support teams — see how OmniFlow automates real customer conversations.",
};

export default async function UseCasesPage() {
  const { getSectionContent } = await import("../../lib/content");
  const { USE_CASES_DEFAULTS } = await import("../../lib/content-defaults");
  const useCasesContent = await getSectionContent("use_cases", USE_CASES_DEFAULTS);

  return (
    <PageShell>
      <PageHero
        eyebrow="Solutions"
        title={
          <>
            Built for the way{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              your business talks.
            </em>
          </>
        }
        copy="Every business has its own ten questions. OmniFlow learns your answers, your products and your policies — then runs the workflow behind them."
      >
        <Button href="/dashboard/login">
          Get Started
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </PageHero>

      <UseCases content={useCasesContent} />

      <Section tone="white" className="text-center">
        <Reveal>
          <h2 className="font-display text-[28px] font-semibold tracking-[-0.02em] text-ink sm:text-[34px]">
            Don&apos;t see your business here?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-ink-2">
            If your customers message you, OmniFlow can automate the pattern.
            Tell us how you work and we&apos;ll set up the first workflow
            with you.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button href="/dashboard/login">
              Get Started
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button href="/contact" variant="secondary">
              Talk to us
            </Button>
          </div>
        </Reveal>
      </Section>
    </PageShell>
  );
}
