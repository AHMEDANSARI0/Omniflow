import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section, { SectionHead } from "../components/ui/Section";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";
import Features from "../components/Features";
import DashboardShowcase from "../components/DashboardShowcase";
import { ArrowRight, Check } from "lucide-react";

export const metadata: Metadata = {
  title: "Features",
  description:
    "AI conversations, lead qualification, automated follow-ups, intelligent routing, visual workflows and multi-channel automation — one platform.",
};

const PILLARS = [
  {
    eyebrow: "Understand",
    title: "AI that reads the conversation, not keywords",
    copy: "Every message is parsed for intent, sentiment and language in the customer's own words — Roman Urdu included — so replies answer what was actually asked.",
    points: [
      "Intent detection on natural messages",
      "Sentiment and language awareness",
      "Business knowledge applied to every answer",
    ],
  },
  {
    eyebrow: "Decide",
    title: "Your rules decide what happens next",
    copy: "Workflows turn understanding into action: conditions route high-intent buyers to sales, support questions get instant answers, follow-ups run on schedule.",
    points: [
      "Visual trigger -> AI -> condition -> action builder",
      "Routing by intent, value or team",
      "Automated follow-ups and reminders",
    ],
  },
  {
    eyebrow: "Stay in control",
    title: "Humans step in exactly when it matters",
    copy: "Automation never locks your team out. Any conversation can be taken over with full context, and every AI action is visible in the activity trail.",
    points: [
      "One-click human handoff",
      "Transparent automation activity",
      "You define what the AI may say and do",
    ],
  },
];

export default async function FeaturesPage() {
  const { getSectionContent } = await import("../../lib/content");
  const { FEATURES_DEFAULTS } = await import("../../lib/content-defaults");
  const featuresContent = await getSectionContent("features", FEATURES_DEFAULTS);

  return (
    <PageShell>
      <PageHero
        eyebrow="Features"
        title={
          <>
            One platform for{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              intelligent conversations
            </em>{" "}
            and automation.
          </>
        }
        copy="Everything OmniFlow does, from understanding a message to running the workflow behind it — built for businesses that live on WhatsApp today and plan to be everywhere tomorrow."
      >
        <div className="flex flex-wrap gap-3">
          <Button href="/dashboard/login">
            Get Started
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button href="/use-cases" variant="secondary">
            Explore use cases
          </Button>
        </div>
      </PageHero>

      <Section tone="white">
        <div className="space-y-20">
          {PILLARS.map((pillar, index) => (
            <Reveal key={pillar.eyebrow}>
              <div
                className={`grid items-center gap-10 lg:grid-cols-2 ${
                  index % 2 === 1 ? "lg:[&>*:first-child]:order-2" : ""
                }`}
              >
                <div>
                  <Badge tone="brand">{pillar.eyebrow}</Badge>
                  <h2 className="mt-4 font-display text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[34px]">
                    {pillar.title}
                  </h2>
                  <p className="mt-4 text-base leading-relaxed text-ink-2">
                    {pillar.copy}
                  </p>
                  <ul className="mt-5 space-y-2.5">
                    {pillar.points.map((point) => (
                      <li
                        key={point}
                        className="flex items-start gap-2.5 text-[14.5px] font-medium text-ink-2"
                      >
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
                <Card className="p-6">
                  <div className="of-dot-grid rounded-xl2 border border-line bg-canvas p-5">
                    {index === 0 ? (
                      <div className="space-y-2">
                        <p className="w-fit rounded-xl rounded-tl-sm border border-line bg-white px-3 py-2 text-[12.5px] text-ink-2">
                          mujhe black hoodie medium mein chahiye, price?
                        </p>
                        <p className="ml-auto w-fit rounded-xl rounded-tr-sm border border-brand/20 bg-brand-soft px-3 py-2 text-[12.5px] font-medium text-brand-2">
                          Rs 4,500 — medium available hai. Order link bhej
                          deti hoon?
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1.5">
                          <Badge tone="ai">Intent: purchase</Badge>
                          <Badge tone="success">Stock: yes</Badge>
                        </div>
                      </div>
                    ) : index === 1 ? (
                      <div className="space-y-2.5">
                        {[
                          { node: "Trigger", label: "New WhatsApp message", tone: "border-line bg-white text-ink-2" },
                          { node: "AI", label: "High purchase intent", tone: "border-ai/25 bg-ai-soft text-ai" },
                          { node: "Action", label: "Order link + notify sales", tone: "border-ok/25 bg-ok-soft text-ok" },
                        ].map(({ node, label, tone }) => (
                          <div
                            key={node}
                            className={`flex items-center justify-between rounded-xl2 border px-3.5 py-2.5 text-[12.5px] font-medium ${tone}`}
                          >
                            <span>{label}</span>
                            <span className="rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-3">
                              {node}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between rounded-xl2 border border-line bg-white px-3.5 py-2.5 text-[12.5px]">
                          <span className="font-medium text-ink-2">Ahmed — returning customer</span>
                          <Badge tone="brand">AI</Badge>
                        </div>
                        <div className="flex items-center justify-between rounded-xl2 border border-ok/25 bg-ok-soft px-3.5 py-2.5 text-[12.5px]">
                          <span className="font-medium text-ok">Sana — escalated to you</span>
                          <span className="text-[10px] font-bold uppercase text-ok">Human</span>
                        </div>
                        <p className="pt-1 text-[11.5px] text-ink-3">
                          Every action visible — nothing runs in the dark.
                        </p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Features content={featuresContent} />

      <DashboardShowcase />

      <Section tone="night" className="text-center">
        <SectionHead
          dark
          eyebrow="Ready when you are"
          title="See OmniFlow on your own conversations."
          copy="Connect WhatsApp, add your business context and watch the first workflow run."
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
