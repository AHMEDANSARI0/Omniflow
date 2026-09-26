import type { Metadata } from "next";
import { ArrowRight, Mail, MessageCircle } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";
import { getSectionContent } from "../../lib/content";
import { FAQ_DEFAULTS } from "../../lib/content-defaults";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Questions about OmniFlow, early access or custom automation? Write to us — we reply like a business that cares about reply time.",
};

export default async function ContactPage() {
  const faq = await getSectionContent("faq", FAQ_DEFAULTS);
  const email = faq.contact_email || "hello@omniflow.example.com";

  return (
    <PageShell>
      <PageHero
        eyebrow="Contact"
        title={
          <>
            Talk to a{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              human.
            </em>
          </>
        }
        copy="Questions about early access, custom automation or how OmniFlow would fit your business — we answer quickly. It would be embarrassing if we didn't."
      />

      <Section tone="canvas">
        <div className="mx-auto grid max-w-4xl gap-5 sm:grid-cols-2">
          <Reveal lift>
            <Card className="h-full p-7">
              <span
                aria-hidden
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
              >
                <Mail className="h-5 w-5" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                Email us
              </h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                Best for product questions, early access and custom
                automation requests.
              </p>
              <a
                href={"mailto:" + email}
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-2"
              >
                {email}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            </Card>
          </Reveal>

          <Reveal lift>
            <Card gradientRing className="h-full p-7">
              <span
                aria-hidden
                className="of-gradient inline-flex h-10 w-10 items-center justify-center rounded-xl2"
              >
                <MessageCircle className="h-5 w-5 text-white" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                See it on WhatsApp first
              </h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                The fastest way to understand OmniFlow is to watch it answer.
                Join early access and we&apos;ll walk you through it on the
                channel your customers already use.
              </p>
              <div className="mt-4">
                <Button href="/dashboard/login" size="sm">
                  Get Started
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </Card>
          </Reveal>
        </div>
      </Section>
    </PageShell>
  );
}
