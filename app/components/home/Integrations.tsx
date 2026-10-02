import { ArrowRight } from "lucide-react";
import { INTEGRATIONS, STATUS_META, type Integration } from "../../../lib/marketing/integrations";
import { INTEGRATIONS_SECTION } from "../../../lib/marketing/sections";
import { SITE_ROUTES } from "../../../lib/marketing/site";
import Reveal from "../Reveal";
import Section, { SectionHead } from "../ui/Section";
import Button from "../ui/Button";
import IntegrationCard, { IntegrationLogo } from "../ui/IntegrationCard";

function Pill({ integration, duplicate }: { integration: Integration; duplicate: boolean }) {
  return (
    <li
      data-duplicate={duplicate ? "true" : undefined}
      aria-hidden={duplicate || undefined}
      className="inline-flex shrink-0 items-center gap-2.5 rounded-full border border-line bg-white py-1.5 pl-1.5 pr-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
    >
      <IntegrationLogo integration={integration} size="sm" />
      <span className="text-[13.5px] font-semibold text-ink">{integration.name}</span>
      <span className="text-[11px] font-medium text-ink-3">{STATUS_META[integration.status].label}</span>
    </li>
  );
}

function MarqueeRow({ items, reverse = false }: { items: Integration[]; reverse?: boolean }) {
  return (
    <div className="of-marquee-wrap py-1.5">
      <ul className="of-marquee" data-reverse={reverse ? "true" : undefined}>
        {items.map((integration) => (
          <Pill key={integration.id} integration={integration} duplicate={false} />
        ))}
        {items.map((integration) => (
          <Pill key={`${integration.id}-copy`} integration={integration} duplicate />
        ))}
      </ul>
    </div>
  );
}

/**
 * Integrations (§216): two gentle marquee rows (pause on hover, static
 * under reduced motion) plus cards for what is available now. All data
 * from lib/marketing/integrations.ts.
 */
export default function Integrations() {
  const half = Math.ceil(INTEGRATIONS.length / 2);
  const rowA = INTEGRATIONS.slice(0, half);
  const rowB = INTEGRATIONS.slice(half);
  const available = INTEGRATIONS.filter((item) => item.status !== "soon").slice(0, 6);

  return (
    <Section id={INTEGRATIONS_SECTION.id} tone="white" labelledBy="integrations-title" className="overflow-hidden">
      <Reveal>
        <SectionHead
          id="integrations-title"
          eyebrow={INTEGRATIONS_SECTION.eyebrow}
          title={INTEGRATIONS_SECTION.title}
          copy={INTEGRATIONS_SECTION.copy}
        />
      </Reveal>

      <div className="mt-12 space-y-2">
        <MarqueeRow items={rowA} />
        <MarqueeRow items={rowB} reverse />
      </div>

      <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {available.map((integration) => (
          <li key={integration.id}>
            <Reveal className="h-full">
              <IntegrationCard integration={integration} />
            </Reveal>
          </li>
        ))}
      </ul>

      <div className="mt-10 text-center">
        <Button href={SITE_ROUTES.integrations} variant="secondary">
          {INTEGRATIONS_SECTION.cta}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </Section>
  );
}
