import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import ProblemSolution from "./components/ProblemSolution";
import AIIntelligence from "./components/AIIntelligence";
import MultiChannel from "./components/MultiChannel";
import CustomerMemory from "./components/CustomerMemory";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import UseCases from "./components/UseCases";
import WhyOmniFlow from "./components/WhyOmniFlow";
import Trust from "./components/Trust";
import FinalCTA from "./components/FinalCTA";
import FAQ from "./components/FAQ";
import Footer from "./components/Footer";
import { getSectionContent } from "../lib/content";
import { getSiteSettings } from "../lib/settings";
import {
  HERO_DEFAULTS, FINAL_CTA_DEFAULTS, FOOTER_DEFAULTS, FEATURES_DEFAULTS, USE_CASES_DEFAULTS, WHY_OMNIFLOW_DEFAULTS, TRUST_DEFAULTS,
  PROBLEM_SOLUTION_DEFAULTS, AI_INTELLIGENCE_DEFAULTS, MULTI_CHANNEL_DEFAULTS,
  CUSTOMER_MEMORY_DEFAULTS, HOW_IT_WORKS_DEFAULTS, FAQ_DEFAULTS
} from "../lib/content-defaults";

export default async function Home() {
  const [
    heroContent,
    aiIntelligenceContent,
    howItWorksContent,
    finalCtaContent,
    useCasesContent,
    featuresContent,
    trustContent,
    whyOmniFlowContent,
    multiChannelContent,
    problemSolutionContent,
    customerMemoryContent,
    faqContent,
    footerContent,
  ] = await Promise.all([
    getSectionContent("hero", HERO_DEFAULTS),
    getSectionContent("ai_intelligence", AI_INTELLIGENCE_DEFAULTS),
    getSectionContent("how_it_works", HOW_IT_WORKS_DEFAULTS),
    getSectionContent("final_cta", FINAL_CTA_DEFAULTS),
    getSectionContent("use_cases", USE_CASES_DEFAULTS),
    getSectionContent("features", FEATURES_DEFAULTS),
    getSectionContent("trust", TRUST_DEFAULTS),
    getSectionContent("why_omniflow", WHY_OMNIFLOW_DEFAULTS),
    getSectionContent("multi_channel", MULTI_CHANNEL_DEFAULTS),
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
    <main className="min-h-screen bg-[#07111f]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <Navbar />
      <Hero content={heroContent} />
      <ProblemSolution content={problemSolutionContent} />
      <AIIntelligence content={aiIntelligenceContent} />
      <MultiChannel content={multiChannelContent} />
      <CustomerMemory content={customerMemoryContent} />
      <HowItWorks content={howItWorksContent} />
      <Features content={featuresContent} />
      <UseCases content={useCasesContent} />
      <WhyOmniFlow content={whyOmniFlowContent} />
      <Trust content={trustContent} />
      <FAQ content={faqContent} />
      <FinalCTA content={finalCtaContent} />
      <Footer content={footerContent} />
    </main>
  );
}