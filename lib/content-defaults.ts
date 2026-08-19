/**
 * Editable content types + code-level defaults for website sections.
 */

export interface HeroContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  primary_button: string;
  secondary_button: string;
  channels_label: string;
  integrations: string; // comma separated
}

export const HERO_DEFAULTS: HeroContent = {
  badge: "Intelligent automation platform",
  heading_line1: "Automate",
  heading_line2: "every conversation.",
  description:
    "OmniFlow brings AI-powered conversations and automation into one intelligent platform — across the channels your customers already use.",
  primary_button: "Start Building",
  secondary_button: "See how it works",
  channels_label: "Works across your favorite channels",
  integrations: "WhatsApp, Instagram, Messenger, Telegram",
};

export interface FinalCtaContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  primary_button: string;
  secondary_button: string;
  notes: string; // separated by |
}

export const FINAL_CTA_DEFAULTS: FinalCtaContent = {
  badge: "Early access",
  heading_line1: "Put your conversations",
  heading_line2: "on autopilot",
  description:
    "OmniFlow is getting ready for its first businesses. Join early access and be among the first to automate your customer conversations.",
  primary_button: "Get early access",
  secondary_button: "See how it works",
  notes:
    "Pricing — coming soon | Early access opening soon | Built for multi-channel from day one",
};
export interface FooterContent extends Record<string, unknown> {
  description: string;
  status_label: string;
  linkedin_url: string;
  x_url: string;
  instagram_url: string;
}

export const FOOTER_DEFAULTS: FooterContent = {
  description:
    "Intelligent automation for modern businesses. Connect your conversations, automate your workflows and let AI handle the rest.",
  status_label: "Platform coming soon",
  linkedin_url: "#",
  x_url: "#",
  instagram_url: "#",
};
export interface FeaturesContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  f1_title: string;
  f1_desc: string;
  f2_title: string;
  f2_desc: string;
  f3_title: string;
  f3_desc: string;
  f4_title: string;
  f4_desc: string;
  f5_title: string;
  f5_desc: string;
  f6_title: string;
  f6_desc: string;
  capabilities: string; // separated by |
}

export const FEATURES_DEFAULTS: FeaturesContent = {
  badge: "Capabilities",
  heading_line1: "Everything you need to",
  heading_line2: "automate conversations",
  description:
    "One intelligent layer that understands customers, qualifies leads and keeps every conversation moving — automatically.",
  f1_title: "AI-powered conversations",
  f1_desc:
    "Let AI understand customer messages and respond naturally using your business context.",
  f2_title: "Lead qualification",
  f2_desc:
    "Automatically identify high-intent customers and move valuable conversations forward.",
  f3_title: "Smart follow-ups",
  f3_desc:
    "Keep conversations moving with automated follow-ups triggered by your workflow logic.",
  f4_title: "Intelligent routing",
  f4_desc:
    "Send conversations to the right person, team or workflow based on customer intent.",
  f5_title: "Visual workflows",
  f5_desc:
    "Build powerful automations with flexible triggers, conditions and actions.",
  f6_title: "Multi-channel ready",
  f6_desc:
    "Connect the channels your customers already use and manage automation from one layer.",
  capabilities:
    "Context-aware AI | No-code automation | Real-time triggers | Human handoff | Custom workflow logic | Built to scale",
};
export interface UseCasesContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  u1_label: string;
  u1_headline: string;
  u1_desc: string;
  u1_automations: string; // separated by |
  u1_status: string;
  u2_label: string;
  u2_headline: string;
  u2_desc: string;
  u2_automations: string;
  u2_status: string;
  u3_label: string;
  u3_headline: string;
  u3_desc: string;
  u3_automations: string;
  u3_status: string;
  u4_label: string;
  u4_headline: string;
  u4_desc: string;
  u4_automations: string;
  u4_status: string;
  u5_label: string;
  u5_headline: string;
  u5_desc: string;
  u5_automations: string;
  u5_status: string;
}

export const USE_CASES_DEFAULTS: UseCasesContent = {
  badge: "Use cases",
  heading_line1: "Built for the way",
  heading_line2: "your business talks",
  description:
    "Whatever you sell or support, OmniFlow adapts its automation to your conversations — not the other way around.",
  u1_label: "E-commerce",
  u1_headline: "Turn product questions into orders",
  u1_desc:
    "Answer product questions instantly, share order updates and recover interested buyers with automated follow-ups — around the clock.",
  u1_automations:
    "Instant product & availability answers | Order status and delivery updates | Follow-ups for interested buyers",
  u1_status: "Order link sent · Follow-up scheduled",
  u2_label: "Service businesses",
  u2_headline: "Book appointments while you work",
  u2_desc:
    "Let AI handle booking requests, answer common questions and send reminders — so clinics, salons and studios never miss a client.",
  u2_automations:
    "Appointment requests handled automatically | Instant answers to common questions | Reminders that reduce no-shows",
  u2_status: "Booking captured · Reminder scheduled",
  u3_label: "Real estate",
  u3_headline: "Qualify property leads instantly",
  u3_desc:
    "Respond to property inquiries the moment they arrive, qualify budget and intent, and route serious buyers straight to your agents.",
  u3_automations:
    "Instant response to property inquiries | Budget & requirement qualification | Serious buyers routed to agents",
  u3_status: "High intent · Routed to agent",
  u4_label: "Agencies",
  u4_headline: "Capture and route every lead",
  u4_desc:
    "Capture inbound leads across channels, qualify them with AI and hand the right conversations to the right team member automatically.",
  u4_automations:
    "Lead capture across channels | AI-driven qualification questions | Routing to the right team member",
  u4_status: "Qualified · Assigned to growth team",
  u5_label: "Support teams",
  u5_headline: "Resolve faster, escalate smarter",
  u5_desc:
    "Deflect repetitive questions with instant AI answers, keep full conversation context and hand off to humans exactly when needed.",
  u5_automations:
    "Instant answers to repeated questions | Context kept across the conversation | Smooth human handoff when needed",
  u5_status: "Escalated with full context",
};