import type { IconName } from "./types";
import type { FeatureVisual } from "./sections";

/** Inner-page hero copy. `emphasis` renders with the brand gradient. */
export type PageHeroCopy = {
  eyebrow: string;
  title: string;
  emphasis: string;
  after?: string;
  copy: string;
};

export const PAGE_HEROES: Record<
  "features" | "integrations" | "pricing" | "useCases" | "about" | "contact" | "security" | "blog",
  PageHeroCopy
> = {
  features: {
    eyebrow: "Platform",
    title: "One platform for",
    emphasis: "intelligent conversations",
    after: "and automation.",
    copy: "Everything OmniFlow does, from understanding a message to running the workflow behind it, in one AI layer between your business and your customers.",
  },
  integrations: {
    eyebrow: "Integrations",
    title: "One intelligence layer.",
    emphasis: "Every channel you need.",
    copy: "Channels, stores and team tools connect to the same AI, the same workflows and the same dashboard. A new channel is a connection, not a migration.",
  },
  pricing: {
    eyebrow: "Pricing",
    title: "Simple pricing,",
    emphasis: "announced soon.",
    copy: "We're finalizing pricing with our first customers in mind. Early-access members see it first and get preferred terms.",
  },
  useCases: {
    eyebrow: "Solutions",
    title: "Built for the way",
    emphasis: "your business talks.",
    copy: "Every business has its own ten questions. OmniFlow learns your answers, your products and your policies, then runs the workflow behind them.",
  },
  about: {
    eyebrow: "About OmniFlow",
    title: "Building the automation layer for",
    emphasis: "modern customer conversations.",
    copy: "We started OmniFlow with a simple observation: small businesses lose customers not because they don't care, but because the message arrived at 11pm.",
  },
  contact: {
    eyebrow: "Contact",
    title: "Talk to a",
    emphasis: "human.",
    copy: "Questions about early access, custom automation or how OmniFlow would fit your business? We answer quickly.",
  },
  security: {
    eyebrow: "Security & trust",
    title: "Automation",
    emphasis: "without losing control.",
    copy: "Handing customer conversations to software is a serious decision. Here is exactly how OmniFlow handles data, access and control.",
  },
  blog: {
    eyebrow: "Resources",
    title: "Notes on",
    emphasis: "conversation automation.",
    copy: "Practical guides on AI customer conversations, workflows and follow-ups for growing businesses.",
  },
};

export type PageCta = {
  eyebrow: string;
  title: string;
  copy: string;
  primary: string;
  secondary?: { label: string; href: string };
};

/** Closing call-to-action bands for inner pages (light, never dark). */
export const PAGE_CTAS: Record<"features" | "about" | "integrations" | "useCases" | "article", PageCta> = {
  features: {
    eyebrow: "Ready when you are",
    title: "See OmniFlow on your own conversations.",
    copy: "Connect a channel, add your business context and watch the first workflow run.",
    primary: "Start Building",
    secondary: { label: "Explore use cases", href: "/use-cases" },
  },
  about: {
    eyebrow: "Early access",
    title: "Help us build the layer.",
    copy: "We're onboarding our first businesses now and shaping the roadmap around how they actually work.",
    primary: "Start Building",
    secondary: { label: "Talk to us", href: "/contact" },
  },
  integrations: {
    eyebrow: "One layer",
    title: "New channels. Same intelligence.",
    copy: "Your workflows, AI context and dashboard stay exactly the same when a new channel connects.",
    primary: "Start Building",
    secondary: { label: "How channels work", href: "/faq" },
  },
  useCases: {
    eyebrow: "Your business",
    title: "Don't see your business here?",
    copy: "If your customers message you, OmniFlow can automate the pattern. Tell us how you work and we'll set up the first workflow with you.",
    primary: "Start Building",
    secondary: { label: "Talk to us", href: "/contact" },
  },
  article: {
    eyebrow: "OmniFlow",
    title: "Put this into practice.",
    copy: "Turn your busiest conversations into workflows that run on their own.",
    primary: "Start Building",
    secondary: { label: "See the platform", href: "/features" },
  },
};

