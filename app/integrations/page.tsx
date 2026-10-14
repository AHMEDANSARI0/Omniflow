import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import PageCta from "../components/ui/PageCta";
import Section, { SectionHead } from "../components/ui/Section";
import Button from "../components/ui/Button";
import IntegrationCard from "../components/ui/IntegrationCard";
import Reveal from "../components/Reveal";
import MultiChannel from "../components/MultiChannel";
import { getSectionContent } from "../../lib/content";
import { MULTI_CHANNEL_DEFAULTS } from "../../lib/content-defaults";
import { INTEGRATION_CATEGORIES, STATUS_META } from "../../lib/marketing/integrations";
import { NAV_ACTIONS } from "../../lib/marketing/navigation";
import { getCopy, getMarketingList } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "WhatsApp, Telegram and website chat are live, Instagram is in early access, and more channels and tools plug into the same OmniFlow intelligence layer.",
  alternates: { canonical: "/integrations" },
};

export default async function IntegrationsPage() {
  const [multiChannel, integrations, heroes, ctas] = await Promise.all([
    getSectionContent("multi_channel", MULTI_CHANNEL_DEFAULTS),
    getMarketingList("integrations"),
    getCopy("page_heroes"),
    getCopy("page_ctas"),
  ]);
  const cta = ctas.integrations;
  const counts = (["live", "beta", "soon"] as const).map((status) => ({
    status,
    label: STATUS_META[status].label,
    count: integrations.filter((item) => item.status === status).length,
  }));

  return (
    <PageShell>
      <PageHero hero={heroes.integrations}>
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
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Integration status summary">
          {counts.map((item) => (
            <li
              key={item.status}
              className="rounded-full border border-line bg-soft px-3.5 py-1.5 text-[13px] font-medium text-ink-2"
            >
              <span className="font-semibold text-ink">{item.count}</span> {item.label}
            </li>
          ))}
        </ul>

        <div className="mt-14 space-y-16">
          {INTEGRATION_CATEGORIES.map((category) => {
            const items = integrations.filter((item) => item.category === category.key);
            if (items.length === 0) return null;
            return (
              <section key={category.key} aria-labelledby={`cat-${category.key}`}>
                <Reveal>
                  <SectionHead
                    align="left"
                    id={`cat-${category.key}`}
                    title={category.label}
                    copy={category.description}
                  />
                </Reveal>
                <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((integration) => (
                    <li key={integration.id}>
                      <Reveal className="h-full">
                        <IntegrationCard integration={integration} showPoints />
                      </Reveal>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </Section>

      <MultiChannel content={multiChannel} />

      <PageCta cta={cta} />
    </PageShell>
  );
}
