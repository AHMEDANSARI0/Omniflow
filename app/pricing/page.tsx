import type { Metadata } from "next";
import { ArrowRight, Bell, Check } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import StatusIndicator from "../components/ui/StatusIndicator";
import Reveal from "../components/Reveal";
import FAQ from "../components/FAQ";
import { getSectionContent } from "../../lib/content";
import { FAQ_DEFAULTS } from "../../lib/content-defaults";
import {
  PAGE_HEROES,
  PRICING_FEATURED_LABEL,
  PRICING_NOTE,
  PRICING_PLANS,
} from "../../lib/marketing/pages";
import { NAV_ACTIONS } from "../../lib/marketing/navigation";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "OmniFlow pricing is coming soon. Join early access for preferred terms and a guided setup.",
  alternates: { canonical: "/pricing" },
};

export default async function PricingPage() {
  const faqContent = await getSectionContent("faq", FAQ_DEFAULTS);

  return (
    <PageShell>
      <PageHero hero={PAGE_HEROES.pricing}>
        <Button href={NAV_ACTIONS.primary.href} size="lg">
          {NAV_ACTIONS.primary.label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </PageHero>

      <Section tone="white">
        <div className="grid gap-5 lg:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <Reveal key={plan.name} lift className="h-full">
              <Card
                gradientRing={plan.featured}
                className={`flex h-full flex-col p-7 ${plan.featured ? "shadow-card-hover" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-lg font-semibold text-ink">{plan.name}</h2>
                  {plan.featured ? (
                    <StatusIndicator label={PRICING_FEATURED_LABEL} tone="success" pulse />
                  ) : null}
                </div>
                <p className="mt-3 font-display text-[28px] font-semibold tracking-[-0.02em] text-ink">
                  {plan.price}
                </p>
                <p className="mt-2.5 text-[14px] leading-relaxed text-ink-2">{plan.description}</p>
                <ul className="mt-6 flex-1 space-y-2.5 border-t border-line pt-6">
                  {plan.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-[14px] font-medium text-ink-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
                <div className="mt-7">
                  <Button
                    href={plan.cta.href}
                    variant={plan.featured ? "primary" : "secondary"}
                    className="w-full"
                  >
                    {plan.cta.label}
                  </Button>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mx-auto mt-12 flex max-w-2xl items-start gap-3.5 rounded-xl3 border border-line bg-soft/60 p-5">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl2 border border-brand/15 bg-white text-brand"
            >
              <Bell className="h-5 w-5" />
            </span>
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="font-semibold text-ink">{PRICING_NOTE.lead}</span> {PRICING_NOTE.copy}
            </p>
          </div>
        </Reveal>
      </Section>

      <FAQ content={faqContent} />
    </PageShell>
  );
}
