import type { AvailabilityStatus, IconName } from "./types";

export type IntegrationCategory = "channels" | "commerce" | "productivity" | "developer";

export const INTEGRATION_CATEGORIES: { key: IntegrationCategory; label: string; description: string }[] = [
  { key: "channels", label: "Customer channels", description: "Where your customers already talk to you." },
  { key: "commerce", label: "Commerce", description: "Catalogs and stores OmniFlow reads from." },
  { key: "productivity", label: "Team tools", description: "Where your team works and reports." },
  { key: "developer", label: "Developer", description: "Connect OmniFlow to your own systems." },
];

export type Integration = {
  id: string;
  name: string;
  /** Two-letter monogram used as the logo tile. */
  mark: string;
  /** Accent for the monogram tile (brand-adjacent, never the whole card). */
  accent: string;
  icon?: IconName;
  category: IntegrationCategory;
  status: AvailabilityStatus;
  description: string;
  points?: string[];
};

/** Status vocabulary shown on cards and chips (text, not colour only). */
export const STATUS_META: Record<AvailabilityStatus, { label: string; tone: "success" | "brand" | "neutral" }> = {
  live: { label: "Live", tone: "success" },
  beta: { label: "Early access", tone: "brand" },
  soon: { label: "Coming soon", tone: "neutral" },
};

/**
 * Integrations with HONEST availability. "live" only for what the
 * product ships today; update a status here when a connector launches.
 */
export const INTEGRATIONS: Integration[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    mark: "WA",
    accent: "#25D366",
    category: "channels",
    status: "live",
    description: "Connect your number and let OmniFlow answer, qualify and follow up automatically.",
    points: ["Incoming message automation", "Order links and checkout", "Human handoff with full context"],
  },
  {
    id: "instagram",
    name: "Instagram",
    mark: "IG",
    accent: "#E1306C",
    category: "channels",
    status: "beta",
    description:
      "Direct messages and comments on your posts flow into the same inbox, handled by the same AI and workflows.",
    points: ["Signed Meta webhooks", "Same workflows as WhatsApp", "Media kept with the conversation"],
  },
  {
    id: "telegram",
    name: "Telegram",
    mark: "TG",
    accent: "#229ED9",
    category: "channels",
    status: "live",
    description: "Support and community chats run through the same understanding and workflows.",
  },
  {
    id: "website-chat",
    name: "Website chat",
    mark: "WC",
    accent: "#635BFF",
    icon: "message",
    category: "channels",
    status: "live",
    description: "An on-site assistant that answers visitors with your business knowledge.",
  },
  {
    id: "messenger",
    name: "Messenger",
    mark: "MS",
    accent: "#0084FF",
    category: "channels",
    status: "beta",
    description:
      "Facebook Page messages and comments on your posts join the same inbox, AI and workflows.",
  },
  {
    id: "email",
    name: "Email",
    mark: "EM",
    accent: "#0F766E",
    icon: "mail",
    category: "channels",
    status: "beta",
    description:
      "Connect your support mailbox: customer emails join the same inbox, AI and workflows, and replies go back in the same thread.",
    points: ["Any IMAP / SMTP mailbox", "Replies keep the email thread", "Newsletters and auto-replies skipped"],
  },
  {
    id: "sms",
    name: "SMS",
    mark: "SM",
    accent: "#B45309",
    icon: "messages",
    category: "channels",
    status: "beta",
    description:
      "Two-way SMS on your OmniFlow phone number: texts join the same inbox, AI and workflows, replies go back by SMS.",
    points: ["Your OmniFlow number (Twilio)", "Two-way where Twilio supports it (not Pakistan)", "STOP opt-outs respected"],
  },
  {
    id: "tiktok",
    name: "TikTok",
    mark: "TT",
    accent: "#111827",
    category: "channels",
    status: "soon",
    description: "Messages from TikTok will become conversations in the same inbox.",
  },
  {
    id: "youtube",
    name: "YouTube",
    mark: "YT",
    accent: "#FF0000",
    category: "channels",
    status: "soon",
    description: "Comments on your videos will arrive in the same inbox.",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    mark: "IN",
    accent: "#0A66C2",
    category: "channels",
    status: "soon",
    description: "Company page messages and comments will join the same inbox.",
  },
  {
    id: "x",
    name: "X",
    mark: "X",
    accent: "#111827",
    category: "channels",
    status: "soon",
    description: "Mentions and direct messages will become conversations.",
  },
  {
    id: "shopify",
    name: "Shopify",
    mark: "SH",
    accent: "#5E8E3E",
    icon: "bag",
    category: "commerce",
    status: "live",
    description: "Sync your product catalog so answers always use current products and prices.",
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    mark: "WO",
    accent: "#7F54B3",
    icon: "cart",
    category: "commerce",
    status: "live",
    description: "Pull products from your WooCommerce store into OmniFlow's knowledge.",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    mark: "GS",
    accent: "#0F9D58",
    icon: "sheet",
    category: "productivity",
    status: "soon",
    description: "Send qualified leads and orders straight into a shared sheet.",
  },
  {
    id: "gmail",
    name: "Gmail",
    mark: "GM",
    accent: "#EA4335",
    icon: "mail",
    category: "productivity",
    status: "soon",
    description: "One-click Google sign-in for Gmail inboxes (Gmail already works through the Email channel with an app password).",
  },
  {
    id: "slack",
    name: "Slack",
    mark: "SL",
    accent: "#611F69",
    icon: "hash",
    category: "productivity",
    status: "soon",
    description: "Notify the right channel when a high-intent lead or escalation arrives.",
  },
  {
    id: "crm",
    name: "CRM",
    mark: "CR",
    accent: "#0EA5E9",
    icon: "users",
    category: "productivity",
    status: "soon",
    description: "Keep contacts, deals and conversation history in sync with your CRM.",
  },
  {
    id: "webhooks",
    name: "Webhooks",
    mark: "WH",
    accent: "#475467",
    icon: "webhook",
    category: "developer",
    status: "live",
    description: "Signed outbound events for conversations, leads and orders.",
  },
  {
    id: "rest-api",
    name: "REST API",
    mark: "API",
    accent: "#101828",
    icon: "code",
    category: "developer",
    status: "soon",
    description: "A public API to read conversations and trigger workflows from your systems.",
  },
];

/**
 * Status for a channel name typed in the CMS (e.g. hero channel list).
 * Pass the admin-edited list from getMarketingList("integrations").
 */
export function statusForChannel(name: string, list: readonly Integration[] = INTEGRATIONS): AvailabilityStatus {
  const key = name.trim().toLowerCase();
  const match = list.find(
    (item) => item.name.toLowerCase() === key || item.id === key
  );
  return match ? match.status : "soon";
}
