import type { IconName } from "./types";

export type TemplateCategory = "sales" | "support" | "commerce" | "scheduling";

export const TEMPLATE_CATEGORIES: { key: TemplateCategory | "all"; label: string }[] = [
  { key: "all", label: "All templates" },
  { key: "sales", label: "Sales" },
  { key: "support", label: "Support" },
  { key: "commerce", label: "E-commerce" },
  { key: "scheduling", label: "Scheduling" },
];

export type AutomationTemplate = {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  category: TemplateCategory;
  steps: string[];
  cta: string;
};

/** Ready-to-use automation templates shown on the homepage. */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "sales-qualification",
    icon: "target",
    title: "Sales qualification",
    description: "Ask the right questions, score intent and hand qualified buyers to your sales team.",
    category: "sales",
    steps: ["Detect buying intent", "Ask budget and need", "Score and tag the lead", "Notify sales"],
    cta: "Use template",
  },
  {
    id: "customer-support",
    icon: "headphones",
    title: "Customer support",
    description: "Answer common questions from your knowledge and escalate edge cases with full context.",
    category: "support",
    steps: ["Understand the issue", "Answer from knowledge", "Escalate when unsure", "Log the outcome"],
    cta: "Use template",
  },
  {
    id: "product-inquiry",
    icon: "bag",
    title: "Product inquiry",
    description: "Share price, availability and details for the exact product a customer asks about.",
    category: "commerce",
    steps: ["Identify the product", "Check availability", "Send details and price", "Offer the order link"],
    cta: "Use template",
  },
  {
    id: "order-status",
    icon: "truck",
    title: "Order status",
    description: "Find the order, share its delivery status and answer follow-up questions instantly.",
    category: "commerce",
    steps: ["Match the customer", "Look up the order", "Share delivery status", "Offer human help"],
    cta: "Use template",
  },
  {
    id: "lead-follow-up",
    icon: "send",
    title: "Lead follow-up",
    description: "Keep interested leads warm with timed, personal follow-ups that stop when they reply.",
    category: "sales",
    steps: ["Tag interested leads", "Wait the set delay", "Send a personal follow-up", "Stop on reply"],
    cta: "Use template",
  },
  {
    id: "abandoned-follow-up",
    icon: "refresh",
    title: "Abandoned customer follow-up",
    description: "Re-engage customers who asked about a product but never completed the order.",
    category: "commerce",
    steps: ["Spot unfinished orders", "Remind with the product", "Answer objections", "Resend the order link"],
    cta: "Use template",
  },
  {
    id: "appointment-booking",
    icon: "calendar",
    title: "Appointment booking",
    description: "Collect the preferred time, confirm the booking and send a reminder before it starts.",
    category: "scheduling",
    steps: ["Read the requested time", "Confirm the slot", "Save the booking", "Send a reminder"],
    cta: "Use template",
  },
  {
    id: "faq-automation",
    icon: "help",
    title: "FAQ automation",
    description: "Turn your top questions into instant, accurate answers in the customer's language.",
    category: "support",
    steps: ["Match the question", "Answer from your FAQ", "Suggest the next step", "Hand off if needed"],
    cta: "Use template",
  },
  {
    id: "ecommerce-assistant",
    icon: "store",
    title: "E-commerce customer assistant",
    description: "One assistant for products, orders, delivery and returns across your store.",
    category: "commerce",
    steps: ["Understand the request", "Apply store policies", "Run the right workflow", "Confirm with the customer"],
    cta: "Use template",
  },
];
