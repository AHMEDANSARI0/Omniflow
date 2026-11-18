import type { IconName } from "./PortalIcon";

// §246 + Centralized Entitlement Engine: single source of portal navigation
// with per-item featureKey mapping so disabled modules and empty groups are
// hidden automatically while preserving OmniFlow's visual identity.

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  featureKey?: string;
}

export interface NavGroup {
  id: string;
  title: string;
  icon: IconName;
  items: NavItem[];
}

export const DASHBOARD_LINK: NavItem = {
  label: "Dashboard",
  href: "/dashboard",
  icon: "dashboard",
  featureKey: "basic.dashboard",
};
export const SETTINGS_LINK: NavItem = {
  label: "Settings",
  href: "/dashboard/settings",
  icon: "settings",
  featureKey: "basic.business_config",
};
export const ASSISTANT_LINK: NavItem = {
  label: "Ask Omni",
  href: "/dashboard/assistant",
  icon: "sparkles",
  featureKey: "ai.advanced_tools",
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "inbox",
    title: "Inbox",
    icon: "inbox",
    items: [
      { label: "Conversations", href: "/dashboard/conversations", icon: "conversations", featureKey: "basic.inbox" },
      { label: "Customers", href: "/dashboard/customers", icon: "customers", featureKey: "basic.customers" },
      { label: "Quick replies", href: "/dashboard/saved-replies", icon: "quickReplies", featureKey: "basic.quick_replies" },
      { label: "Approvals", href: "/dashboard/approvals", icon: "approvals", featureKey: "workspace.approvals" },
    ],
  },
  {
    id: "sales",
    title: "Sales",
    icon: "sales",
    items: [
      { label: "Sales desk", href: "/dashboard/sales", icon: "salesDesk", featureKey: "sales.sales_desk" },
      { label: "Pipeline", href: "/dashboard/pipeline", icon: "pipeline", featureKey: "sales.pipeline" },
      { label: "COD confirmations", href: "/dashboard/cod", icon: "cod", featureKey: "sales.cod" },
      { label: "Courier", href: "/dashboard/courier", icon: "courier", featureKey: "sales.courier" },
      { label: "Win-back", href: "/dashboard/winback", icon: "winback", featureKey: "sales.winback" },
      { label: "Retention", href: "/dashboard/retention", icon: "retention", featureKey: "sales.retention" },
    ],
  },
  {
    id: "marketing",
    title: "Marketing",
    icon: "marketing",
    items: [
      { label: "Broadcasts", href: "/dashboard/broadcasts", icon: "marketing", featureKey: "marketing.broadcasts" },
      { label: "Sequences", href: "/dashboard/sequences", icon: "sequences", featureKey: "marketing.sequences" },
      { label: "Segments", href: "/dashboard/segments", icon: "segments", featureKey: "marketing.segments" },
      { label: "Growth", href: "/dashboard/growth", icon: "growth", featureKey: "marketing.growth" },
    ],
  },
  {
    id: "automation",
    title: "Automation",
    icon: "automation",
    items: [
      { label: "Automations", href: "/dashboard/automations", icon: "automation", featureKey: "automation.advanced_builder" },
      { label: "Workflows", href: "/dashboard/workflows", icon: "workflows", featureKey: "automation.workflows" },
      { label: "Rules", href: "/dashboard/rules", icon: "rules", featureKey: "basic.hybrid_ai" },
    ],
  },
  {
    id: "content",
    title: "Content",
    icon: "content",
    items: [
      { label: "Knowledge base", href: "/dashboard/knowledge-base", icon: "knowledgeBase", featureKey: "content.knowledge_base" },
      { label: "Website analyzer", href: "/dashboard/website-analyzer", icon: "websiteAnalyzer", featureKey: "content.website_analyzer" },
      { label: "Media", href: "/dashboard/media", icon: "media", featureKey: "content.media" },
    ],
  },
  {
    id: "insights",
    title: "Insights",
    icon: "insights",
    items: [
      { label: "Business insights", href: "/dashboard/insights", icon: "businessInsights", featureKey: "insights.business_insights" },
      { label: "Analytics", href: "/dashboard/analytics", icon: "analytics", featureKey: "insights.advanced_analytics" },
      { label: "Weekly", href: "/dashboard/weekly", icon: "weekly", featureKey: "insights.weekly_reports" },
      { label: "Activity", href: "/dashboard/activity", icon: "activity", featureKey: "basic.activity_reports" },
    ],
  },
  {
    id: "ai",
    title: "AI agent",
    icon: "ai",
    items: [
      { label: "Configure AI", href: "/dashboard/bot", icon: "configureAi", featureKey: "basic.hybrid_ai" },
      { label: "AI setup report", href: "/dashboard/ai-report", icon: "aiReport", featureKey: "ai.setup_report" },
      { label: "AI Sandbox", href: "/dashboard/sandbox", icon: "sandbox", featureKey: "ai.sandbox" },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    icon: "workspace",
    items: [
      { label: "WhatsApp setup", href: "/dashboard/channels/whatsapp", icon: "whatsapp", featureKey: "basic.whatsapp_connect" },
      { label: "Social connectors", href: "/dashboard/channels", icon: "integrations", featureKey: "workspace.instagram_connector" },
      { label: "Setup wizard", href: "/dashboard/onboarding", icon: "setupWizard", featureKey: "basic.business_config" },
      { label: "Business profile", href: "/dashboard/profile", icon: "profile", featureKey: "basic.business_config" },
      { label: "Integrations", href: "/dashboard/integrations", icon: "integrations", featureKey: "workspace.external_api" },
      { label: "Compliance", href: "/dashboard/compliance", icon: "compliance", featureKey: "workspace.compliance" },
      { label: "Team", href: "/dashboard/team", icon: "team", featureKey: "workspace.advanced_team" },
    ],
  },
];