export type FeaturePillar = {
  eyebrow: string;
  title: string;
  copy: string;
  points: string[];
  /** Visual rendered next to the pillar (see FeatureVisual). */
  visual: FeatureVisual;
};

export const FEATURE_PILLARS: FeaturePillar[] = [
  {
    eyebrow: "Understand",
    title: "AI that reads the conversation, not keywords",
    copy: "Every message is parsed for intent, sentiment and language in the customer's own words, Roman Urdu included, so replies answer what was actually asked.",
    points: ["Intent detection on natural messages", "Sentiment and language awareness", "Business knowledge applied to every answer"],
    visual: "conversation",
  },
  {
    eyebrow: "Decide",
    title: "Your rules decide what happens next",
    copy: "Workflows turn understanding into action: conditions route high-intent buyers to sales, support questions get instant answers, follow-ups run on schedule.",
    points: ["Visual trigger, AI, condition and action builder", "Routing by intent, value or team", "Automated follow-ups and reminders"],
    visual: "routing",
  },
  {
    eyebrow: "Stay in control",
    title: "Humans step in exactly when it matters",
    copy: "Automation never locks your team out. Any conversation can be taken over with full context, and every AI action is visible in the activity trail.",
    points: ["One-click human handoff", "Transparent automation activity", "You define what the AI may say and do"],
    visual: "handoff",
  },
];

export type PricingPlan = {
  name: string;
  price: string;
  description: string;
  points: string[];
  featured: boolean;
  cta: { label: string; href: string };
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: "Early access",
    price: "Coming soon",
    description: "For the first businesses joining OmniFlow. Guided setup with our team and preferred early-access terms.",
    points: ["WhatsApp automation, live today", "AI conversations with your business context", "Visual workflows and follow-ups", "Personal onboarding"],
    featured: true,
    cta: { label: "Start Building", href: "/dashboard/login" },
  },
  {
    name: "Business automation",
    price: "Coming soon",
    description: "For teams running more conversations, more workflows and more channels.",
    points: ["Everything in early access", "Team seats and routing", "More channels as they launch", "Priority support"],
    featured: false,
    cta: { label: "Join early access", href: "/dashboard/login" },
  },
  {
    name: "Custom automation",
    price: "Let's talk",
    description: "For larger operations with unique workflows. We design the automation with you.",
    points: ["Custom workflow design", "Catalog and policy depth", "Volume-based terms"],
    featured: false,
    cta: { label: "Talk to us", href: "/contact" },
  },
];

/** Badge on the featured plan (honest: it is the plan open today). */
export const PRICING_FEATURED_LABEL = "Open now";

export const PRICING_NOTE = {
  lead: "No surprises:",
  copy: "pricing will be published before public launch, and early access members keep their preferred terms. Your data and your workflows stay yours either way.",
};

export const ABOUT_STORY = {
  title: "Why OmniFlow exists",
  paragraphs: [
    "In Pakistan and across the world, commerce happens in chat. A customer messages, expects an answer in minutes, and buys from whoever replies first. Meanwhile the owner is packing orders, managing staff and answering the same six questions for the hundredth time.",
    "Existing tools made businesses choose: a keyword bot that customers dislike, or an expensive enterprise platform built for companies with integration budgets. Neither fits a business that runs on chat and common sense.",
    "OmniFlow is the missing layer: AI that understands the message, applies your business context and runs the workflow (replies, order links, follow-ups, routing) while you and your team stay in control of every conversation.",
  ],
  oneLinerLabel: "The one-line story",
  oneLiner: "Customer messages, OmniFlow understands, context is applied, the workflow decides, the action runs, and a human takes over when it matters.",
};

export type ValueCard = { icon: IconName; title: string; copy: string };

