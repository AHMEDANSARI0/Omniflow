"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { UseCasesContent } from "../../lib/content-defaults";

/* ============================================================
   Types
   ============================================================ */

type Accent = "cyan" | "blue" | "violet";

interface ChatLine {
  from: "customer" | "ai";
  text: string;
}

interface UseCase {
  id: string;
  label: string;
  icon: string;
  accent: Accent;
  headline: string;
  description: string;
  automations: string[];
  chat: ChatLine[];
  status: string;
}

/* ============================================================
   Static meta (icons, accents and demo chats stay fixed;
   labels, headlines, descriptions come from the CMS)
   ============================================================ */

interface UseCaseMeta {
  id: string;
  icon: string;
  accent: Accent;
  chat: ChatLine[];
}

const useCaseMeta: UseCaseMeta[] = [
  {
    id: "ecommerce",
    icon: "◈",
    accent: "cyan",
    chat: [
      { from: "customer", text: "Is the black hoodie available in medium?" },
      {
        from: "ai",
        text: "Yes — the black hoodie is in stock in medium. Want me to send the order link?",
      },
      { from: "customer", text: "Yes please!" },
    ],
  },
  {
    id: "services",
    icon: "◉",
    accent: "blue",
    chat: [
      { from: "customer", text: "Do you have a slot free on Saturday?" },
      {
        from: "ai",
        text: "We have openings Saturday at 11:00 and 15:30. Which works better for you?",
      },
      { from: "customer", text: "11:00 works." },
    ],
  },
  {
    id: "realestate",
    icon: "◆",
    accent: "violet",
    chat: [
      { from: "customer", text: "Is the 2-bed apartment still available?" },
      {
        from: "ai",
        text: "Yes, it is. May I ask your budget range so I can also suggest similar options?",
      },
      { from: "customer", text: "Around $120k." },
    ],
  },
  {
    id: "agencies",
    icon: "◇",
    accent: "cyan",
    chat: [
      { from: "customer", text: "Do you handle social media marketing?" },
      {
        from: "ai",
        text: "We do. Could you share your industry and monthly budget so I connect you with the right specialist?",
      },
      { from: "customer", text: "E-commerce, ~$2k/month." },
    ],
  },
  {
    id: "support",
    icon: "◎",
    accent: "blue",
    chat: [
      { from: "customer", text: "My order arrived damaged." },
      {
        from: "ai",
        text: "Sorry about that — I've found your order. I'm connecting you with our support team along with the details.",
      },
      { from: "customer", text: "Thank you." },
    ],
  },
];

/* ============================================================
   Accent styling (full literal classes — Tailwind-safe)
   ============================================================ */

const accentStyles: Record<
  Accent,
  {
    text: string;
    dot: string;
    activeTab: string;
    iconBox: string;
    statusBox: string;
    bubble: string;
  }
> = {
  cyan: {
    text: "text-cyan-300",
    dot: "bg-cyan-400",
    activeTab: "border-cyan-400/25 bg-cyan-400/[0.05]",
    iconBox: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
    statusBox: "border-cyan-400/15 bg-cyan-400/[0.04] text-cyan-300",
    bubble: "border-cyan-400/15 bg-cyan-400/[0.05]",
  },
  blue: {
    text: "text-blue-300",
    dot: "bg-blue-400",
    activeTab: "border-blue-400/25 bg-blue-400/[0.05]",
    iconBox: "border-blue-400/20 bg-blue-400/[0.06] text-blue-300",
    statusBox: "border-blue-400/15 bg-blue-400/[0.04] text-blue-300",
    bubble: "border-blue-400/15 bg-blue-400/[0.05]",
  },
  violet: {
    text: "text-violet-300",
    dot: "bg-violet-400",
    activeTab: "border-violet-400/25 bg-violet-400/[0.05]",
    iconBox: "border-violet-400/20 bg-violet-400/[0.06] text-violet-300",
    statusBox: "border-violet-400/15 bg-violet-400/[0.04] text-violet-300",
    bubble: "border-violet-400/15 bg-violet-400/[0.05]",
  },
};

/* ============================================================
   Detail panel
   ============================================================ */

