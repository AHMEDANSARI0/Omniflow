import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms that govern the use of OmniFlow: accounts, acceptable use, AI responsibility and service evolution.",
};

const SECTIONS = [
  {
    title: "The service",
    body: "OmniFlow provides an AI customer conversation and automation platform, currently in early access. Features evolve, and we may adjust, add or retire capabilities as the product matures — material changes will be communicated.",
  },
  {
    title: "Your account",
    body: "You are responsible for the activity in your workspace, the accuracy of the business context you configure, and keeping access to your account secure. One workspace per business; team seats follow the plan terms.",
  },
  {
    title: "Acceptable use",
    body: "Do not use OmniFlow to send spam, harass customers, mislead people about being human when required by law, or run any business that violates applicable law or Meta's WhatsApp Business policies.",
  },
  {
    title: "AI responsibility",
    body: "OmniFlow automates replies and actions based on the context you provide. You remain responsible for the accuracy of that context and for reviewing automated behavior. Human handoff is always available and should be used where your customers need a person.",
  },
  {
    title: "Third-party services",
    body: "OmniFlow connects to providers you choose (e.g. WhatsApp/Meta, payment gateways, AI engines, Twilio). Those services have their own terms, and their availability or policy changes can affect the connected feature.",
  },
  {
    title: "Fees",
    body: "Pricing will be published before public launch. Early-access terms are confirmed with each participating business in writing.",
  },
  {
    title: "Liability",
    body: "To the maximum extent permitted by law, OmniFlow is provided \"as is\" during early access, and our liability is limited to the amount you paid for the service in the preceding three months. Nothing in these terms limits liability that cannot be limited by law.",
  },
  {
    title: "Contact",
    body: "Questions about these terms? Reach us through the contact page.",
  },
];

export default function TermsPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="Terms"
        title={
          <>
            Fair terms for a{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              shared job.
            </em>
          </>
        }
        copy="What you can expect from OmniFlow, and what OmniFlow expects from you — written to be read."
      />
      <Section tone="canvas">
        <div className="mx-auto max-w-3xl space-y-8">
          {SECTIONS.map(({ title, body }) => (
            <Reveal key={title}>
              <div className="rounded-xl3 border border-line bg-white p-6 shadow-card">
                <h2 className="font-display text-lg font-semibold text-ink">
                  {title}
                </h2>
                <p className="mt-2.5 text-[14px] leading-relaxed text-ink-2">
                  {body}
                </p>
              </div>
            </Reveal>
          ))}
          <Reveal>
            <p className="text-center text-xs text-ink-3">
              Last updated: September 2026
            </p>
          </Reveal>
        </div>
      </Section>
    </PageShell>
  );
}