export const ABOUT_VALUES_HEAD = {
  eyebrow: "What we're building",
  title: "Principles that shape the product.",
  copy: "Four commitments that decide what ships and what doesn't.",
};

export const ABOUT_VALUES: ValueCard[] = [
  {
    icon: "compass",
    title: "Product philosophy",
    copy: "Software for business owners, not developers. If you can use WhatsApp, you can run OmniFlow: no code, no consultants, no six-week onboarding.",
  },
  {
    icon: "eye",
    title: "Transparent by default",
    copy: "No black boxes. Every AI decision and automation step is visible: why a lead was qualified, why a follow-up was sent, where a conversation went.",
  },
  {
    icon: "heart-hand",
    title: "Humans stay in control",
    copy: "AI does the repetitive work; people do the human work. Handoffs are one click, with the full conversation in front of you.",
  },
  {
    icon: "map",
    title: "Where we're going",
    copy: "WhatsApp, Telegram and website chat are live, Instagram is in early access, and more channels plug into the same intelligence layer as OmniFlow expands.",
  },
];

export const SECURITY_AREAS: ValueCard[] = [
  {
    icon: "key",
    title: "Credentials stay server-side",
    copy: "Provider keys (WhatsApp, gateways, AI engines) are stored on the server and never returned to the browser. The portal only ever sees masked values.",
  },
  {
    icon: "lock",
    title: "Session-based access control",
    copy: "The portal runs on authenticated server sessions with httpOnly cookies. No tokens in browser storage, no client-side secrets.",
  },
  {
    icon: "user-check",
    title: "Workspace isolation",
    copy: "Every query is scoped to your workspace. Your conversations, customers and automation data are separated per account.",
  },
  {
    icon: "hand",
    title: "Human handoff, always",
    copy: "Automation never locks you out. Any conversation can be taken over by a human at any moment.",
  },
  {
    icon: "eye",
    title: "Transparent automation",
    copy: "Every AI action leaves a visible trail: why a lead was qualified, what was sent, what ran. You can audit the system's behavior anytime.",
  },
  {
    icon: "shield",
    title: "Your data stays yours",
    copy: "Customer conversations belong to your business. OmniFlow is built privacy-first: you define what the AI may use, and data is never sold or shared.",
  },
];

export const SECURITY_NOTE =
  "We describe only what OmniFlow actually implements today. As the platform grows, this page grows with it: no certification badges before the audits behind them.";

export const CONTACT_CARDS = {
  email: {
    title: "Email us",
    copy: "Best for product questions, early access and custom automation requests.",
  },
  demo: {
    title: "See it on your channel first",
    copy: "The fastest way to understand OmniFlow is to watch it answer. Join early access and we'll walk you through it on the channel your customers already use.",
    cta: "Start Building",
  },
};

/** Sample exchange per CMS use case (u1..u5), in order. */
export const USE_CASE_SAMPLES: { q: string; a: string }[] = [
  { q: "Black hoodie medium available hai?", a: "Ji haan, medium available hai. Order link bhej raha hoon." },
  { q: "Kal 5pm ki appointment chahiye", a: "Book ho gayi. Reminder 4pm ko bhej dunga." },
  { q: "DHA me 2 bed budget?", a: "Aap ke budget range me 3 options hain. Details bhejta hoon." },
  { q: "Aap ki services ke rates?", a: "Aap ki requirement note kar ke team se connect kar raha hoon." },
  { q: "Order cancel karna hai", a: "Policy ke mutabiq ho sakta hai. Aap ko human agent se mila raha hoon." },
];

/** Small labels on the blog pages. */
export const BLOG_COPY = {
  readArticle: "Read the article",
  featuredQuote: "\u201cCustomers don't wait. Neither should your answers.\u201d",
  indexCta: "Get the platform these posts are about",
  allArticles: "All articles",
  keepReading: "Keep reading",
};
