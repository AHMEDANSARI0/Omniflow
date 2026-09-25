import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import FAQ from "../components/FAQ";
import { getSectionContent } from "../../lib/content";
import { FAQ_DEFAULTS } from "../../lib/content-defaults";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Answers about OmniFlow: pricing, setup time, supported channels, data security, human handoff and more.",
};

export default async function FaqPage() {
  const faqContent = await getSectionContent("faq", FAQ_DEFAULTS);

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: (
      [
        [faqContent.q1, faqContent.a1],
        [faqContent.q2, faqContent.a2],
        [faqContent.q3, faqContent.a3],
        [faqContent.q4, faqContent.a4],
        [faqContent.q5, faqContent.a5],
        [faqContent.q6, faqContent.a6],
      ] as const
    )
      .filter(([q, a]) => q.trim().length > 0 && a.trim().length > 0)
      .map(([q, a]) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
  };

  return (
    <PageShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <PageHero
        eyebrow={faqContent.badge}
        title={
          <>
            {faqContent.heading_line1}{" "}
            <em className="of-gradient bg-clip-text italic text-transparent">
              {faqContent.heading_line2}
            </em>
          </>
        }
        copy={faqContent.description}
      />
      <FAQ content={faqContent} />
    </PageShell>
  );
}
