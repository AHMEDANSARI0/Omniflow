"use client";

import { motion } from "motion/react";

const problems = [
  "Customers waiting for replies",
  "Messages scattered across platforms",
  "Repetitive manual conversations",
];

const solutions = [
  "Instant AI-powered responses",
  "One intelligent automation layer",
  "Workflows that run automatically",
];

export default function ProblemSolution() {
  return (
    <section
      id="solution"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10%] top-[20%] h-[400px] w-[400px] rounded-full bg-red-500/[0.025] blur-[130px]" />

        <div className="absolute right-[-10%] bottom-[10%] h-[450px] w-[450px] rounded-full bg-cyan-400/[0.035] blur-[140px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7 }}
            className="inline-flex rounded-full border border-white/[0.07] bg-white/[0.025] px-4 py-2"
          >
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
              From chaos to automation
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
            className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-tight tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl"
          >
            Stop managing conversations.
            <br />
            <span className="bg-gradient-to-r from-slate-300 via-cyan-300 to-slate-300 bg-clip-text text-transparent">
              Start automating them.
            </span>
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{
              duration: 0.7,
              delay: 0.18,
            }}
            className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base"
          >
            Every customer conversation creates work. OmniFlow turns that work
            into intelligent, automated workflows that keep running without
            constant human intervention.
          </motion.p>
        </div>

        {/* Main comparison */}
        <div className="relative mx-auto mt-16 max-w-6xl">
          {/* Connecting line */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 hidden h-px w-[70%] -translate-x-1/2 -translate-y-1/2 bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent lg:block" />

          <div className="grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
            {/* Problem */}
            <ComparisonCard
              eyebrow="Without OmniFlow"
              title="The old way"
              items={problems}
              variant="problem"
              delay={0.1}
            />

            {/* Center */}
            <motion.div
              initial={{ opacity: 0, scale: 0.7 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{
                duration: 0.8,
                delay: 0.25,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative z-10 flex justify-center"
            >
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-cyan-400/20 bg-[#0a1727] shadow-[0_0_50px_rgba(34,211,238,0.08)]">
                <motion.div
                  animate={{
                    rotate: 360,
                  }}
                  transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                  className="absolute inset-1 rounded-full border border-dashed border-cyan-400/15"
                />

                <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06]">
                  <motion.span
                    animate={{
                      opacity: [0.5, 1, 0.5],
                      scale: [0.9, 1.05, 0.9],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                    }}
                    className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.8)]"
                  />
                </div>
              </div>
            </motion.div>

            {/* Solution */}
            <ComparisonCard
              eyebrow="With OmniFlow"
              title="The intelligent way"
              items={solutions}
              variant="solution"
              delay={0.2}
            />
          </div>
        </div>

        {/* Bottom metrics */}
        <motion.div
          initial={{ opacity: 0, y: 25 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{
            duration: 0.7,
            delay: 0.3,
          }}
          className="mx-auto mt-14 grid max-w-4xl grid-cols-2 divide-x divide-white/[0.06] border-y border-white/[0.06] py-7 sm:grid-cols-4"
        >
          <Metric value="24/7" label="Always available" />
          <Metric value="AI" label="Understands context" />
          <Metric value="∞" label="Scales with you" />
          <Metric value="1" label="Automation layer" />
        </motion.div>
      </div>
    </section>
  );
}

function ComparisonCard({
  eyebrow,
  title,
  items,
  variant,
  delay,
}: {
  eyebrow: string;
  title: string;
  items: string[];
  variant: "problem" | "solution";
  delay: number;
}) {
  const isSolution = variant === "solution";

  return (
    <motion.div
      initial={{
        opacity: 0,
        x: isSolution ? 35 : -35,
      }}
      whileInView={{
        opacity: 1,
        x: 0,
      }}
      viewport={{
        once: true,
        amount: 0.25,
      }}
      transition={{
        duration: 0.8,
        delay,
        ease: [0.22, 1, 0.36, 1],
      }}
      whileHover={{
        y: -4,
      }}
      className={`relative overflow-hidden rounded-3xl border p-6 transition-colors duration-500 sm:p-8 ${
        isSolution
          ? "border-cyan-400/10 bg-cyan-400/[0.025] hover:border-cyan-400/20"
          : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.1]"
      }`}
    >
      {/* Top glow */}
      <div
        className={`absolute left-0 top-0 h-px w-full ${
          isSolution
            ? "bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent"
            : "bg-gradient-to-r from-transparent via-white/10 to-transparent"
        }`}
      />

      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isSolution ? "bg-cyan-400" : "bg-slate-600"
          }`}
        />

        <span
          className={`text-[10px] font-medium uppercase tracking-[0.18em] ${
            isSolution ? "text-cyan-400/70" : "text-slate-600"
          }`}
        >
          {eyebrow}
        </span>
      </div>

      <h3 className="mt-5 font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.03em] text-white">
        {title}
      </h3>

      <div className="mt-7 space-y-3">
        {items.map((item, index) => (
          <motion.div
            key={item}
            initial={{ opacity: 0, x: isSolution ? 10 : -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{
              duration: 0.45,
              delay: delay + 0.15 + index * 0.08,
            }}
            className="flex items-center gap-3"
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                isSolution
                  ? "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-300"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-600"
              }`}
            >
              {isSolution ? "✓" : "×"}
            </span>

            <span className="text-sm text-slate-400">{item}</span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

function Metric({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <div className="px-3 text-center">
      <div className="font-[var(--font-heading)] text-xl font-semibold tracking-[-0.03em] text-white sm:text-2xl">
        {value}
      </div>

      <div className="mt-1 text-[9px] uppercase tracking-[0.12em] text-slate-600 sm:text-[10px]">
        {label}
      </div>
    </div>
  );
}