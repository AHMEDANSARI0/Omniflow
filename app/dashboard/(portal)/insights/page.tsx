import type { Metadata } from "next";
import InsightsClient from "./InsightsClient";

export const metadata: Metadata = { title: "Business insights" };

/**
 * Business insights: what customers ask about, what is going wrong and
 * why (the Problem Detector), how well the assistant is doing, and where
 * customers stall in the journey. Everything is mined from data the
 * workspace already collects - no extra AI cost.
 */
export default function InsightsPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Business insights
        </h1>
        <p className="mt-1 text-sm text-ink-3">
          Problems worth fixing this week, with the evidence behind each one.
          Then what customers talk about, how the assistant is performing,
          and where customers stall in their journey.
        </p>
      </div>
      <InsightsClient />
    </div>
  );
}
