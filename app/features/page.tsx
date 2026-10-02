import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import PageCta from "../components/ui/PageCta";
import Section from "../components/ui/Section";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";
import Features from "../components/Features";
import DashboardShowcase from "../components/DashboardShowcase";
import FeatureVisual from "../components/home/FeatureVisual";
import { getSectionContent } from "../../lib/content";
import { FEATURES_DEFAULTS } from "../../lib/content-defaults";
import { FEATURE_PILLARS, PAGE_CTAS, PAGE_HEROES } from "../../lib/marketing/pages";
import { NAV_ACTIONS } from "../../lib/marketing/navigation";

export const metadata: Metadata = {
  title: "Platform",
  description:
    "AI conversations, lead qualification, automated follow-ups, intelligent routing, visual workflows and multi-channel automation in one platform.",
  alternates: { canonical: "/features" },
};

export default async function FeaturesPage() {
  const featuresContent = await getSectionContent("features", FEATURES_DEFAULTS);
  const cta = PAGE_CTAS.features;

  return (
    <PageShell>
      <PageHero hero={PAGE_HEROES.features}>
        <Button href={NAV_ACTIONS.primary.href} size="lg">
          {NAV_ACTIONS.primary.label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
        {cta.secondary ? (
          <Button href={cta.secondary.href} variant="secondary" size="lg">
            {cta.secondary.label}
          </Button>
        ) : null}
      </PageHero>

      <Section tone="white">
        <div className="space-y-6">
          {FEATURE_PILLARS.map((pillar, index) => (
            <Reveal key={pillar.eyebrow}>
              <article className="grid items-center gap-10 rounded-xl3 border border-line bg-white p-6 shadow-card sm:p-8 lg:grid-cols-2 lg:gap-14 lg:p-10">
                <div className={index % 2 === 1 ? "lg:order-2" : ""}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2">{pillar.eyebrow}</p>
                  <h2 className="mt-3 text-balance font-display text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[32px]">
                    {pillar.title}
                  </h2>
                  <p className="mt-4 text-base leading-relaxed text-ink-2">{pillar.copy}</p>
                  <ul className="mt-5 space-y-2.5">
                    {pillar.points.map((point) => (
                      <li key={point} className="flex items-start gap-2.5 text-[14.5px] font-medium text-ink-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={index % 2 === 1 ? "lg:order-1" : ""}>
                  <FeatureVisual kind={pillar.visual} />
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      <Features content={featuresContent} />

      <DashboardShowcase />

      <PageCta cta={cta} />
    </PageShell>
  );
}
