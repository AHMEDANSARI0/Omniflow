import type { IconName } from "./PortalIcon";

// §246: the single source of the portal navigation. The sidebar renders the
// groups as dropdowns, the command palette searches every entry and the
// dashboard builds its shortcuts from it, so a page is added in one place.

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}

export interface NavGroup {
  id: string;
  title: string;
  icon: IconName;
  items: NavItem[];
}

export const DASHBOARD_LINK: NavItem = { label: "Dashboard", href: "/dashboard", icon: "dashboard" };
export const SETTINGS_LINK: NavItem = { label: "Settings", href: "/dashboard/settings", icon: "settings" };
export const ASSISTANT_LINK: NavItem = { label: "Ask Omni", href: "/dashboard/assistant", icon: "sparkles" };

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "inbox",
    title: "Inbox",
    icon: "inbox",
    items: [
      { label: "Conversations", href: "/dashboard/conversations", icon: "conversations" },
      { label: "Customers", href: "/dashboard/customers", icon: "customers" },
      { label: "Quick replies", href: "/dashboard/saved-replies", icon: "quickReplies" },
      { label: "Approvals", href: "/dashboard/approvals", icon: "approvals" },
    ],
  },
  {
    id: "sales",
    title: "Sales",
    icon: "sales",
    items: [
      { label: "Sales desk", href: "/dashboard/sales", icon: "salesDesk" },
      { label: "Pipeline", href: "/dashboard/pipeline", icon: "pipeline" },
      { label: "COD confirmations", href: "/dashboard/cod", icon: "cod" },
      { label: "Courier", href: "/dashboard/courier", icon: "courier" },
      { label: "Win-back", href: "/dashboard/winback", icon: "winback" },
      { label: "Retention", href: "/dashboard/retention", icon: "retention" },
    ],
  },
  {
    id: "marketing",
    title: "Marketing",
    icon: "marketing",
    items: [
      { label: "Broadcasts", href: "/dashboard/broadcasts", icon: "marketing" },
      { label: "Sequences", href: "/dashboard/sequences", icon: "sequences" },
      { label: "Segments", href: "/dashboard/segments", icon: "segments" },
      { label: "Growth", href: "/dashboard/growth", icon: "growth" },
    ],
  },
  {
    id: "automation",
    title: "Automation",
    icon: "automation",
    items: [
      { label: "Automations", href: "/dashboard/automations", icon: "automation" },
      { label: "Workflows", href: "/dashboard/workflows", icon: "workflows" },
      { label: "Rules", href: "/dashboard/rules", icon: "rules" },
    ],
  },
  {
    id: "content",
    title: "Content",
    icon: "content",
    items: [
      { label: "Knowledge base", href: "/dashboard/knowledge-base", icon: "knowledgeBase" },
      { label: "Website analyzer", href: "/dashboard/website-analyzer", icon: "websiteAnalyzer" },
      { label: "Media", href: "/dashboard/media", icon: "media" },
    ],
  },
  {
    id: "insights",
    title: "Insights",
    icon: "insights",
    items: [
      { label: "Business insights", href: "/dashboard/insights", icon: "businessInsights" },
      { label: "Analytics", href: "/dashboard/analytics", icon: "analytics" },
      { label: "Weekly", href: "/dashboard/weekly", icon: "weekly" },
      { label: "Activity", href: "/dashboard/activity", icon: "activity" },
    ],
  },
  {
    id: "ai",
    title: "AI agent",
    icon: "ai",
    items: [
      { label: "Configure AI", href: "/dashboard/bot", icon: "configureAi" },
      { label: "AI setup report", href: "/dashboard/ai-report", icon: "aiReport" },
      { label: "AI Sandbox", href: "/dashboard/sandbox", icon: "sandbox" },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    icon: "workspace",
    items: [
      { label: "WhatsApp setup", href: "/dashboard/channels/whatsapp", icon: "whatsapp" },
      { label: "Setup wizard", href: "/dashboard/onboarding", icon: "setupWizard" },
      { label: "Business profile", href: "/dashboard/profile", icon: "profile" },
      { label: "Integrations", href: "/dashboard/integrations", icon: "integrations" },
      { label: "Compliance", href: "/dashboard/compliance", icon: "compliance" },
      { label: "Team", href: "/dashboard/team", icon: "team" },
    ],
  },
];

export function isNavActive(pathname: string, href: string): boolean {
  if (href === DASHBOARD_LINK.href) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

export function findNav(pathname: string): { group: NavGroup | null; item: NavItem | null } {
  for (const item of [DASHBOARD_LINK, SETTINGS_LINK, ASSISTANT_LINK]) {
    if (isNavActive(pathname, item.href)) return { group: null, item };
  }
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => isNavActive(pathname, entry.href));
    if (item) return { group, item };
  }
  return { group: null, item: null };
}
