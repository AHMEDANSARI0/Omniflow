"use client";

import { motion } from "motion/react";
import type { AiIntelligenceContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

export default function AIIntelligence({
  content,
}: {
  content: AiIntelligenceContent;
}) {
  const intelligenceItems = [1, 2, 3].map((i) => ({
    number: `0${i}`,
    title: content[`i${i}_title`] as string,
    description: content[`i${i}_desc`] as string,
    tags: (content[`i${i}_tags`] as string)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  }));

  return (
    <section
      id="intelligence"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#06101d] py-28 sm:py-36"
    >
      {/* Background — static glow (perf-safe) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[15%] h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.06)_0%,transparent_70%)]" />
      </div>

      {/* Kinetic hexagon grid */}
      <HexGrid opacity={0.07} />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7 }}
            className="inline-flex items-center gap-2 rounded-full border border-cyan-400/15 bg-cyan-400/[0.035] px-4 py-2"
          >
            <span className="of-pulse h-1.5 w-1.5 rounded-full bg-cyan-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-300/80">
              {content.badge}
            </span>
          </motion.div>

          <motion.h2
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{
              duration: 0.8,
              delay: 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl"
          >
            {content.heading_line1}
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7, delay: 0.18 }}
            className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base"
          >
            {content.description}
          </motion.p>
        </div>

        {/* AI visual */}
        <motion.div
          initial={{ opacity: 0, y: 35, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{
            duration: 0.9,
            delay: 0.2,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="relative mx-auto mt-16 max-w-5xl"
        >
          {/* Outer glow */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.075)_0%,transparent_70%)]" />

          <div className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#081522]/95 p-5 shadow-2xl sm:p-7 lg:p-9">
            {/* Top bar */}
            <div className="flex flex-col gap-4 border-b border-white/[0.06] pb-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.7)]" />

                  <span className="text-xs font-medium text-white">
                    OmniFlow Intelligence Engine
                  </span>
                </div>

                <p className="mt-1 text-[10px] text-slate-600">
                  Real-time conversation processing
                </p>
              </div>

              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-400/10 bg-emerald-400/[0.03] px-3 py-1.5">
                <span className="of-pulse h-1.5 w-1.5 rounded-full bg-emerald-400" />

                <span className="text-[9px] text-emerald-300">Processing</span>
              </div>
            </div>

            {/* Main visualization */}
            <div className="relative mt-8 grid items-center gap-8 lg:grid-cols-[1fr_auto_1fr]">
              {/* Input */}
              <IntelligencePanel
                title="Customer message"
                subtitle="Incoming conversation"
                side="left"
              >
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <p className="text-xs leading-6 text-slate-400">
                    “Hi, I&apos;m interested in your service. Can you tell me
                    how it works?”
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Tag label="Question" />
                  <Tag label="Sales intent" />
                </div>
              </IntelligencePanel>

              {/* Center AI */}
              <div className="relative flex justify-center">
                <div
                  className="of-spin-slow absolute h-40 w-40 rounded-full border border-dashed border-cyan-400/15"
                  style={{ animationDuration: "16s" }}
                />

                <div
                  className="of-spin-rev absolute h-28 w-28 rounded-full border border-dashed border-violet-400/15"
                  style={{ animationDuration: "12s" }}
                />

                <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl border border-cyan-400/20 bg-[#0b1a2a] shadow-[0_0_50px_rgba(34,211,238,0.1)]">
                  <span className="of-pulse absolute h-10 w-10 rounded-full bg-cyan-400/[0.12] blur-xl" />

                  <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06]">
                    <span className="text-lg text-cyan-300">✦</span>
                  </div>
                </div>

                {/* Processing dots */}
                <div className="absolute -bottom-8 flex items-center gap-1">
                  {[0, 1, 2].map((item) => (
                    <span
                      key={item}
                      className="of-pulse h-1 w-1 rounded-full bg-cyan-400"
                      style={{
                        animationDelay: `${item * 0.18}s`,
                        animationDuration: "1.2s",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Output */}
              <IntelligencePanel
                title="AI response"
                subtitle="Action generated"
                side="right"
              >
                <div className="rounded-xl border border-cyan-400/10 bg-cyan-400/[0.025] p-4">
                  <p className="text-xs leading-6 text-slate-400">
                    “Absolutely. OmniFlow connects your customer channels and
                    automates conversations using AI.”
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Tag label="Response ready" active />
                  <Tag label="Workflow" active />
                </div>
              </IntelligencePanel>
            </div>

            {/* Bottom pipeline */}
            <div className="mt-14 grid gap-3 border-t border-white/[0.06] pt-6 sm:grid-cols-3">
              {["Intent detected", "Context understood", "Action selected"].map(
                (item, index) => (
                  <motion.div
                    key={item}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.45 + index * 0.1 }}
                    className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-cyan-400/10 bg-cyan-400/[0.04] text-[9px] text-cyan-300">
                      0{index + 1}
                    </span>

                    <span className="text-[10px] text-slate-500">{item}</span>

                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </motion.div>
                ),
              )}
            </div>
          </div>
        </motion.div>

        {/* Three intelligence pillars */}
        <div className="mt-16 grid gap-4 md:grid-cols-3">
          {intelligenceItems.map((item, index) => (
            <motion.div
              key={item.number}
              initial={{ opacity: 0, y: 25 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.7, delay: index * 0.1 }}
              whileHover={{ y: -5 }}
              className="group rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 transition-colors duration-500 hover:border-cyan-400/10 hover:bg-white/[0.025]"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium tracking-[0.15em] text-cyan-400/60">
                  {item.number}
                </span>

                <span className="text-slate-700 transition-colors duration-300 group-hover:text-cyan-400/50">
                  →
                </span>
              </div>

              <h3 className="mt-7 font-[var(--font-heading)] text-xl font-semibold tracking-[-0.03em] text-white">
                {item.title}
              </h3>

              <p className="mt-3 text-sm leading-6 text-slate-600">
                {item.description}
              </p>

              <div className="mt-5 flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-white/[0.05] px-2.5 py-1 text-[9px] text-slate-600"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntelligencePanel({
  title,
  subtitle,
  side,
  children,
}: {
  title: string;
  subtitle: string;
  side: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: side === "left" ? -20 : 20 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, delay: side === "left" ? 0.25 : 0.35 }}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
    >
      <div className="mb-4">
        <div className="text-xs font-medium text-slate-300">{title}</div>

        <div className="mt-1 text-[9px] text-slate-700">{subtitle}</div>
      </div>

      {children}
    </motion.div>
  );
}

function Tag({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[9px] ${
        active
          ? "border-cyan-400/10 bg-cyan-400/[0.035] text-cyan-400/70"
          : "border-white/[0.05] text-slate-700"
      }`}
    >
      {label}
    </span>
  );
}
