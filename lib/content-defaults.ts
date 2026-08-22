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
export interface WhyOmniFlowContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  b1_title: string;
  b1_desc: string;
  b2_title: string;
  b2_desc: string;
  b3_title: string;
  b3_desc: string;
  b4_title: string;
  b4_desc: string;
}

export const WHY_OMNIFLOW_DEFAULTS: WhyOmniFlowContent = {
  badge: "Why OmniFlow",
  heading_line1: "The difference between",
  heading_line2: "replying and running",
  description:
    "Most businesses react to messages. OmniFlow turns every conversation into a system that qualifies, follows up and routes — automatically.",
  b1_title: "Always on, always instant",
  b1_desc:
    "Customers message at midnight, on weekends, during rush hours. OmniFlow answers in seconds — no queues, no missed conversations.",
  b2_title: "Consistent on every channel",
  b2_desc:
    "The same accurate, on-brand answer whether the customer writes on WhatsApp, Instagram or anywhere else you connect.",
  b3_title: "Your team stays on high-value work",
  b3_desc:
    "AI absorbs the repetitive questions and qualification. Your people step in only where a human actually makes the difference.",
  b4_title: "One layer instead of five tools",
  b4_desc:
    "Channels, AI, workflows and customer context live in one place — not scattered across disconnected apps and inboxes.",
};
export interface TrustContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  p1_title: string;
  p1_desc: string;
  p2_title: string;
  p2_desc: string;
  p3_title: string;
  p3_desc: string;
  p4_title: string;
  p4_desc: string;
  principles: string; // separated by |
}

export const TRUST_DEFAULTS: TrustContent = {
  badge: "Built on trust",
  heading_line1: "Automation you can",
  heading_line2: "actually trust",
  description:
    "Handing conversations to AI is a serious decision. OmniFlow is designed so you never trade control for automation.",
  p1_title: "You stay in control",
  p1_desc:
    "Define exactly what the AI can say and do. Every workflow, rule and boundary is configured by you — not decided for you.",
  p2_title: "Humans always in the loop",
  p2_desc:
    "Automation never locks your team out. Any conversation can be taken over by a human at any moment, with full context.",
  p3_title: "Transparent automation",
  p3_desc:
    "No black boxes. See why the AI qualified a lead, triggered a follow-up or routed a conversation — every step is visible.",
  p4_title: "Your data stays yours",
  p4_desc:
    "Customer conversations belong to your business. OmniFlow is being built privacy-first, from the architecture up.",
  principles:
    "No black boxes | Human handoff anytime | You define the rules | Privacy-first architecture",
};
export interface ProblemSolutionContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  problem_title: string;
  problems: string; // separated by |
  solution_title: string;
  solutions: string; // separated by |
  m1_value: string;
  m1_label: string;
  m2_value: string;
  m2_label: string;
  m3_value: string;
  m3_label: string;
  m4_value: string;
  m4_label: string;
}

export const PROBLEM_SOLUTION_DEFAULTS: ProblemSolutionContent = {
  badge: "From chaos to automation",
  heading_line1: "Stop managing conversations.",
  heading_line2: "Start automating them.",
  description:
    "Every customer conversation creates work. OmniFlow turns that work into intelligent, automated workflows that keep running without constant human intervention.",
  problem_title: "The old way",
  problems:
    "Customers waiting for replies | Messages scattered across platforms | Repetitive manual conversations",
  solution_title: "The intelligent way",
  solutions:
    "Instant AI-powered responses | One intelligent automation layer | Workflows that run automatically",
  m1_value: "24/7",
  m1_label: "Always available",
  m2_value: "AI",
  m2_label: "Understands context",
  m3_value: "∞",
  m3_label: "Scales with you",
  m4_value: "1",
  m4_label: "Automation layer",
};
export interface AiIntelligenceContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  i1_title: string;
  i1_desc: string;
  i1_tags: string; // comma separated
  i2_title: string;
  i2_desc: string;
  i2_tags: string;
  i3_title: string;
  i3_desc: string;
  i3_tags: string;
}

export const AI_INTELLIGENCE_DEFAULTS: AiIntelligenceContent = {
  badge: "AI Intelligence",
  heading_line1: "More than automation.",
  heading_line2: "Intelligence behind every action.",
  description:
    "OmniFlow combines AI understanding, conversation context and automation logic to make every interaction feel intentional.",
  i1_title: "Understand",
  i1_desc:
    "OmniFlow understands what the customer is asking instead of simply matching keywords.",
  i1_tags: "Intent, Language, Context",
  i2_title: "Decide",
  i2_desc:
    "The AI evaluates the conversation and chooses the most appropriate response or workflow.",
  i2_tags: "Reasoning, Rules, Memory",
  i3_title: "Act",
  i3_desc:
    "Once the decision is made, OmniFlow responds or triggers the right automation automatically.",
  i3_tags: "Reply, Workflow, Follow-up",
};
export interface MultiChannelContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  c1_name: string;
  c1_short: string;
  c1_desc: string;
  c2_name: string;
  c2_short: string;
  c2_desc: string;
  c3_name: string;
  c3_short: string;
  c3_desc: string;
  c4_name: string;
  c4_short: string;
  c4_desc: string;
  workflow_title: string;
  workflow_subtitle: string;
  actions: string; // comma separated
  bottom_note: string;
}

