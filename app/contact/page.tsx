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
import { SITE_ROUTES } from "../../lib/marketing/site";
import { getCopy } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Questions about OmniFlow, early access or custom automation? Write to us and we will reply quickly.",
  alternates: { canonical: "/contact" },
};

export default async function ContactPage() {
  const [faq, heroes, pagesCopy] = await Promise.all([
    getSectionContent("faq", FAQ_DEFAULTS),
    getCopy("page_heroes"),
    getCopy("other_pages"),
  ]);
  const cards = pagesCopy.contact;
  const email = faq.contact_email || FAQ_DEFAULTS.contact_email;

  return (
    <PageShell>
      <PageHero hero={heroes.contact} />

      <Section tone="canvas">
        <div className="mx-auto grid max-w-4xl gap-5 sm:grid-cols-2">
          <Reveal lift className="h-full">
            <Card className="h-full p-7">
              <span
                aria-hidden
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand"
              >
                <Mail className="h-5 w-5" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">{cards.email.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{cards.email.copy}</p>
              <a
                href={"mailto:" + email}
                className="mt-4 inline-flex items-center gap-2 rounded text-sm font-semibold text-brand-2 hover:text-brand"
              >
                {email}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            </Card>
          </Reveal>

          <Reveal lift className="h-full">
            <Card gradientRing className="h-full p-7">
              <span
                aria-hidden
                className="of-gradient inline-flex h-11 w-11 items-center justify-center rounded-xl2"
              >
                <MessageCircle className="h-5 w-5 text-white" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">{cards.demo.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{cards.demo.copy}</p>
              <div className="mt-5">
                <Button href={SITE_ROUTES.start} size="sm">
                  {cards.demo.cta}
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
