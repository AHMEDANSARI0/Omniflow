import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import PageCta from "../components/ui/PageCta";
import Button from "../components/ui/Button";
import UseCases from "../components/UseCases";
import AutomationTemplates from "../components/home/AutomationTemplates";
import { getSectionContent } from "../../lib/content";
import { USE_CASES_DEFAULTS } from "../../lib/content-defaults";
import { NAV_ACTIONS } from "../../lib/marketing/navigation";
import { SITE_ROUTES } from "../../lib/marketing/site";
import { getCopy, getMarketingList } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "Solutions",
  description:
    "E-commerce, service businesses, real estate, agencies and support teams: see how OmniFlow automates real customer conversations.",
  alternates: { canonical: "/use-cases" },
};

export default async function UseCasesPage() {
  const [useCasesContent, heroes, ctas, homeCopy] = await Promise.all([
    getSectionContent("use_cases", USE_CASES_DEFAULTS),
    getCopy("page_heroes"),
    getCopy("page_ctas"),
    getCopy("home_sections"),
  ]);

  return (
    <PageShell>
      <PageHero hero={heroes.useCases}>
        <Button href={NAV_ACTIONS.primary.href} size="lg">
          {NAV_ACTIONS.primary.label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button href={SITE_ROUTES.howItWorks} variant="secondary" size="lg">
          {NAV_ACTIONS.howItWorks.label}
        </Button>
      </PageHero>

      <UseCases content={useCasesContent} />

      <AutomationTemplates templates={await getMarketingList("templates")} copy={homeCopy.templates} />

      <PageCta cta={ctas.useCases} />
    </PageShell>
  );
}