export const MULTI_CHANNEL_DEFAULTS: MultiChannelContent = {
  badge: "Multi-channel automation",
  heading_line1: "One intelligence layer.",
  heading_line2: "Every channel.",
  description:
    "Connect the platforms your customers already use and let one intelligent automation layer handle the conversations.",
  c1_name: "WhatsApp",
  c1_short: "WA",
  c1_desc: "Conversations",
  c2_name: "Instagram",
  c2_short: "IG",
  c2_desc: "Direct messages",
  c3_name: "Messenger",
  c3_short: "MS",
  c3_desc: "Customer chats",
  c4_name: "Telegram",
  c4_short: "TG",
  c4_desc: "Community & support",
  workflow_title: "One workflow layer",
  workflow_subtitle: "Build once. Automate everywhere.",
  actions: "Reply, Qualify, Route, Follow-up",
  bottom_note: "More channels can be added as your business grows.",
};
export interface CustomerMemoryContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  context_items: string; // separated by |
  bottom_note: string;
}

export const CUSTOMER_MEMORY_DEFAULTS: CustomerMemoryContent = {
  badge: "Contextual intelligence",
  heading_line1: "Conversations that",
  heading_line2: "remember.",
  description:
    "Give your AI the context it needs to make every conversation more relevant. OmniFlow can work with customer history, preferences and conversation context to create more meaningful interactions.",
  context_items:
    "Previous conversations | Customer preferences | Conversation intent | Important details",
  bottom_note:
    "Better context creates better conversations — while keeping your automation workflows consistent.",
};
export interface HowItWorksContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  s1_type: string;
  s1_title: string;
  s1_desc: string;
  s2_type: string;
  s2_title: string;
  s2_desc: string;
  s3_type: string;
  s3_title: string;
  s3_desc: string;
  s4_type: string;
  s4_title: string;
  s4_desc: string;
  bottom_note: string;
}

export const HOW_IT_WORKS_DEFAULTS: HowItWorksContent = {
  badge: "How it works",
  heading_line1: "Build once.",
  heading_line2: "Let it run.",
  description:
    "Turn repetitive conversations into intelligent workflows with a simple visual automation system.",
  s1_type: "Trigger",
  s1_title: "Customer sends a message",
  s1_desc:
    "Start your automation whenever a customer reaches out through a connected channel.",
  s2_type: "AI",
  s2_title: "OmniFlow understands",
  s2_desc:
    "AI analyzes the message, conversation context and customer intent in real time.",
  s3_type: "Decision",
  s3_title: "Choose what happens next",
  s3_desc:
    "Use intelligent conditions and workflow logic to decide the right next action.",
  s4_type: "Action",
  s4_title: "Automation takes action",
  s4_desc:
    "Send a reply, qualify a lead, route the conversation or trigger another workflow.",
  bottom_note: "Your workflows can evolve as your business grows.",
};
export interface FaqContent extends Record<string, unknown> {
  badge: string;
  heading_line1: string;
  heading_line2: string;
  description: string;
  q1: string;
  a1: string;
  q2: string;
  a2: string;
  q3: string;
  a3: string;
  q4: string;
  a4: string;
  q5: string;
  a5: string;
  q6: string;
  a6: string;
  contact_text: string;
  contact_email: string;
}

export const FAQ_DEFAULTS: FaqContent = {
  badge: "FAQ",
  heading_line1: "Questions,",
  heading_line2: "answered.",
  description:
    "Everything you need to know about OmniFlow and early access.",
  q1: "When will pricing be announced?",
  a1: "Pricing is being finalized and will be announced before public launch. Early-access members will see it first — and get preferred early-access terms.",
  q2: "How long does setup take?",
  a2: "OmniFlow is designed so you can go live quickly: connect a channel, add your business details and switch on your assistant. During early access, our team personally helps you get set up.",
  q3: "Which channels are supported?",
  a3: "We're launching with WhatsApp first, with Instagram, Messenger and Telegram rolling out next. The platform is built multi-channel from day one, so new channels plug into the same automation layer.",
  q4: "Is my customer data secure?",
  a4: "Your customer conversations belong to your business — full stop. OmniFlow is being built privacy-first: you define what the AI can say and do, every automation step is visible, and your data is never shared.",
  q5: "Do I need technical skills to use OmniFlow?",
  a5: "No. Workflows are no-code and the dashboard is designed for business owners, not developers. If you can use WhatsApp, you can use OmniFlow.",
  q6: "Can a human take over a conversation?",
  a6: "Yes — anytime. Automation never locks your team out. Any conversation can be taken over by a human at any moment, with the full conversation context in front of them.",
  contact_text: "Still have questions?",
  contact_email: "hello@omniflow.example.com",
};