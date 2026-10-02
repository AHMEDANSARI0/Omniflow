import type { IconName } from "./types";

/**
 * Sample data for the marketing dashboard preview. It mirrors real
 * OmniFlow dashboard modules (overview, inbox, automations) — sample
 * numbers, clearly a product illustration, not reported results.
 */
export const DASHBOARD_PREVIEW = {
  address: "app.omniflow.pk/dashboard",
  caption: "Product preview with sample data.",
  title: "Overview",
  subtitle: "Today",
  queueTitle: "Live conversations",
  channelsTitle: "Channel status",
  activityTitle: "Recent automations",
  nav: [
    { label: "Overview", icon: "dashboard" as IconName, active: true },
    { label: "Conversations", icon: "inbox" as IconName, badge: "4" },
    { label: "AI Agent", icon: "bot" as IconName },
    { label: "Automations", icon: "workflow" as IconName },
    { label: "Settings", icon: "settings" as IconName },
  ],
  stats: [
    { label: "Conversations", value: 128, suffix: "", trend: "+18% today" },
    { label: "AI handled", value: 85, suffix: "%", trend: "109 of 128" },
    { label: "Human handoffs", value: 7, suffix: "", trend: "5% of chats" },
    { label: "Leads qualified", value: 23, suffix: "", trend: "+6 today" },
  ],
  queue: [
    { name: "Ahmed R.", text: "Black hoodie medium available hai?", tag: "Product inquiry", tone: "brand", state: "AI replied" },
    { name: "Sana K.", text: "Delivery Lahore mein kitne din?", tag: "Delivery", tone: "flow", state: "AI replied" },
    { name: "Bilal M.", text: "Bulk order ka rate chahiye", tag: "High intent", tone: "ai", state: "Assigned to sales" },
    { name: "Hina S.", text: "Order cancel karna hai", tag: "Escalated", tone: "warn", state: "Human took over" },
  ],
  channels: [
    { name: "WhatsApp", state: "Connected", ok: true },
    { name: "Telegram", state: "Connected", ok: true },
    { name: "Instagram", state: "Early access", ok: false },
  ],
  activity: [
    { label: "Follow-up sent to 14 interested buyers", time: "2 min ago" },
    { label: "Workflow \u201cProduct inquiry\u201d running", time: "Live" },
    { label: "3 leads routed to sales", time: "12 min ago" },
  ],
} as const;

export type DashboardTone = (typeof DASHBOARD_PREVIEW.queue)[number]["tone"];
