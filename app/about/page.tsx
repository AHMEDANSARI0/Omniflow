import type { Metadata } from "next";
import { ArrowRight, Compass, Eye, HandHeart, Map } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section, { SectionHead } from "../components/ui/Section";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "About",
  description:
    "OmniFlow is building the automation layer for modern customer conversations — WhatsApp first, multi-channel by design, human-controlled always.",
};

const VALUES = [
  {
    Icon: Compass,
    title: "Product philosophy",
    copy: "Software for business owners, not developers. If you can use WhatsApp, you can run OmniFlow — no code, no consultants, no six-week onboarding.",
  },
  {
    Icon: Eye,
    title: "Transparent by default",
    copy: "No black boxes. Every AI decision and automation step is visible: why a lead was qualified, why a follow-up was sent, where a conversation went.",
  },
  {
    Icon: HandHeart,
    title: "Humans stay in control",
    copy: "AI does the repetitive work; people do the human work. Handoffs are one click, with the full conversation in front of you.",
  },
  {
    Icon: Map,
    title: "Where we're going",
    copy: "WhatsApp is live today. Instagram, Messenger, Telegram and TikTok plug into the same intelligence layer as OmniFlow expands — one brain, every channel.",
  },
];

export default function AboutPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="About OmniFlow"
        title={
          <>
            Building the automation layer for{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              modern customer conversations.
            </em>
          </>
        }
        copy="We started OmniFlow with a simple observation: small businesses lose customers not because they don't care, but because the message arrived at 11pm."
      />

      <Section tone="white">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[34px]">
              Why OmniFlow exists
            </h2>
            <p className="mt-5 text-base leading-relaxed text-ink-2">
              In Pakistan and across the world, commerce happens in chat. A
              customer messages, expects an answer in minutes, and buys from
              whoever replies first. Meanwhile the owner is packing orders,
              managing staff and answering the same six questions for the
              hundredth time.
            </p>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              Existing tools made businesses choose: a dumb keyword bot that
              customers hate, or an expensive enterprise platform built for
              companies with integration budgets. Neither fits a business
              that runs on WhatsApp and common sense.
            </p>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              OmniFlow is the missing layer: AI that understands the message,
              applies your business context and runs the workflow — replies,
              order links, follow-ups, routing — while you and your team stay
              in control of every conversation.
            </p>
          </Reveal>

          <Reveal>
            <div className="mt-10 rounded-xl3 border border-line bg-soft p-6">
              <p className="text-[13px] font-semibold uppercase tracking-[0.16em] text-ink-3">
                The one-line story
              </p>
              <p className="mt-3 font-display text-xl font-semibold leading-snug text-ink sm:text-2xl">
                Customer messages → OmniFlow understands → context applied →
                workflow decides → action runs → human takes over when it
                matters.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section tone="canvas">
        <SectionHead
          eyebrow="What we're building"
          title="Principles that shape the product."
          copy="Four commitments that decide what ships and what doesn't."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {VALUES.map(({ Icon, title, copy }) => (
            <Reveal key={title} lift>
              <Card className="h-full p-6">
                <span
                  aria-hidden
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-[15px] font-semibold text-ink">
                  {title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                  {copy}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section tone="night" className="text-center">
        <SectionHead
          dark
          eyebrow="Early access"
          title="Help us build the layer."
          copy="We're onboarding our first businesses now — and shaping the roadmap around how they actually work."
        />
        <div className="mt-8">
          <Button href="/dashboard/login" variant="dark" size="lg">
            Get Started
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </Section>
    </PageShell>
  );
}
