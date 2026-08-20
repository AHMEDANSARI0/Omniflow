"use client";

import { motion } from "motion/react";
import type { CustomerMemoryContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

const memoryItems = [
  { label: "Customer", value: "Ahmed" },
  { label: "Intent", value: "Product inquiry" },
  { label: "Status", value: "Qualified" },
  { label: "History", value: "12 conversations" },
];

export default function CustomerMemory({
  content,
}: {
  content: CustomerMemoryContent;
}) {
  const contextItems = content.context_items
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section
      id="memory"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#06101d] py-28 sm:py-36"
    >
      {/* Background — static glow (perf-safe) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute right-[5%] top-[10%] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.06)_0%,transparent_70%)]" />
      </div>

      {/* Kinetic hexagon grid */}
      <HexGrid opacity={0.07} />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid items-center gap-16 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
          {/* Left content */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.7 }}
              className="inline-flex items-center gap-2 rounded-full border border-violet-400/10 bg-violet-400/[0.035] px-4 py-2"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />

              <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-300/80">
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

              <span className="bg-gradient-to-r from-violet-300 via-blue-400 to-cyan-300 bg-clip-text text-transparent">
                {content.heading_line2}
              </span>
            </motion.h2>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.7, delay: 0.18 }}
              className="mt-6 max-w-xl text-sm leading-7 text-slate-500 sm:text-base"
            >
              {content.description}
            </motion.p>

            {/* Context points */}
            <div className="mt-8 space-y-3">
              {contextItems.map((item, index) => (
                <motion.div
                  key={item}
                  initial={{ opacity: 0, x: -15 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: 0.3 + index * 0.08 }}
                  className="flex items-center gap-3"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-violet-400/10 bg-violet-400/[0.035] text-[9px] text-violet-300">
                    ✓
                  </span>

                  <span className="text-xs text-slate-500">{item}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Memory visualization */}
          <motion.div
            initial={{ opacity: 0, x: 40, scale: 0.96 }}
            whileInView={{ opacity: 1, x: 0, scale: 1 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{
              duration: 0.9,
              delay: 0.15,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="relative mx-auto w-full max-w-xl"
          >
            {/* Glow */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-[350px] w-[450px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.065)_0%,transparent_70%)]" />

            {/* Floating history card — CSS float */}
            <div className="of-float absolute -right-2 -top-6 z-20 hidden w-44 rounded-2xl border border-white/[0.07] bg-[#0b1929] p-4 shadow-2xl sm:block">
              <div className="flex items-center justify-between">
                <span className="text-[9px] uppercase tracking-[0.12em] text-slate-600">
                  Memory
                </span>

                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              </div>

              <div className="mt-3 text-xs font-medium text-white">
                Context loaded
              </div>

              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.05]">
                <span className="of-loadbar block h-full w-full origin-left rounded-full bg-violet-400/60" />
              </div>
            </div>

            {/* Main card */}
            <div className="relative rounded-[28px] border border-white/[0.08] bg-[#091624]/95 p-5 shadow-2xl sm:p-7">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-400/15 bg-violet-400/[0.05]">
                    <span className="text-sm text-violet-300">◉</span>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-white">
                      Customer profile
                    </div>

                    <div className="mt-1 text-[9px] text-slate-700">
                      Context available to AI
                    </div>
                  </div>
                </div>

                <div className="rounded-full border border-emerald-400/10 bg-emerald-400/[0.03] px-2.5 py-1">
                  <span className="text-[9px] text-emerald-300">Synced</span>
                </div>
              </div>

              {/* Profile */}
              <div className="mt-6 flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.07] bg-gradient-to-br from-violet-400/[0.12] to-cyan-400/[0.06]">
                  <span className="text-lg font-semibold text-slate-300">
                    A
                  </span>
                </div>

                <div>
                  <div className="text-sm font-medium text-white">Ahmed</div>

                  <div className="mt-1 text-[10px] text-slate-600">
                    Returning customer
                  </div>
                </div>

                <div className="ml-auto rounded-full border border-cyan-400/10 bg-cyan-400/[0.03] px-2.5 py-1">
                  <span className="text-[9px] text-cyan-300/80">Active</span>
                </div>
              </div>

              {/* Memory data */}
              <div className="mt-6 grid grid-cols-2 gap-3">
                {memoryItems.map((item, index) => (
                  <motion.div
                    key={item.label}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.4 + index * 0.08 }}
                    className="rounded-xl border border-white/[0.05] bg-white/[0.018] p-3.5"
                  >
                    <div className="text-[9px] uppercase tracking-[0.12em] text-slate-700">
                      {item.label}
                    </div>

                    <div className="mt-2 text-[11px] font-medium text-slate-300">
                      {item.value}
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Conversation history */}
              <div className="mt-4 rounded-xl border border-white/[0.05] bg-white/[0.018] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-slate-400">
                    Recent conversation
                  </span>

                  <span className="text-[9px] text-slate-700">Just now</span>
                </div>

                <div className="mt-3 space-y-2.5">
                  <div className="flex gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-600" />

                    <span className="text-[10px] leading-5 text-slate-600">
                      Customer asked about pricing and product details.
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />

                    <span className="text-[10px] leading-5 text-slate-500">
                      AI identified a high-intent sales conversation.
                    </span>
                  </div>
                </div>
              </div>

              {/* AI context status — CSS border pulse */}
              <div className="of-borderpulse mt-4 flex items-center gap-3 rounded-xl border bg-violet-400/[0.025] p-3.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-400/[0.07]">
                  <span className="text-[10px] text-violet-300">✦</span>
                </div>

                <div>
                  <div className="text-[10px] font-medium text-slate-300">
                    Context understood
                  </div>

                  <div className="mt-0.5 text-[9px] text-slate-700">
                    AI can use relevant customer history
                  </div>
                </div>

                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </div>
            </div>

            {/* Floating AI card — CSS float */}
            <div
              className="of-float absolute -bottom-5 -left-3 z-20 hidden w-48 rounded-2xl border border-cyan-400/10 bg-[#0b1929] p-4 shadow-2xl sm:block"
              style={{ animationDuration: "5.5s", animationDelay: "1s" }}
            >
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-400/[0.05] text-[10px] text-cyan-300">
                  ✦
                </span>

                <span className="text-[9px] text-slate-600">AI decision</span>
              </div>

              <div className="mt-2 text-[10px] font-medium text-cyan-300">
                Personalized response
              </div>
            </div>
          </motion.div>
        </div>

        {/* Bottom statement */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.25 }}
          className="mx-auto mt-20 max-w-3xl text-center"
        >
          <div className="h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />

          <p className="mt-8 text-xs leading-6 text-slate-700">
            {content.bottom_note}
          </p>
        </motion.div>
      </div>
    </section>
  );
}