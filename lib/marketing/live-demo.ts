import type { IconName } from "./types";

export type DemoScenario = {
  id: string;
  icon: IconName;
  label: string;
  channel: string;
  customer: { name: string; message: string };
  understanding: string[];
  workflow: string[];
  reply: string;
  outcome: string;
};

/** Timing for the live demo run (ms). One run per view, no loops. */
export const DEMO_TIMING = { stepMs: 650, startDelayMs: 500 } as const;

/**
 * Realistic OmniFlow conversations. Customer messages stay in the
 * customer's own language (Roman Urdu), as in production.
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "product-inquiry",
    icon: "bag",
    label: "Product inquiry",
    channel: "WhatsApp",
    customer: {
      name: "Ahmed R.",
      message: "Black hoodie medium available hai? Price aur delivery bata dein.",
    },
    understanding: [
      "Product identified",
      "Size identified",
      "Availability checked",
      "Customer context loaded",
      "Purchase intent detected",
    ],
    workflow: ["Send product information", "Send order link", "Schedule follow-up"],
    reply: "Ji haan, medium available hai. Price Rs 4,500, Karachi delivery 2 din. Order link bhej raha hoon.",
    outcome: "Automation completed",
  },
  {
    id: "order-status",
    icon: "truck",
    label: "Order status",
    channel: "Instagram",
    customer: { name: "Sana K.", message: "Mera order kab tak pohanchay ga?" },
    understanding: ["Customer matched", "Latest order found", "Courier status fetched", "Delivery question detected"],
    workflow: ["Share delivery status", "Send tracking link", "Offer human help"],
    reply: "Aap ka order dispatch ho chuka hai aur kal tak pohanch jayega. Tracking link yeh raha.",
    outcome: "Resolved without a human",
  },
  {
    id: "appointment",
    icon: "calendar",
    label: "Appointment booking",
    channel: "Telegram",
    customer: { name: "Bilal M.", message: "Kal shaam 5 baje appointment mil sakti hai?" },
    understanding: ["Date and time read", "Availability checked", "Booking intent detected"],
    workflow: ["Confirm the slot", "Save the booking", "Schedule a reminder"],
    reply: "Kal 5 baje ka slot confirm ho gaya. Ek ghanta pehle reminder bhej dunga.",
    outcome: "Booking confirmed",
  },
];
