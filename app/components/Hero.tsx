import { ArrowRight, PlayCircle } from "lucide-react";
import type { HeroContent } from "../../lib/content-defaults";
import { SITE_ROUTES } from "../../lib/marketing/site";
import { statusForChannel } from "../../lib/marketing/integrations";
import { getCopy, getMarketingList } from "../../lib/marketing/cms";
import Button from "./ui/Button";
import Container from "./ui/Container";
import { AvailabilityBadge } from "./ui/StatusIndicator";
import HeroVisual from "./hero/HeroVisual";

const delay = (ms: number) => ({ ["--of-delay" as string]: `${ms}ms` });

/**
 * The hero (§216): server-rendered, CSS-only entrance (no animation
 * library on first paint). Copy is CMS-driven (site_content.hero); the
 * visual is a reserved AI slot (see lib/marketing/site.ts). Channel
 * availability comes from the shared integrations data, so it stays
 * honest everywhere.
 */
export default async function Hero({ content }: { content: HeroContent }) {
  const [integrations, home] = await Promise.all([getMarketingList("integrations"), getCopy("home_sections")]);
  const channels = content.integrations
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return (
    <section className="of-hero-glow relative overflow-hidden" aria-labelledby="hero-title">
      <div aria-hidden className="of-grid-fade pointer-events-none absolute inset-0 opacity-60" />
      <Container wide className="relative pb-16 pt-32 sm:pb-20 sm:pt-36 lg:pb-24 lg:pt-44">
        <div className="grid items-center gap-14 lg:grid-cols-[1.04fr_0.96fr] lg:gap-8">
          <div className="text-center lg:text-left">
            <p
              className="of-enter inline-flex items-center gap-2 rounded-full border border-brand/15 bg-white/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
              {content.badge}
            </p>

            <h1
              id="hero-title"
              className="of-enter mt-6 text-balance font-display text-[42px] font-semibold leading-[1.03] tracking-[-0.035em] text-ink sm:text-[58px] lg:text-[68px] xl:text-[74px]"
              style={delay(60)}
            >
              {content.heading_line1}{" "}
              <span className="of-gradient bg-clip-text text-transparent">
                {content.heading_line2}
              </span>
            </h1>

            <p
              className="of-enter mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-ink-2 sm:text-lg lg:mx-0"
              style={delay(120)}
            >
              {content.description}
            </p>

            <div
              className="of-enter mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start"
              style={delay(180)}
            >
              <Button href={SITE_ROUTES.start} size="lg">
                {content.primary_button}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href={SITE_ROUTES.howItWorks} variant="secondary" size="lg">
                <PlayCircle className="h-4 w-4 text-brand" aria-hidden />
                {content.secondary_button}
              </Button>
            </div>

            {channels.length > 0 ? (
              <div className="of-enter mt-12" style={delay(260)}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-3">
                  {content.channels_label}
                </p>
                <ul className="mt-3.5 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  {channels.map((name) => (
                    <li
                      key={name}
                      className="inline-flex items-center gap-2 rounded-full border border-line bg-white/90 py-1 pl-3 pr-1.5 text-[13px] font-medium text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
                    >
                      {name}
                      <AvailabilityBadge status={statusForChannel(name, integrations)} size="xs" />
                    </li>
                  ))}
                </ul>
                <p className="mt-2.5 text-xs text-ink-3">{home.hero.channelsNote}</p>
              </div>
            ) : null}
          </div>

          <HeroVisual />
        </div>
      </Container>
    </section>
  );
}
