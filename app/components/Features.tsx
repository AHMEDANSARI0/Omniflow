"use client";

import { motion } from "motion/react";
import type { FeaturesContent } from "../../lib/content-defaults";

/* ============================================================
   Types
   ============================================================ */

type Accent = "cyan" | "blue" | "violet";
type CardSize = "large" | "small";

interface Feature {
  number: string;
  title: string;
  description: string;
  icon: string;
  size: CardSize;
  accent: Accent;
}

/* ============================================================
   Static card meta (icons, sizes, accents stay fixed;
   titles/descriptions come from the CMS)
   ============================================================ */

const featureMeta: {
  number: string;
  icon: string;
  size: CardSize;
  accent: Accent;
}[] = [
  { number: "01", icon: "✦", size: "large", accent: "cyan" },
  { number: "02", icon: "◎", size: "small", accent: "blue" },
  { number: "03", icon: "↗", size: "small", accent: "violet" },
  { number: "04", icon: "◇", size: "small", accent: "cyan" },
  { number: "05", icon: "⌘", size: "large", accent: "blue" },
  { number: "06", icon: "◌", size: "small", accent: "violet" },
];

/* ============================================================
   Accent styling (full literal classes — Tailwind-safe)
   ============================================================ */

const accentStyles: Record<
  Accent,
  {
    text: string;
    iconBox: string;
    dot: string;
    cardGlow: string;
    hoverBorder: string;
  }
> = {
  cyan: {
    text: "text-cyan-400",
    iconBox: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
    dot: "bg-cyan-400",
    cardGlow: "bg-cyan-500/[0.05]",
    hoverBorder: "group-hover:border-cyan-400/20",
  },
  blue: {
    text: "text-blue-400",
    iconBox: "border-blue-400/20 bg-blue-400/[0.06] text-blue-300",
    dot: "bg-blue-400",
    cardGlow: "bg-blue-500/[0.05]",
    hoverBorder: "group-hover:border-blue-400/20",
  },
  violet: {
    text: "text-violet-400",
    iconBox: "border-violet-400/20 bg-violet-400/[0.06] text-violet-300",
    dot: "bg-violet-400",
    cardGlow: "bg-violet-500/[0.05]",
    hoverBorder: "group-hover:border-violet-400/20",
  },
};

/* ============================================================
   Mini visualizations (one per feature)
   ============================================================ */

function VisualConversations() {
  return (
    <div className="mt-6 space-y-2.5">
      <div className="flex justify-start">
        <div className="rounded-xl rounded-bl-sm border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-slate-400">
          Do you ship internationally?
        </div>
      </div>
      <div className="flex justify-end">
        <div className="rounded-xl rounded-br-sm border border-cyan-400/15 bg-cyan-400/[0.05] px-3 py-2 text-xs text-slate-300">
          Yes — we deliver to 40+ countries. Want a shipping estimate?
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-1 pt-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full bg-cyan-400/70"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
        <span className="ml-1 text-[10px] uppercase tracking-wider text-slate-500">
          AI responding
        </span>
      </div>
    </div>
  );
}

function VisualQualification() {
  const bars = [
    { label: "Intent", value: "92%", width: "92%" },
    { label: "Fit", value: "78%", width: "78%" },
  ];
  return (
    <div className="mt-6 space-y-3">
      {bars.map((bar) => (
        <div key={bar.label}>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
            <span>{bar.label}</span>
            <span className="text-blue-300">{bar.value}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.05]">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-blue-500/70 to-cyan-400/70"
              initial={{ width: 0 }}
              whileInView={{ width: bar.width }}
              viewport={{ once: true }}
              transition={{ duration: 1.1, ease: "easeOut", delay: 0.3 }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function VisualFollowUps() {
  const steps = ["Sent", "No reply · 24h", "Follow-up sent"];
  return (
    <div className="mt-6 space-y-2.5">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2.5">
          <motion.span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 2, repeat: Infinity, delay: i * 0.5 }}
          />
          <span className="text-xs text-slate-500">{step}</span>
        </div>
      ))}
    </div>
  );
}

function VisualRouting() {
  const targets = ["Sales", "Support", "AI agent"];
  return (
    <div className="mt-6">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
        <span className="text-xs text-slate-500">Incoming conversation</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {targets.map((target, i) => (
          <motion.span
            key={target}
            className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-400"
            animate={{
              borderColor: [
                "rgba(255,255,255,0.06)",
                "rgba(34,211,238,0.35)",
                "rgba(255,255,255,0.06)",
              ],
            }}
            transition={{ duration: 3, repeat: Infinity, delay: i * 1 }}
          >
            {target}
          </motion.span>
        ))}
      </div>
    </div>
  );
}

