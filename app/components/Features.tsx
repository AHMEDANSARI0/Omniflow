import type { FeaturesContent } from "../../lib/content-defaults";
import { CAPABILITY_ICONS, FEATURE_VISUALS } from "../../lib/marketing/sections";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";
import Icon from "./ui/Icon";
import FeatureVisual from "./home/FeatureVisual";

/**
 * Capabilities (§216): the two headline features as alternating
 * text/visual rows, the next four as a bento grid, then the capability
 * chips (12 categories in total). CMS copy (site_content.features),
 * visuals from lib/marketing/sections. Server component.
 */
export default function Features({ content }: { content: FeaturesContent }) {
  const features = [
    { title: content.f1_title, desc: content.f1_desc },
    { title: content.f2_title, desc: content.f2_desc },
    { title: content.f3_title, desc: content.f3_desc },
    { title: content.f4_title, desc: content.f4_desc },
    { title: content.f5_title, desc: content.f5_desc },
    { title: content.f6_title, desc: content.f6_desc },
  ]
    .map((feature, index) => ({ ...feature, visual: FEATURE_VISUALS[index] }))
    .filter((feature) => feature.title.trim());
  const headline = features.slice(0, 2);
  const grid = features.slice(2);
  const capabilities = content.capabilities
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <Section id="features" tone="canvas" labelledBy="features-title">
      <Reveal>
        <SectionHead
          id="features-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <div className="mt-14 space-y-5">
        {headline.map((feature, index) => (
          <Reveal key={feature.title}>
            <article className="grid items-center gap-8 rounded-xl3 border border-line bg-white p-6 shadow-card sm:p-8 lg:grid-cols-2 lg:gap-12 lg:p-10">
              <div className={index % 2 === 1 ? "lg:order-2" : ""}>
                <p className="font-display text-xs font-semibold tabular-nums text-brand-2">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-2 font-display text-2xl font-semibold tracking-[-0.015em] text-ink sm:text-[28px]">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ink-2">{feature.desc}</p>
              </div>
              <div className={index % 2 === 1 ? "lg:order-1" : ""}>
                {feature.visual ? <FeatureVisual kind={feature.visual} /> : null}
              </div>
            </article>
          </Reveal>
        ))}
      </div>

      {grid.length > 0 ? (
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          {grid.map((feature, index) => (
            <Reveal key={feature.title} lift className="h-full">
              <article className="flex h-full flex-col rounded-xl3 border border-line bg-white shadow-card p-6 sm:p-7">
                <p className="font-display text-xs font-semibold tabular-nums text-brand-2">
                  {String(index + 3).padStart(2, "0")}
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold text-ink">{feature.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{feature.desc}</p>
                <div className="mt-6 flex-1">
                  {feature.visual ? <FeatureVisual kind={feature.visual} /> : null}
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      ) : null}

      {capabilities.length > 0 ? (
        <Reveal>
          <ul className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {capabilities.map((capability, index) => (
              <li
                key={capability}
                className="flex flex-col items-start gap-2.5 rounded-xl2 border border-line bg-white p-4 text-[13.5px] font-semibold text-ink"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon name={CAPABILITY_ICONS[index % CAPABILITY_ICONS.length]} className="h-4 w-4" />
                </span>
                {capability}
              </li>
            ))}
          </ul>
        </Reveal>
      ) : null}
    </Section>
  );
}
