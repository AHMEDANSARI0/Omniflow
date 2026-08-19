"use client";

import { motion } from "motion/react";

/* ============================================================
   Types
   ============================================================ */

type Accent = "cyan" | "blue" | "violet";

interface TrustPillar {
  icon: string;
  title: string;
  description: string;
  accent: Accent;
}

/* ============================================================
   Data
   ============================================================ */

const pillars: TrustPillar[] = [
  {
    icon: "◇",
    title: "You stay in control",
    description:
      "Define exactly what the AI can say and do. Every workflow, rule and boundary is configured by you — not decided for you.",
    accent: "cyan",
  },
  {
    icon: "◎",
    title: "Humans always in the loop",
    description:
      "Automation never locks your team out. Any conversation can be taken over by a human at any moment, with full context.",
    accent: "blue",
  },
  {
    icon: "✦",
    title: "Transparent automation",
    description:
      "No black boxes. See why the AI qualified a lead, triggered a follow-up or routed a conversation — every step is visible.",
    accent: "violet",
  },
  {
    icon: "◆",
    title: "Your data stays yours",
    description:
      "Customer conversations belong to your business. OmniFlow is being built privacy-first, from the architecture up.",
    accent: "cyan",
  },
];

const principles: string[] = [
  "No black boxes",
  "Human handoff anytime",
  "You define the rules",
  "Privacy-first architecture",
];

/* ============================================================
   Accent styling (full literal classes — Tailwind-safe)
   ============================================================ */

const accentStyles: Record<
  Accent,
  { iconBox: string; dot: string; hoverBorder: string }
> = {
  cyan: {
    iconBox: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
    dot: "bg-cyan-400",
    hoverBorder: "hover:border-cyan-400/20",
  },
  blue: {
    iconBox: "border-blue-400/20 bg-blue-400/[0.06] text-blue-300",
    dot: "bg-blue-400",
    hoverBorder: "hover:border-blue-400/20",
  },
  violet: {
    iconBox: "border-violet-400/20 bg-violet-400/[0.06] text-violet-300",
    dot: "bg-violet-400",
    hoverBorder: "hover:border-violet-400/20",
  },
};

/* ============================================================
   Section
   ============================================================ */

export default function Trust() {
  return (
    <section id="trust" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[380px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/[0.03] blur-3xl" />

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
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
            </span>
            <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
              Built on trust
            </span>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
            Automation you can{" "}
            <span className="bg-gradient-to-r from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
              actually trust
            </span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">
            Handing conversations to AI is a serious decision. OmniFlow is
            designed so you never trade control for automation.
          </p>
        </motion.div>

        {/* Pillar cards */}
        <div className="mt-14 grid gap-4 sm:mt-16 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
          {pillars.map((pillar, index) => {
            const accent = accentStyles[pillar.accent];
            return (
              <motion.div
                key={pillar.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{
                  duration: 0.55,
                  ease: "easeOut",
                  delay: index * 0.1,
                }}
                className={`rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 transition-colors duration-300 ${accent.hoverBorder}`}
              >
                <div
                  className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl border text-base ${accent.iconBox}`}
                >
                  {pillar.icon}
                </div>
                <h3 className="text-base font-semibold text-white">
                  {pillar.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {pillar.description}
                </p>
              </motion.div>
            );
          })}
        </div>

        {/* Principles strip */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
          className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-8 gap-y-3 sm:mt-12"
        >
          {principles.map((principle, i) => (
            <div key={principle} className="flex items-center gap-2">
              <motion.span
                className={`h-1 w-1 rounded-full ${
                  accentStyles[(["cyan", "blue", "violet"] as Accent[])[i % 3]].dot
                }`}
                animate={{ opacity: [0.35, 1, 0.35] }}
                transition={{ duration: 2.6, repeat: Infinity, delay: i * 0.4 }}
              />
              <span className="text-xs text-slate-500 sm:text-sm">
                {principle}
              </span>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