function VisualWorkflows() {
  const nodes = ["Trigger", "Condition", "Action"];
  return (
    <div className="mt-6 flex items-center gap-2 sm:gap-3">
      {nodes.map((node, i) => (
        <div key={node} className="flex items-center gap-2 sm:gap-3">
          <motion.div
            className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[10px] text-slate-400 sm:px-3 sm:text-xs"
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 + i * 0.15 }}
          >
            <span className="mr-1.5 inline-block h-1 w-1 rounded-full bg-blue-400 align-middle" />
            {node}
          </motion.div>
          {i < nodes.length - 1 && (
            <motion.span
              className="h-px w-4 bg-gradient-to-r from-blue-400/40 to-transparent sm:w-6"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 2, repeat: Infinity, delay: i * 0.4 }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function VisualMultiChannel() {
  const channels = ["WA", "IG", "MS", "TG"];
  return (
    <div className="mt-6 flex items-center gap-2">
      {channels.map((channel, i) => (
        <motion.span
          key={channel}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.02] text-[9px] font-medium text-slate-500"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.3 }}
        >
          {channel}
        </motion.span>
      ))}
      <span className="mx-1 h-px w-3 bg-white/10" />
      <span className="rounded-md border border-violet-400/20 bg-violet-400/[0.06] px-2 py-1 text-[10px] text-violet-300">
        One layer
      </span>
    </div>
  );
}

const visuals: Record<string, () => React.ReactElement> = {
  "01": VisualConversations,
  "02": VisualQualification,
  "03": VisualFollowUps,
  "04": VisualRouting,
  "05": VisualWorkflows,
  "06": VisualMultiChannel,
};

/* ============================================================
   Feature card
   ============================================================ */

function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const accent = accentStyles[feature.accent];
  const Visual = visuals[feature.number];

  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: "easeOut", delay: (index % 3) * 0.1 }}
      whileHover={{ y: -5 }}
      className={`group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 transition-colors duration-300 sm:p-7 ${accent.hoverBorder} ${
        feature.size === "large" ? "md:col-span-2" : ""
      }`}
    >
      {/* Subtle hover glow */}
      <div
        className={`pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl opacity-0 transition-opacity duration-500 group-hover:opacity-100 ${accent.cardGlow}`}
      />

      <div className="relative">
        {/* Header row */}
        <div className="mb-5 flex items-start justify-between">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-xl border text-base ${accent.iconBox}`}
          >
            {feature.icon}
          </div>
          <span className="font-mono text-xs tracking-widest text-slate-600">
            {feature.number}
          </span>
        </div>

        <h3 className="text-base font-semibold text-white sm:text-lg">
          {feature.title}
        </h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
          {feature.description}
        </p>

        <Visual />
      </div>
    </motion.div>
  );
}

/* ============================================================
   Section
   ============================================================ */

export default function Features({ content }: { content: FeaturesContent }) {
  const features: Feature[] = featureMeta.map((meta, index) => ({
    ...meta,
    title: content[`f${index + 1}_title`] as string,
    description: content[`f${index + 1}_desc`] as string,
  }));

  const capabilities = content.capabilities
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section id="features" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-blue-500/[0.04] blur-3xl" />

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
              {content.badge}
            </span>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
            {content.heading_line1}{" "}
            <span className="bg-gradient-to-r from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">
            {content.description}
          </p>
        </motion.div>

        {/* Feature grid */}
        <div className="mt-14 grid gap-4 sm:mt-16 sm:gap-5 md:grid-cols-3">
          {features.map((feature, index) => (
            <FeatureCard key={feature.number} feature={feature} index={index} />
          ))}
        </div>

        {/* Capability strip */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.15 }}
          className="mt-10 rounded-2xl border border-white/[0.05] bg-white/[0.015] px-6 py-5 sm:mt-12"
        >
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            {capabilities.map((capability, i) => (
              <div key={capability} className="flex items-center gap-2">
                <motion.span
                  className={`h-1 w-1 rounded-full ${
                    accentStyles[
                      (["cyan", "blue", "violet"] as Accent[])[i % 3]
                    ].dot
                  }`}
                  animate={{ opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 2.6, repeat: Infinity, delay: i * 0.35 }}
                />
                <span className="text-xs text-slate-500 sm:text-sm">
                  {capability}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}