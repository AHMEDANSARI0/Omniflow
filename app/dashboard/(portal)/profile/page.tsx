import { redirect } from "next/navigation";
import { requireOmniFlowPrincipal } from "../../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../../lib/omniflow/entitlements";
import { getTenantHybridConfig } from "../../../../lib/omniflow/hybrid-whatsapp-engine";
import ProfileForm, { type BusinessProfile } from "./ProfileForm";
import CatalogSection from "./CatalogSection";
import OrdersSection from "./OrdersSection";
import {
  DEFAULT_BUSINESS_PROFILE,
  getBusinessProfile,
  requirePortalAccessToken,
} from "../../../../lib/omniflow/portal";

export const dynamic = "force-dynamic";

export default async function BusinessProfilePage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");
  const principal = await requireOmniFlowPrincipal();
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );
  const hasSalesDesk = Boolean(entitlements.features["sales.sales_desk"]?.enabled);

  const [result, hybrid] = await Promise.all([
    getBusinessProfile(accessToken).catch(() => ({
      configured: false,
      data: DEFAULT_BUSINESS_PROFILE,
    })),
    getTenantHybridConfig(principal.clientId),
  ]);

  const bc = hybrid.businessConfig;
  const profile: BusinessProfile = {
    ...DEFAULT_BUSINESS_PROFILE,
    business_name:
      result.data?.business_name || bc.businessName || DEFAULT_BUSINESS_PROFILE.business_name,
    industry: result.data?.industry || "E-Commerce & Retail",
    phone: result.data?.phone || bc.contactInfo || "",
    website: result.data?.website || "",
    address: result.data?.address || "",
    timezone: result.data?.timezone || "Asia/Karachi",
    business_hours:
      result.data?.business_hours ||
      `Mon–Sat, ${bc.businessHoursStart} – ${bc.businessHoursEnd}`,
    default_language: result.data?.default_language || "English",
    about: result.data?.about || bc.businessDescription || "",
    products: result.data?.products || bc.productsAndServices || "",
    policies: result.data?.policies || bc.pricingInfo || "",
    faqs:
      result.data?.faqs ||
      bc.faqs.map((f) => `${f.question} — ${f.answer}`).join("\n"),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Business profile
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Single source of truth for your business identity, hours, products, and policies — automatically synced with your WhatsApp AI Agent and Automation Rules.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-1 text-[11px] font-medium text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Auto-synced with AI Agent
        </span>
      </div>

      <ProfileForm profile={profile} />

      {hasSalesDesk && (
        <>
          <div className="mt-6">
            <CatalogSection />
          </div>

          <div className="mt-6">
            <OrdersSection />
          </div>
        </>
      )}
    </div>
  );
}