export function filterNavGroupsByEntitlements(
  enabledFeatures?: string[]
): NavGroup[] {
  if (!enabledFeatures || enabledFeatures.length === 0) {
    return NAV_GROUPS;
  }
  const set = new Set(enabledFeatures);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !item.featureKey ||
        set.has(item.featureKey) ||
        (item.href === "/dashboard/channels" &&
          (set.has("workspace.instagram_connector") ||
            set.has("workspace.facebook_connector") ||
            set.has("workspace.messenger_connector")))
    ),
  })).filter((group) => group.items.length > 0);
}

export function isRouteAllowedByEntitlements(
  pathname: string,
  enabledFeatures?: string[]
): { allowed: boolean; label: string; featureKey: string | null } {
  if (!enabledFeatures || enabledFeatures.length === 0) {
    return { allowed: true, label: "Workspace", featureKey: null };
  }
  const set = new Set(enabledFeatures);
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return { allowed: true, label: "Dashboard", featureKey: "basic.dashboard" };
  }
  if (pathname.startsWith("/dashboard/conversations")) {
    return { allowed: set.has("basic.inbox"), label: "Inbox & Conversations", featureKey: "basic.inbox" };
  }
  if (pathname === "/dashboard/customers" || pathname === "/dashboard/customers/") {
    return { allowed: set.has("basic.customers"), label: "Customers & Contacts", featureKey: "basic.customers" };
  }
  if (pathname.startsWith("/dashboard/customers/profile")) {
    return {
      allowed: set.has("sales.advanced_crm"),
      label: "Customer 360 Profile (Advanced CRM)",
      featureKey: "sales.advanced_crm",
    };
  }
  if (pathname.startsWith("/dashboard/channels/whatsapp")) {
    return { allowed: set.has("basic.whatsapp_connect"), label: "WhatsApp Setup", featureKey: "basic.whatsapp_connect" };
  }
  if (pathname === "/dashboard/channels" || pathname === "/dashboard/channels/") {
    const ok =
      set.has("workspace.instagram_connector") ||
      set.has("workspace.facebook_connector") ||
      set.has("workspace.messenger_connector");
    return { allowed: ok, label: "Social Connectors", featureKey: "workspace.instagram_connector" };
  }

  const allItems = [
    DASHBOARD_LINK,
    SETTINGS_LINK,
    ASSISTANT_LINK,
    ...NAV_GROUPS.flatMap((g) => g.items),
  ];

  // Match longest href first so /dashboard/channels/whatsapp wins over /dashboard/channels
  const sorted = [...allItems].sort((a, b) => b.href.length - a.href.length);
  for (const item of sorted) {
    if (item.href === "/dashboard") continue;
    if (pathname === item.href || pathname.startsWith(item.href + "/")) {
      const ok = !item.featureKey || set.has(item.featureKey);
      return { allowed: ok, label: item.label, featureKey: item.featureKey || null };
    }
  }

  return { allowed: true, label: "Workspace", featureKey: null };
}

export function isNavActive(pathname: string, href: string): boolean {
  if (href === DASHBOARD_LINK.href) return pathname === href;
  if (href === "/dashboard/channels") {
    return pathname === "/dashboard/channels" || pathname === "/dashboard/channels/";
  }
  return pathname === href || pathname.startsWith(href + "/");
}

export function findNav(pathname: string): { group: NavGroup | null; item: NavItem | null } {
  for (const item of [DASHBOARD_LINK, SETTINGS_LINK, ASSISTANT_LINK]) {
    if (isNavActive(pathname, item.href)) return { group: null, item };
  }
  for (const group of NAV_GROUPS) {
    const sortedItems = [...group.items].sort((a, b) => b.href.length - a.href.length);
    const item = sortedItems.find((entry) => isNavActive(pathname, entry.href));
    if (item) return { group, item };
  }
  return { group: null, item: null };
}
