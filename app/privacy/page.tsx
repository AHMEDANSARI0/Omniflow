import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How OmniFlow handles your data and your customers' conversations: ownership, minimization, access and control.",
};

const SECTIONS = [
  {
    title: "Your data belongs to your business",
    body: "Customer conversations, contacts and automation data that flow through OmniFlow belong to your business. We do not sell, share or use your data for anything other than operating the service for you.",
  },
  {
    title: "Data minimization",
    body: "OmniFlow processes what the automation needs: messages, contact identifiers, your business knowledge and workflow activity. Provider credentials are stored server-side and never exposed to the browser.",
  },
  {
    title: "Access control",
    body: "The portal runs on authenticated, server-side sessions. Every data query is scoped to your workspace, and team access is limited to the workspace you invite people into.",
  },
  {
    title: "AI transparency",
    body: "The AI only uses the business context you configure — products, policies, knowledge and tone. Every automated action leaves a visible trail you can audit. A human can take over any conversation at any time.",
  },
  {
    title: "Third-party processors",
    body: "To operate the product, OmniFlow uses infrastructure providers (hosting, database) and the channel or payment providers you connect (e.g. WhatsApp/Meta, JazzCash, Easypaisa, Twilio). Each processes data only to deliver the function you enabled.",
  },
  {
    title: "Deletion and control",
    body: "You can remove conversations, customers and knowledge from the portal at any time. Account-level deletion is available on request and removes your workspace data from production systems.",
  },
  {
    title: "Changes to this policy",
    body: "As OmniFlow evolves, this page will reflect what changed and when. Material changes will be announced before they take effect.",
  },
];

export default function PrivacyPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="Privacy"
        title={
          <>
            Your customers&apos; data{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              stays yours.
            </em>
          </>
        }
        copy="Plain-language answers on how OmniFlow stores, uses and protects business and customer data."
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
              Last updated: September 2026 · Questions? Use the contact page.
            </p>
          </Reveal>
        </div>
      </Section>
    </PageShell>
  );
}