function UseCasePanel({ useCase }: { useCase: UseCase }) {
  const accent = accentStyles[useCase.accent];

  return (
    <motion.div
      key={useCase.id}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="grid gap-8 p-6 sm:p-8 lg:grid-cols-2 lg:gap-10"
    >
      {/* Left: description + automations */}
      <div>
        <div
          className={`mb-5 inline-flex h-10 w-10 items-center justify-center rounded-xl border text-base ${accent.iconBox}`}
        >
          {useCase.icon}
        </div>

        <h3 className="text-xl font-semibold text-white sm:text-2xl">
          {useCase.headline}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-slate-400 sm:text-base">
          {useCase.description}
        </p>

        <div className="mt-6 space-y-3">
          {useCase.automations.map((item, i) => (
            <motion.div
              key={item}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.15 + i * 0.1 }}
              className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
              <span className="text-sm text-slate-300">{item}</span>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Right: mini conversation preview */}
      <div className="flex flex-col justify-center">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
          <div className="mb-4 flex items-center justify-between border-b border-white/[0.05] pb-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-1.5 w-1.5">
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${accent.dot}`}
                />
                <span
                  className={`relative inline-flex h-1.5 w-1.5 rounded-full ${accent.dot}`}
                />
              </span>
              <span className="text-xs font-medium text-slate-400">
                Live conversation
              </span>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-slate-600">
              AI active
            </span>
          </div>

          <div className="space-y-2.5">
            {useCase.chat.map((line, i) => (
              <motion.div
                key={`${useCase.id}-${i}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.25 + i * 0.18 }}
                className={`flex ${
                  line.from === "ai" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed sm:text-[13px] ${
                    line.from === "ai"
                      ? `rounded-br-sm border text-slate-300 ${accent.bubble}`
                      : "rounded-bl-sm border border-white/[0.06] bg-white/[0.02] text-slate-400"
                  }`}
                >
                  {line.text}
                </div>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.85 }}
            className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${accent.statusBox}`}
          >
            <span className="text-xs">⚡</span>
            <span>{useCase.status}</span>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

/* ============================================================
   Section
   ============================================================ */

export default function UseCases({ content }: { content: UseCasesContent }) {
  const useCases: UseCase[] = useCaseMeta.map((meta, index) => ({
    ...meta,
    label: content[`u${index + 1}_label`] as string,
    headline: content[`u${index + 1}_headline`] as string,
    description: content[`u${index + 1}_desc`] as string,
    automations: (content[`u${index + 1}_automations`] as string)
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean),
    status: content[`u${index + 1}_status`] as string,
  }));

  const [activeId, setActiveId] = useState<string>(useCases[0].id);
  const active = useCases.find((u) => u.id === activeId) ?? useCases[0];

  return (
    <section id="use-cases" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute right-0 top-1/3 h-[420px] w-[560px] rounded-full bg-violet-500/[0.04] blur-3xl" />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.02] px-3.5 py-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-400" />
            </span>
            <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
              {content.badge}
            </span>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
            {content.heading_line1}{" "}
            <span className="bg-gradient-to-r from-violet-300 via-blue-300 to-cyan-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">
            {content.description}
          </p>
        </motion.div>

        {/* Tabs + panel */}
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
          className="mt-14 sm:mt-16"
        >
          {/* Tab bar */}
          <div className="flex flex-wrap justify-center gap-2 sm:gap-2.5">
            {useCases.map((useCase) => {
              const isActive = useCase.id === activeId;
              const accent = accentStyles[useCase.accent];
              return (
                <button
                  key={useCase.id}
                  type="button"
                  onClick={() => setActiveId(useCase.id)}
                  className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium transition-colors duration-300 sm:text-sm ${
                    isActive
                      ? `${accent.activeTab} text-white`
                      : "border-white/[0.06] bg-white/[0.015] text-slate-400 hover:border-white/[0.12] hover:text-slate-200"
                  }`}
                >
                  <span
                    className={`text-sm ${isActive ? accent.text : "text-slate-500"}`}
                  >
                    {useCase.icon}
                  </span>
                  {useCase.label}
                </button>
              );
            })}
          </div>

          {/* Detail panel */}
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015] sm:mt-8">
            <AnimatePresence mode="wait">
              <UseCasePanel key={active.id} useCase={active} />
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </section>
  );
}