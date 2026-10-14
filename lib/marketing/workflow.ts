import type { IconName } from "./types";

export type StoryNode = {
  key: string;
  icon: IconName;
  label: string;
  description: string;
  /** Short live-status line shown on the node. */
  status: string;
};

/**
 * The OmniFlow core story: a customer message travelling through the
 * intelligence layer until an action runs. Rendered as connected nodes.
 */
export const STORY_NODES: StoryNode[] = [
  {
    key: "message",
    icon: "message",
    label: "Customer message",
    description: "A customer writes in their own words, on the channel they already use.",
    status: "Received in real time",
  },
  {
    key: "understand",
    icon: "brain",
    label: "AI understanding",
    description: "OmniFlow reads meaning, language and sentiment instead of matching keywords.",
    status: "Message understood",
  },
  {
    key: "context",
    icon: "book",
    label: "Business context",
    description: "Products, prices, policies and customer history are applied to the conversation.",
    status: "Context applied",
  },
  {
    key: "intent",
    icon: "target",
    label: "Intent detection",
    description: "Purchase signals, support needs and urgency are identified automatically.",
    status: "Intent detected",
  },
  {
    key: "decision",
    icon: "branch",
    label: "Workflow decision",
    description: "Your rules and conditions decide the right next step for this conversation.",
    status: "Path selected",
  },
  {
    key: "action",
    icon: "zap",
    label: "Automated action",
    description: "OmniFlow replies, sends links, routes to your team or schedules a follow-up.",
    status: "Action completed",
  },
];
