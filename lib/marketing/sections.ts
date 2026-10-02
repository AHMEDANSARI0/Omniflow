import type { IconName } from "./types";

/**
 * Section-level copy for homepage blocks that do not have a CMS form yet
 * (hybrid CMS, §216). Text that the admin already edits stays in
 * Supabase `site_content`; these blocks get admin forms in a later batch.
 */
export const TEMPLATES_SECTION = {
  id: "templates",
  eyebrow: "Automation templates",
  title: "Start with an automation built for your business",
  copy: "Pick a proven conversation flow, adjust it to your products and rules, and go live the same day.",
  allLabel: "Browse all in the builder",
};

export const INTEGRATIONS_SECTION = {
  id: "integrations",
  eyebrow: "Integrations",
  title: "Works where your customers and team already are",
  copy: "One intelligence layer across channels, stores and team tools. Status is shown honestly: live, early access or coming soon.",
  cta: "View all integrations",
};

export const LIVE_DEMO_SECTION = {
  id: "live-demo",
  eyebrow: "Live conversation",
  title: "Watch a message become an automated workflow",
  copy: "A real OmniFlow run, step by step: the customer writes, the AI understands, the workflow decides and acts.",
  replay: "Replay",
  understandingLabel: "Understanding",
  workflowLabel: "Workflow",
  agentName: "OmniFlow AI",
  liveLabel: "Live",
  workingLabel: "OmniFlow is working",
};

export const DASHBOARD_SECTION = {
  id: "dashboard",
  eyebrow: "The product",
  title: "Every conversation, decision and action in one place",
  copy: "Conversations, AI decisions, automations and customers, in one dashboard your team understands in minutes.",
  cta: "Explore the dashboard",
};

export const STORY_SECTION = {
  id: "product",
  /** Shown under the node map. */
  footnote: "The AI never acts blindly: intent, business knowledge and your rules decide every action.",
};

/** One UI mockup per How-it-works step, in step order. */
export type StepMockup = "channels" | "knowledge" | "workflow" | "run";
export const HOW_IT_WORKS_MOCKUPS: StepMockup[] = ["channels", "knowledge", "workflow", "run"];

/** Visual per CMS feature (f1..f6), in order. */
export type FeatureVisual =
  | "conversation"
  | "qualification"
  | "follow-up"
  | "routing"
  | "workflow"
  | "channels"
  | "handoff";
export const FEATURE_VISUALS: FeatureVisual[] = [
  "conversation",
  "qualification",
  "follow-up",
  "routing",
  "workflow",
  "channels",
];

/** Icons for the capability chips (matched by position). */
export const CAPABILITY_ICONS: IconName[] = ["brain", "target", "hand", "history", "scale", "chart"];

/** Hero copy that has no CMS field yet. */
export const HERO_SECTION = {
  channelsNote: "Status shown honestly: live, early access or coming soon.",
  visualLabel: "OmniFlow AI",
  visualStatus: "Ready",
};

/**
 * Floating product cards around the hero visual. They stay when the
 * future 3D bot asset replaces the placeholder core.
 */
export const HERO_VISUAL_CARDS = {
  message: {
    channel: "WhatsApp",
    meta: "New message",
    text: "Black hoodie medium available hai?",
  },
  intent: { label: "Intent detected", value: "Purchase", strength: "High" },
  workflow: {
    label: "Workflow running",
    steps: ["Product found", "Order link sent", "Follow-up set"],
  },
  outcome: { label: "Customer qualified" },
};

export const HOW_IT_WORKS_SECTION = {
  id: "how-it-works",
  cta: "Start Building",
};

/** Sample content shown inside each How-it-works step mockup. */
export const STEP_MOCKUP_DATA = {
  channels: {
    title: "Channels",
    rows: [
      { name: "WhatsApp", detail: "Business number connected", on: true },
      { name: "Telegram", detail: "Bot connected", on: true },
      { name: "Website chat", detail: "Widget installed", on: true },
    ],
  },
  knowledge: {
    title: "Business knowledge",
    items: [
      { name: "Product catalog", detail: "Synced from your store" },
      { name: "Delivery and returns", detail: "Policy document" },
      { name: "Common questions", detail: "FAQ answers" },
    ],
    status: "Ready to answer",
  },
  workflow: {
    title: "Lead follow-up",
    nodes: [
      { kind: "Trigger", label: "Customer asks about price" },
      { kind: "Condition", label: "Intent is purchase" },
      { kind: "Action", label: "Send offer and follow up in 24h" },
    ],
  },
  run: {
    title: "Live",
    message: "Order kab tak deliver hoga?",
    reply: "Aapka order dispatch ho chuka hai, kal tak deliver ho jayega.",
    results: ["Reply sent", "Order status checked", "Customer tagged"],
  },
};

/** Sample content inside the feature visuals (FEATURE_VISUALS order). */
export const FEATURE_VISUAL_DATA = {
  conversation: {
    customer: "Is the medium size in stock?",
    ai: "Yes, medium is in stock in black and grey. Shall I share the order link?",
    meta: "Answered from your catalog",
  },
  qualification: {
    name: "Lead score",
    score: 86,
    signals: ["Asked for price", "Shared city", "Ready this week"],
    verdict: "High intent",
  },
  followUp: {
    steps: [
      { time: "Now", label: "Offer sent" },
      { time: "+24h", label: "Reminder if no reply" },
      { time: "+3 days", label: "Final check-in" },
    ],
  },
  routing: {
    from: "Incoming conversation",
    routes: [
      { label: "Sales team", active: true },
      { label: "Support", active: false },
      { label: "Human agent", active: false },
    ],
  },
  workflow: {
    nodes: ["New message", "Detect intent", "Check stock", "Reply and tag"],
  },
  channels: {
    names: ["WhatsApp", "Telegram", "Website chat", "Instagram"],
  },
  handoff: {
    rows: [
      { name: "Ahmed", detail: "Returning customer", owner: "AI", human: false },
      { name: "Sana", detail: "Escalated to you", owner: "Human", human: true },
    ],
    note: "Every action is visible. Nothing runs in the dark.",
  },
};

/** Sample customer profile in the customer-memory card. */
export const CUSTOMER_PROFILE_SAMPLE = {
  heading: "Customer context",
  status: "Context available",
  initials: "AK",
  name: "Ahmed",
  segment: "Returning customer",
  facts: [
    { icon: "target", label: "Intent", value: "Product inquiry" },
    { icon: "history", label: "History", value: "12 conversations" },
  ] as { icon: IconName; label: string; value: string }[],
  knownLabel: "Known context",
  known: "Interested in the black hoodie · Asked about pricing last week · Prefers evening delivery",
  insight:
    "With this context, the reply already knows the product, the price and the customer, so no extra questions are needed.",
};

/** Copy inside the multi-channel diagram (/integrations). */
export const MULTI_CHANNEL_DIAGRAM = {
  inbound: "Customer writes on any connected channel",
  decide: "One OmniFlow workflow decides and acts",
  footer: "Same AI · Same workflows · Same dashboard",
};

/** State chips beside the "Why OmniFlow" rows (b1..b4), in order. */
export const WHY_OMNIFLOW_STATES = [
  "Answers in seconds",
  "Same brain everywhere",
  "Humans for what matters",
  "One layer, zero scatter",
];
