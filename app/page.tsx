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
import Footer from "./components/Footer";
import { getSectionContent } from "../lib/content";
import {
  HERO_DEFAULTS, FINAL_CTA_DEFAULTS, FOOTER_DEFAULTS, FEATURES_DEFAULTS, USE_CASES_DEFAULTS, WHY_OMNIFLOW_DEFAULTS, TRUST_DEFAULTS,
  PROBLEM_SOLUTION_DEFAULTS, AI_INTELLIGENCE_DEFAULTS, MULTI_CHANNEL_DEFAULTS,
  CUSTOMER_MEMORY_DEFAULTS, HOW_IT_WORKS_DEFAULTS
} from "../lib/content-defaults";

export default async function Home() {
  const heroContent = await getSectionContent("hero", HERO_DEFAULTS);
  const aiIntelligenceContent = await getSectionContent("ai_intelligence", AI_INTELLIGENCE_DEFAULTS);
  const howItWorksContent = await getSectionContent("how_it_works", HOW_IT_WORKS_DEFAULTS);
  const finalCtaContent = await getSectionContent("final_cta", FINAL_CTA_DEFAULTS);
  const useCasesContent = await getSectionContent("use_cases", USE_CASES_DEFAULTS);
  const featuresContent = await getSectionContent("features", FEATURES_DEFAULTS);
  const trustContent = await getSectionContent("trust", TRUST_DEFAULTS);
  const whyOmniFlowContent = await getSectionContent("why_omniflow", WHY_OMNIFLOW_DEFAULTS);
  const multiChannelContent = await getSectionContent("multi_channel", MULTI_CHANNEL_DEFAULTS);
  const problemSolutionContent = await getSectionContent("problem_solution", PROBLEM_SOLUTION_DEFAULTS);
  const customerMemoryContent = await getSectionContent("customer_memory", CUSTOMER_MEMORY_DEFAULTS);
  const footerContent = await getSectionContent("footer", FOOTER_DEFAULTS);

  return (
    <main className="min-h-screen bg-[#07111f]">
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
      <FinalCTA content={finalCtaContent} />
      <Footer content={footerContent} />
    </main>
  );
}