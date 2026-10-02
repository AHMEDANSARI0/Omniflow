import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import PageCta from "../components/ui/PageCta";
import Section, { SectionHead } from "../components/ui/Section";
import Card from "../components/ui/Card";
import Icon from "../components/ui/Icon";
import Reveal from "../components/Reveal";
import WhyOmniFlow from "../components/WhyOmniFlow";
import { getSectionContent } from "../../lib/content";
import { WHY_OMNIFLOW_DEFAULTS } from "../../lib/content-defaults";
import { getCopy, getMarketingList } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "About",
  description:
    "OmniFlow is building the automation layer for modern customer conversations: multi-channel by design, human-controlled always.",
  alternates: { canonical: "/about" },
};

export default async function AboutPage() {
  const [whyContent, heroes, ctas, aboutCopy, values] = await Promise.all([
    getSectionContent("why_omniflow", WHY_OMNIFLOW_DEFAULTS),
    getCopy("page_heroes"),
    getCopy("page_ctas"),
    getCopy("about_page"),
    getMarketingList("about_values"),
  ]);
  const { story, valuesHead } = aboutCopy;

  return (
    <PageShell>
      <PageHero hero={heroes.about} />

      <Section tone="white">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">
              {story.title}
            </h2>
            {story.paragraphs.map((paragraph, index) => (
              <p key={index} className="mt-5 text-base leading-relaxed text-ink-2 sm:text-[17px]">
                {paragraph}
              </p>
            ))}
          </Reveal>

          <Reveal>
            <div className="mt-10 rounded-xl3 border border-brand/15 bg-brand-soft/60 p-6 sm:p-7">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand-2">
                {story.oneLinerLabel}
              </p>
              <p className="mt-3 font-display text-xl font-semibold leading-snug text-ink sm:text-2xl">
                {story.oneLiner}
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      <WhyOmniFlow content={whyContent} />

      <Section tone="white">
        <Reveal>
          <SectionHead
            eyebrow={valuesHead.eyebrow}
            title={valuesHead.title}
            copy={valuesHead.copy}
          />
        </Reveal>
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {values.map((value, index) => (
            <Reveal key={index} lift className="h-full">
              <Card className="h-full p-6 sm:p-7">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                  <Icon name={value.icon} />
                </span>
                <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">{value.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{value.copy}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      <PageCta cta={ctas.about} />
    </PageShell>
  );
}
