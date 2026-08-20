"use client";

import { motion } from "motion/react";
import type { HeroContent } from "../../lib/content-defaults";

export default function Hero({ content }: { content: HeroContent }) {
  const integrations = content.integrations
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section
      id="product"
      className="relative flex min-h-screen items-center overflow-hidden bg-[#07111f] pt-28 sm:pt-32"
    >
      {/* ============ BACKGROUND (all continuous motion = CSS, compositor-only) ============ */}

      {/* ============ BACKGROUND (all continuous motion = CSS, compositor-only) ============ */}

      {/* Static ambient glows */}
      <div className="pointer-events-none absolute left-[8%] top-[10%] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.09)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute bottom-[5%] right-[5%] h-[450px] w-[450px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.08)_0%,transparent_70%)]" />

      {/* Radial fade — grid/orbs se PEHLE, taake unhe dhak na de */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#07111f_78%)]" />

      {/* Kinetic grid — ab fade ke UPAR */}
      <div
        className="of-grid-drift pointer-events-none absolute -inset-16 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,197,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(148,197,255,0.6) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />

      {/* Floating orbs — ab fade ke UPAR, zyada visible */}
      <div className="of-orb-a pointer-events-none absolute right-[16%] top-[20%] h-32 w-32 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.35)_0%,rgba(34,211,238,0.1)_45%,transparent_70%)]" />
      <div className="of-orb-b pointer-events-none absolute bottom-[22%] left-[10%] h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.3)_0%,rgba(139,92,246,0.08)_45%,transparent_70%)]" />
      <div className="of-orb-c pointer-events-none absolute left-[42%] top-[64%] h-24 w-24 rounded-full bg-[radial-gradient(circle,rgba(96,165,250,0.32)_0%,rgba(96,165,250,0.09)_45%,transparent_70%)]" />

      {/* ============ CONTENT ============ */}

      <div className="relative z-10 mx-auto w-full max-w-7xl px-6 pb-20 lg:px-8 lg:pb-28">
        <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          {/* Left */}
          <div className="max-w-3xl">
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="inline-flex items-center rounded-full border border-cyan-400/15 bg-cyan-400/[0.04] px-4 py-2"
            >
              <span className="of-pulse mr-2 h-1.5 w-1.5 rounded-full bg-cyan-400" />

              <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-300 sm:text-xs">
                {content.badge}
              </span>
            </motion.div>

            {/* Heading */}
            <motion.h1
              initial={{ opacity: 0, y: 35 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="mt-7 font-[var(--font-heading)] text-5xl font-semibold leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl lg:text-7xl xl:text-[82px]"
            >
              {content.heading_line1}
              <br />

              <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
                {content.heading_line2}
              </span>
            </motion.h1>

            {/* Description */}
            <motion.p
              initial={{ opacity: 0, y: 25 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.42 }}
              className="mt-7 max-w-xl text-base leading-8 text-slate-400 sm:text-lg"
            >
              {content.description}
            </motion.p>

            {/* Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 25 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.55 }}
              className="mt-9 flex flex-col gap-3 sm:flex-row"
            >
              <motion.a
                href="#get-started"
                whileHover={{ y: -3, scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                className="group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl bg-cyan-400 px-6 py-3.5 text-sm font-semibold text-[#07111f] shadow-[0_0_30px_rgba(34,211,238,0.08)] transition-shadow duration-500 hover:shadow-[0_0_45px_rgba(34,211,238,0.2)]"
              >
                <span className="relative z-10">{content.primary_button}</span>

                <span className="relative z-10 transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>

                <span className="absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-0" />
              </motion.a>

              <motion.a
                href="#intelligence"
                whileHover={{ y: -3, scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                className="inline-flex items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.025] px-6 py-3.5 text-sm font-medium text-slate-300 transition-colors duration-300 hover:border-white/[0.15] hover:bg-white/[0.05] hover:text-white"
              >
                {content.secondary_button}
              </motion.a>
            </motion.div>

            {/* Integrations */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.75 }}
              className="mt-10"
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-600">
                {content.channels_label}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {integrations.map((item, index) => (
                  <motion.div
                    key={item}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.8 + index * 0.08 }}
                    className="rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] text-slate-500"
                  >
                    {item}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Right visual */}
          <motion.div
            initial={{ opacity: 0, x: 50, scale: 0.94 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: 1, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto w-full max-w-xl"
          >
            {/* Glow behind card — static */}
            <div className="absolute inset-6 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.1)_0%,transparent_70%)]" />

            {/* Orbit rings — CSS spin */}
            <div className="of-spin-slow absolute inset-[5%] rounded-full border border-dashed border-cyan-400/[0.08]" />
            <div className="of-spin-rev absolute inset-[15%] rounded-full border border-dashed border-violet-400/[0.07]" />

            {/* Main card — CSS float, no backdrop blur */}
            <div className="of-float relative rounded-[28px] border border-white/[0.09] bg-[#0a1727]/95 p-4 shadow-2xl sm:p-5">
              {/* Header */}
              <div className="flex items-center justify-between rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/15 bg-cyan-400/[0.05]">
                    <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.7)]" />
                  </div>

                  <div>
                    <div className="text-xs font-medium text-white">
                      OmniFlow AI
                    </div>

                    <div className="text-[9px] text-slate-600">
                      Automation engine
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 rounded-full border border-emerald-400/10 bg-emerald-400/[0.03] px-2.5 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="text-[9px] text-emerald-300">Active</span>
                </div>
              </div>

              {/* Flow */}
              <div className="relative mt-5 space-y-3">
                <FlowCard
                  icon="✦"
                  title="Incoming message"
                  subtitle="Customer wants to know more"
                  type="input"
                  delay={0.8}
                />

                <FlowConnector />

                <FlowCard
                  icon="◎"
                  title="AI understands"
                  subtitle="Intent · Context · Sentiment"
                  type="ai"
                  delay={1.05}
                />

                <FlowConnector />

                <FlowCard
                  icon="↗"
                  title="Automation triggered"
                  subtitle="Respond · Qualify · Follow up"
                  type="action"
                  delay={1.3}
                />
              </div>

              {/* Bottom */}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
                  <div className="text-[9px] uppercase tracking-[0.14em] text-slate-600">
                    Response time
                  </div>

                  <div className="mt-1 text-sm font-semibold text-white">
                    &lt; 1 sec
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
                  <div className="text-[9px] uppercase tracking-[0.14em] text-slate-600">
                    Automation
                  </div>

                  <div className="mt-1 text-sm font-semibold text-cyan-300">
                    Running
                  </div>
                </div>
              </div>
            </div>

            {/* Floating card 1 */}
            <motion.div
              initial={{ opacity: 0, x: 25 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.3, duration: 0.7 }}
              className="absolute -right-3 top-[18%] hidden rounded-xl border border-violet-400/15 bg-[#0b192b] px-3 py-2.5 shadow-xl sm:block"
            >
              <div className="text-[9px] text-slate-600">AI decision</div>
              <div className="mt-1 text-[10px] font-medium text-violet-300">
                Intent detected
              </div>
            </motion.div>

            {/* Floating card 2 */}
            <motion.div
              initial={{ opacity: 0, x: -25 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.45, duration: 0.7 }}
              className="absolute -left-4 bottom-[14%] hidden rounded-xl border border-cyan-400/15 bg-[#0b192b] px-3 py-2.5 shadow-xl sm:block"
            >
              <div className="text-[9px] text-slate-600">Workflow</div>
              <div className="mt-1 text-[10px] font-medium text-cyan-300">
                Completed ✓
              </div>
            </motion.div>
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6, duration: 0.8 }}
          className="mt-8 flex justify-center lg:mt-4"
        >
          <a href="#intelligence" className="of-bob group flex flex-col items-center gap-2">
            <span className="text-[9px] uppercase tracking-[0.2em] text-slate-700 transition-colors group-hover:text-slate-500">
              Explore
            </span>

            <span className="flex h-8 w-5 items-start justify-center rounded-full border border-white/[0.08] pt-1.5">
              <span className="h-1.5 w-0.5 rounded-full bg-cyan-400/60" />
            </span>
          </a>
        </motion.div>
      </div>
    </section>
  );
}

