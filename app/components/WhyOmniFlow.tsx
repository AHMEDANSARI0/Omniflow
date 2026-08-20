"use client";

import { motion } from "motion/react";
import type { WhyOmniFlowContent } from "../../lib/content-defaults";

/* ============================================================
   Types
   ============================================================ */

type Accent = "cyan" | "blue" | "violet";

interface Benefit {
  number: string;
  title: string;
  description: string;
  accent: Accent;
}

interface ActivityEvent {
  icon: string;
  text: string;
  time: string;
  accent: Accent;
}

/* ============================================================
   Data
   ============================================================ */

const benefitMeta: { number: string; accent: Accent }[] = [
  { number: "01", accent: "cyan" },
  { number: "02", accent: "blue" },
  { number: "03", accent: "violet" },
  { number: "04", accent: "cyan" },
];

const activityEvents: ActivityEvent[] = [
  { icon: "✦", text: "Answered a product question", time: "just now", accent: "cyan" },
  { icon: "◎", text: "Qualified a new lead", time: "1m ago", accent: "blue" },
  { icon: "↗", text: "Sent a scheduled follow-up", time: "3m ago", accent: "violet" },
  { icon: "◇", text: "Routed a conversation to sales", time: "6m ago", accent: "cyan" },
  { icon: "◉", text: "Captured a booking request", time: "9m ago", accent: "blue" },
];

/* ============================================================
   Accent styling (full literal classes — Tailwind-safe)
   ============================================================ */

const accentStyles: Record<
  Accent,
  { text: string; dot: string; numberText: string; hoverBorder: string }
> = {
  cyan: {
    text: "text-cyan-300",
    dot: "bg-cyan-400",
    numberText: "group-hover:text-cyan-300",
    hoverBorder: "group-hover:border-cyan-400/20",
  },
  blue: {
    text: "text-blue-300",
    dot: "bg-blue-400",
    numberText: "group-hover:text-blue-300",
    hoverBorder: "group-hover:border-blue-400/20",
  },
  violet: {
    text: "text-violet-300",
    dot: "bg-violet-400",
    numberText: "group-hover:text-violet-300",
    hoverBorder: "group-hover:border-violet-400/20",
  },
};

/* ============================================================
   Benefit row
   ============================================================ */

function BenefitRow({ benefit, index }: { benefit: Benefit; index: number }) {
  const accent = accentStyles[benefit.accent];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.55, ease: "easeOut", delay: index * 0.1 }}
      className={`group border-b border-white/[0.06] py-6 transition-colors duration-300 first:pt-0 last:border-b-0 sm:py-7 ${accent.hoverBorder}`}
    >
      <div className="flex gap-5 sm:gap-6">
        <span
          className={`font-mono text-sm tracking-widest text-slate-600 transition-colors duration-300 ${accent.numberText}`}
        >
          {benefit.number}
        </span>
        <div>
          <h3 className="text-base font-semibold text-white transition-transform duration-300 group-hover:translate-x-1 sm:text-lg">
            {benefit.title}
          </h3>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
            {benefit.description}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

/* ============================================================
   Activity feed visual
   ============================================================ */

function ActivityFeed() {
  return (
    <div className="relative">
      {/* Soft glow behind the card */}
      <div className="pointer-events-none absolute -inset-8 rounded-full bg-blue-500/[0.05] blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}
        className="relative rounded-2xl border border-white/[0.07] bg-[#081522]/95 p-5 sm:p-6"
      >
        {/* Card header */}
        <div className="mb-5 flex items-center justify-between border-b border-white/[0.05] pb-4">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
            </span>
            <span className="text-sm font-medium text-slate-300">
              Automation activity
            </span>
          </div>
          <span className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500">
            Live · 24/7
          </span>
        </div>

        {/* Event rows */}
        <div className="space-y-2.5">
          {activityEvents.map((event, i) => {
            const accent = accentStyles[event.accent];
            return (
              <motion.div
                key={event.text}
                initial={{ opacity: 0, x: 14 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, ease: "easeOut", delay: 0.3 + i * 0.12 }}
                className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3.5 py-3"
              >
                <span
                  className={`of-pulse flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-xs ${accent.text}`}
                  style={{ animationDelay: `${i * 0.6}s`, animationDuration: "3s" }}
                >
                  {event.icon}
                </span>
                <span className="flex-1 text-xs text-slate-300 sm:text-[13px]">
                  {event.text}
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">
                  {event.time}
                </span>
              </motion.div>
            );
          })}
        </div>

        {/* Card footer */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 1 }}
          className="mt-5 flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3"
        >
          <span className="text-[11px] text-slate-500">
            AI handling conversations while your team is offline
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-cyan-300">
            <span className="of-pulse h-1 w-1 rounded-full bg-cyan-400" />
            Active
          </span>
        </motion.div>
      </motion.div>

      {/* Floating chip */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 1.1 }}
        className="absolute -right-3 -top-4 sm:-right-5"
      >
        <div className="of-float flex items-center gap-2 rounded-xl border border-violet-400/20 bg-[#0a1727] px-3 py-2 shadow-lg shadow-black/30">
          <span className="text-xs text-violet-300">✦</span>
          <span className="text-[11px] font-medium text-slate-300">
            No conversation missed
          </span>
        </div>
      </motion.div>
    </div>
  );
}

/* ============================================================
   Section
   ============================================================ */

export default function WhyOmniFlow({
  content,
}: {
  content: WhyOmniFlowContent;
}) {
  const benefits: Benefit[] = benefitMeta.map((meta, index) => ({
    ...meta,
    title: content[`b${index + 1}_title`] as string,
    description: content[`b${index + 1}_desc`] as string,
  }));

  return (
    <section id="why-omniflow" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-0 top-1/4 h-[420px] w-[560px] rounded-full bg-cyan-500/[0.035] blur-3xl" />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
          {/* Left: heading + benefit rows */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            >
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.02] px-3.5 py-1.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400" />
                </span>
                <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
                  {content.badge}
                </span>
              </div>

              <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
                {content.heading_line1}{" "}
                <span className="bg-gradient-to-r from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
                  {content.heading_line2}
                </span>
              </h2>
              <p className="mt-4 max-w-lg text-base leading-relaxed text-slate-400 sm:text-lg">
                {content.description}
              </p>
            </motion.div>

            <div className="mt-10">
              {benefits.map((benefit, index) => (
                <BenefitRow key={benefit.number} benefit={benefit} index={index} />
              ))}
            </div>
          </div>

          {/* Right: activity feed visual */}
          <ActivityFeed />
        </div>
      </div>
    </section>
  );
}