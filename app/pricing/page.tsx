import type { Metadata } from "next";
import { ArrowRight, Bell, Check } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "OmniFlow pricing is coming soon. Join early access for preferred terms and a guided setup.",
};

const PLANS = [
  {
    name: "Early access",
    price: "Coming soon",
    desc: "For the first businesses joining OmniFlow. Guided setup with our team and preferred early-access terms.",
    points: [
      "WhatsApp automation, live today",
      "AI conversations with your business context",
      "Visual workflows and follow-ups",
      "Personal onboarding",
    ],
    featured: true,
  },
  {
    name: "Business automation",
    price: "Coming soon",
    desc: "For teams running more conversations, more workflows and more channels as they open.",
    points: [
      "Everything in early access",
      "Team seats and routing",
      "Multi-channel as channels open",
      "Priority support",
    ],
    featured: false,
  },
  {
    name: "Custom automation",
    price: "Let's talk",
    desc: "For larger operations with unique workflows. We design the automation with you.",
    points: [
      "Custom workflow design",
      "Catalog and policy depth",
      "Volume-based terms",
    ],
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            Simple pricing,{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              announced soon.
            </em>
          </>
        }
        copy="We're finalizing pricing with our first customers in mind. Early-access members see it first — and get preferred terms."
      >
        <Button href="/dashboard/login">
          Join early access
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </PageHero>

      <Section tone="canvas">
        <div className="grid gap-5 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <Reveal key={plan.name} lift>
              <Card
                gradientRing={plan.featured}
                className={`flex h-full flex-col p-7 ${
                  plan.featured ? "" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-lg font-semibold text-ink">
                    {plan.name}
                  </h2>
                  {plan.featured ? <Badge tone="brand">Popular</Badge> : null}
                </div>
                <p className="mt-3 font-display text-[26px] font-semibold tracking-[-0.02em] text-ink">
                  {plan.price}
                </p>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  {plan.desc}
                </p>
                <ul className="mt-5 flex-1 space-y-2.5">
                  {plan.points.map((point) => (
                    <li
                      key={point}
                      className="flex items-start gap-2.5 text-[13.5px] font-medium text-ink-2"
                    >
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {plan.featured ? (
                    <Button href="/dashboard/login" className="w-full">
                      Get Started
                    </Button>
                  ) : (
                    <Button
                      href={plan.name === "Custom automation" ? "/contact" : "/dashboard/login"}
                      variant="secondary"
                      className="w-full"
                    >
                      {plan.name === "Custom automation" ? "Talk to us" : "Join early access"}
                    </Button>
                  )}
                </div>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mx-auto mt-12 flex max-w-2xl items-start gap-3.5 rounded-xl3 border border-line bg-white p-5 shadow-card">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
            >
              <Bell className="h-5 w-5" />
            </span>
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="font-semibold text-ink">No surprises:</span>{" "}
              pricing will be published before public launch, and early
              access members keep their preferred terms. Your data and your
              workflows stay yours either way.
            </p>
          </div>
        </Reveal>
      </Section>
    </PageShell>
  );
}
