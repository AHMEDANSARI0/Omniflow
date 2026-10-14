import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Icon from "../components/ui/Icon";
import Reveal from "../components/Reveal";
import Trust from "../components/Trust";
import { getSectionContent } from "../../lib/content";
import { TRUST_DEFAULTS } from "../../lib/content-defaults";
import { getCopy, getMarketingList } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How OmniFlow handles your data: server-side credentials, session-based access control, transparent automation and human handoff.",
  alternates: { canonical: "/security" },
};

export default async function SecurityPage() {
  const [trustContent, heroes, areas, pagesCopy] = await Promise.all([
    getSectionContent("trust", TRUST_DEFAULTS),
    getCopy("page_heroes"),
    getMarketingList("security_areas"),
    getCopy("other_pages"),
  ]);

  return (
    <PageShell>
      <PageHero hero={heroes.security} />

      <Section tone="canvas">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {areas.map((area, index) => (
            <Reveal key={index} lift className="h-full">
              <Card className="h-full p-6">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                  <Icon name={area.icon} />
                </span>
                <h2 className="mt-4 font-display text-[16px] font-semibold text-ink">{area.title}</h2>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{area.copy}</p>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-ink-3">{pagesCopy.securityNote}</p>
        </Reveal>
      </Section>

      <Trust content={trustContent} />
    </PageShell>
  );
}
