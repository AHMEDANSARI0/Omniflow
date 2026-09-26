import type { Metadata } from "next";
import {
  Eye,
  Hand,
  KeyRound,
  Lock,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How OmniFlow handles your data: server-side credentials, session-based access control, transparent automation and human handoff.",
};

const AREAS = [
  {
    Icon: KeyRound,
    title: "Credentials stay server-side",
    copy: "Provider keys (WhatsApp, gateways, AI engines) are stored on the server and never returned to the browser — the portal only ever sees masked values.",
  },
  {
    Icon: Lock,
    title: "Session-based access control",
    copy: "The portal runs on authenticated server sessions with httpOnly cookies. No tokens in browser storage, no client-side secrets.",
  },
  {
    Icon: UserCheck,
    title: "Workspace isolation",
    copy: "Every query is scoped to your workspace. Your conversations, customers and automation data are separated per account.",
  },
  {
    Icon: Hand,
    title: "Human handoff, always",
    copy: "Automation never locks you out. Any conversation can be taken over by a human at any moment — control is a feature, not a setting.",
  },
  {
    Icon: Eye,
    title: "Transparent automation",
    copy: "Every AI action leaves a visible trail: why a lead was qualified, what was sent, what ran. You can audit the system's behavior anytime.",
  },
  {
    Icon: ShieldCheck,
    title: "Your data stays yours",
    copy: "Customer conversations belong to your business. OmniFlow is built privacy-first: you define what the AI may use, and data is never sold or shared.",
  },
];

export default function SecurityPage() {
  return (
    <PageShell>
      <PageHero
        eyebrow="Security & trust"
        title={
          <>
            Automation{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              without losing control.
            </em>
          </>
        }
        copy="Handing customer conversations to software is a serious decision. Here is exactly how OmniFlow handles data, access and control — no vague promises."
      />

      <Section tone="canvas">
        <div className="grid gap-5 sm:grid-cols-2">
          {AREAS.map(({ Icon, title, copy }) => (
            <Reveal key={title} lift>
              <Card className="h-full p-6">
                <span
                  aria-hidden
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <h2 className="mt-4 text-[15px] font-semibold text-ink">
                  {title}
                </h2>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                  {copy}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-ink-3">
            We describe only what OmniFlow actually implements today. As the
            platform grows, this page grows with it — no certification
            badges before the audits behind them.
          </p>
        </Reveal>
      </Section>
    </PageShell>
  );
}
