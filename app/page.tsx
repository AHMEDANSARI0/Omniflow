import type { Metadata } from "next";
import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import AIIntelligence from "./components/AIIntelligence";
import ProblemSolution from "./components/ProblemSolution";
import AutomationTemplates from "./components/home/AutomationTemplates";
import HowItWorks from "./components/HowItWorks";
import Integrations from "./components/home/Integrations";
import Features from "./components/Features";
import CustomerMemory from "./components/CustomerMemory";
import LiveDemo from "./components/home/LiveDemo";
import DashboardShowcase from "./components/DashboardShowcase";
import Trust from "./components/Trust";
import FAQ from "./components/FAQ";
import FinalCTA from "./components/FinalCTA";
import Footer from "./components/Footer";
import { getSectionContent } from "../lib/content";
import { getSiteSettings } from "../lib/settings";
import {
  HERO_DEFAULTS, FINAL_CTA_DEFAULTS, FOOTER_DEFAULTS, FEATURES_DEFAULTS, TRUST_DEFAULTS,
  PROBLEM_SOLUTION_DEFAULTS, AI_INTELLIGENCE_DEFAULTS,
  CUSTOMER_MEMORY_DEFAULTS, HOW_IT_WORKS_DEFAULTS, FAQ_DEFAULTS
} from "../lib/content-defaults";

/* Title / description / OG come from the root layout (site settings). */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/*
 * Homepage story (§216): hero -> core story -> problem/solution ->
 * templates -> how it works -> integrations -> capabilities -> customer
 * context -> live demo -> dashboard -> trust -> FAQ -> final CTA.
 * Use cases, multi-channel and "why OmniFlow" live on their own pages.
 */
export default async function Home() {
  const [
    heroContent,
    aiIntelligenceContent,
    howItWorksContent,
    finalCtaContent,
    featuresContent,
    trustContent,
    problemSolutionContent,
    customerMemoryContent,
    faqContent,
    footerContent,
  ] = await Promise.all([
    getSectionContent("hero", HERO_DEFAULTS),
    getSectionContent("ai_intelligence", AI_INTELLIGENCE_DEFAULTS),
    getSectionContent("how_it_works", HOW_IT_WORKS_DEFAULTS),
    getSectionContent("final_cta", FINAL_CTA_DEFAULTS),
    getSectionContent("features", FEATURES_DEFAULTS),
    getSectionContent("trust", TRUST_DEFAULTS),
    getSectionContent("problem_solution", PROBLEM_SOLUTION_DEFAULTS),
    getSectionContent("customer_memory", CUSTOMER_MEMORY_DEFAULTS),
    getSectionContent("faq", FAQ_DEFAULTS),
    getSectionContent("footer", FOOTER_DEFAULTS),
  ]);

  const siteSettings = await getSiteSettings();

  const faqEntries = (
    [
      [faqContent.q1, faqContent.a1],
      [faqContent.q2, faqContent.a2],
      [faqContent.q3, faqContent.a3],
      [faqContent.q4, faqContent.a4],
      [faqContent.q5, faqContent.a5],
      [faqContent.q6, faqContent.a6],
    ] as const
  ).filter(([q, a]) => q.trim().length > 0 && a.trim().length > 0);

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqEntries.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  const orgLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "OmniFlow",
    url: siteSettings.site_url,
    logo: siteSettings.site_url.replace(/\/$/, "") + "/icon",
  };

  return (
    <div className="of-site min-h-screen bg-canvas">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:text-brand focus:shadow-card"
      >
        Skip to content
      </a>
      <Navbar />
      <main id="main">
        <Hero content={heroContent} />
        <AIIntelligence content={aiIntelligenceContent} />
        <ProblemSolution content={problemSolutionContent} />
        <AutomationTemplates />
        <HowItWorks content={howItWorksContent} />
        <Integrations />
        <Features content={featuresContent} />
        <CustomerMemory content={customerMemoryContent} />
        <LiveDemo />
        <DashboardShowcase />
        <Trust content={trustContent} />
        <FAQ content={faqContent} />
        <FinalCTA content={finalCtaContent} />
      </main>
      <Footer content={footerContent} />
    </div>
  );
}
