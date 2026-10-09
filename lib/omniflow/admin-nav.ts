/**
 * Admin navigation: the one list the sidebar and the dashboard both read
 * (§259). Each section has its own lucide icon from the shared registry, so
 * an icon always matches its section. Pure data: no React here, so server
 * and client components can both import it.
 */
import type { IconName } from "../marketing/types";

export interface AdminNavItem {
  label: string;
  href: string;
  icon: IconName;
  description: string;
  enabled: boolean;
}

export const ADMIN_NAV: AdminNavItem[] = [
  {
    label: "Dashboard",
    href: "/admin",
    icon: "dashboard",
    description: "Website, leads, customers and AI in one place.",
    enabled: true,
  },
  // §260: website analytics section (visitors, pages, sources, clicks, forms).
  {
    label: "Website analytics",
    href: "/admin/analytics",
    icon: "chart",
    description: "Visitors, pages, sources and clicks on the public website.",
    enabled: true,
  },
  {
    label: "SEO",
    href: "/admin/seo",
    icon: "search",
    description: "Meta title, description and social tags of the website.",
    enabled: true,
  },
  {
    label: "Content",
    href: "/admin/content",
    icon: "file",
    description: "Edit website sections and copy without touching code.",
    enabled: true,
  },
  {
    label: "Leads",
    href: "/admin/leads",
    icon: "user-plus",
    description: "Early-access requests from the website.",
    enabled: true,
  },
  {
    label: "Customers",
    href: "/admin/customers",
    icon: "users",
    description: "Client accounts: password resets and locks.",
    enabled: true,
  },
  {
    label: "Integrations",
    href: "/admin/integrations",
    icon: "plug",
    description: "Channels, phone numbers and provider keys.",
    enabled: true,
  },
  {
    label: "AI Control",
    href: "/admin/ai-control",
    icon: "brain",
    description: "Kill switch, autonomy and AI activity per workspace.",
    enabled: true,
  },
  {
    label: "Model Router",
    href: "/admin/ai-router",
    icon: "route",
    description: "Sends each AI call to the fast, smart or failover model.",
    enabled: true,
  },
  {
    label: "Settings",
    href: "/admin/settings",
    icon: "settings",
    description: "Your admin account and password.",
    enabled: true,
  },
];