function FlowCard({
  icon,
  title,
  subtitle,
  type,
  delay,
}: {
  icon: string;
  title: string;
  subtitle: string;
  type: "input" | "ai" | "action";
  delay: number;
}) {
  const iconStyle =
    type === "ai"
      ? "border-violet-400/15 bg-violet-400/[0.05] text-violet-300"
      : type === "action"
        ? "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-300"
        : "border-white/[0.08] bg-white/[0.025] text-slate-300";

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ x: 4 }}
      className="flex items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.018] p-3.5 transition-colors duration-300 hover:border-white/[0.1]"
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm ${iconStyle}`}
      >
        {icon}
      </div>

      <div className="min-w-0">
        <div className="text-xs font-medium text-slate-200">{title}</div>

        <div className="mt-1 truncate text-[10px] text-slate-600">
          {subtitle}
        </div>
      </div>

      <div className="ml-auto shrink-0">
        <span
          className={`of-pulse block h-1.5 w-1.5 rounded-full ${type === "ai"
            ? "bg-violet-400"
            : type === "action"
              ? "bg-cyan-400"
              : "bg-slate-500"
            }`}
          style={{ animationDelay: `${delay}s` }}
        />
      </div>
    </motion.div>
  );
}

function FlowConnector() {
  return (
    <div className="flex h-4 justify-center">
      <div className="of-pulse h-full w-px bg-gradient-to-b from-white/[0.08] to-cyan-400/30" />
    </div>
  );
}
