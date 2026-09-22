import type { Metadata } from "next";

import BrainCard from "../settings/BrainCard";

export const metadata: Metadata = { title: "AI Brain" };

/**
 * AI Brain: the assistant's autonomy level and tone live here (the
 * same BrainCard that also appears on Settings). Autonomy is the
 * global gate for anything the assistant does on its own.
 */
export default function AiBrainPage() {
  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            AI Brain
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Control how the assistant behaves - whether it only
            suggests, drafts replies for approval, or acts on its own,
            and the tone it uses with your customers.
          </p>
        </div>

        <BrainCard />
      </div>
    </main>
  );
}
