import type { Metadata } from "next";
import { ArrowRight, Check, Clock } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section, { SectionHead } from "../components/ui/Section";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "WhatsApp is live today. Instagram, Messenger, Telegram and TikTok plug into the same OmniFlow intelligence layer as the platform expands.",
};

const CHANNELS = [
  {
    name: "WhatsApp",
    short: "WA",
    status: "live" as const,
    desc: "The channel your customers already use. Connect your number and OmniFlow answers, qualifies and follows up automatically.",
    points: [
      "Incoming message automation",
      "Order links and checkout",
      "Human handoff with full context",
    ],
  },
  {
    name: "Instagram",
    short: "IG",
    status: "soon" as const,
    desc: "Direct messages become conversations in the same inbox, handled by the same AI with your catalog and tone.",
    points: [],
  },
  {
    name: "Facebook Messenger",
    short: "MS",
    status: "soon" as const,
    desc: "Page messages join the same intelligence layer — one workflow across every page.",
    points: [],
  },
  {
    name: "Telegram",
    short: "TG",
    status: "soon" as const,
    desc: "Community and support chats run through the same understanding and workflows.",
    points: [],
  },
  {
    name: "TikTok",
    short: "TT",
    status: "soon" as const,
    desc: "Comments and messages become conversations — coming as the platform expands.",
    points: [],
  },
];

export default function IntegrationsPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="Integrations"
        title={
          <>
            WhatsApp today.{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              Every channel tomorrow.
            </em>
          </>
        }
        copy="OmniFlow is built multi-channel from day one: one intelligence layer, one workflow system, one dashboard — new channels plug in without a redesign."
      >
        <div className="flex flex-wrap gap-3">
          <Button href="/dashboard/login">
            Connect WhatsApp
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button href="/faq" variant="secondary">
            How channels work
          </Button>
        </div>
      </PageHero>

      <Section tone="white">
        <div className="grid gap-5 lg:grid-cols-2">
          {CHANNELS.map(({ name, short, status, desc, points }) => (
            <Reveal key={name} lift>
              <Card
                className={`h-full p-6 ${status === "live" ? "border-ok/30" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3.5">
                    <span
                      aria-hidden
                      className={`inline-flex h-12 w-12 items-center justify-center rounded-xl2 border font-display text-sm font-bold ${
                        status === "live"
                          ? "border-ok/25 bg-ok-soft text-ok"
                          : "border-line bg-soft text-ink-3"
                      }`}
                    >
                      {short}
                    </span>
                    <h2 className="font-display text-lg font-semibold text-ink">
                      {name}
                    </h2>
                  </div>
                  {status === "live" ? (
                    <Badge tone="success">
                      <Check className="h-3 w-3" aria-hidden />
                      Live
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      <Clock className="h-3 w-3" aria-hidden />
                      Coming
                    </Badge>
                  )}
                </div>
                <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
                  {desc}
                </p>
                {points.length > 0 ? (
                  <ul className="mt-4 space-y-2">
                    {points.map((point) => (
                      <li
                        key={point}
                        className="flex items-start gap-2 text-[13px] font-medium text-ink-2"
                      >
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section tone="canvas" className="text-center">
        <SectionHead
          eyebrow="One layer"
          title="New channels. Same intelligence."
          copy="Your workflows, AI context and dashboard stay exactly the same — a new channel is a connection, not a migration."
        />
        <div className="mt-8">
          <Button href="/dashboard/login" size="lg">
            Get Started
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </Section>
    </PageShell>
  );
}
