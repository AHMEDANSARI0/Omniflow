// add_batch_171_175.mjs - one-file batch covering Phases 171-175.
//
//   Ph171  A tiny client Reveal island: IntersectionObserver adds
//          .of-reveal-in when the element scrolls into view.
//   Ph172  The public homepage ships way less JavaScript: seven pure-display
//          marketing sections (ProblemSolution, HowItWorks, WhyOmniFlow,
//          Trust, CustomerMemory, MultiChannel, AIIntelligence) become
//          server components - framer-motion and their "use client"
//          directive are gone, each animated element is a <Reveal>.
//   Ph173  A one-line of-js bootstrap script in the root layout keeps the
//          hidden-until-revealed CSS gated on JS being on (no-JS visitors
//          and crawlers see everything), plus the reveal/lift CSS.
//   Ph174  Team page server split (TeamClient.tsx) - members and your role
//          render in the first paint; the performance card still loads
//          client-side.
//   Ph175  Regression coverage.
//
// Zero AI. Website only. Vercel deploys on push. NO restart, NO CP change.

import fs from "node:fs";
import path from "node:path";

const BACKUP_TAG = ".pre_b171175.bak";

const REVEAL_TSX = `"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type RevealTag =
  | "div"
  | "h2"
  | "h3"
  | "h4"
  | "p"
  | "span"
  | "section"
  | "article"
  | "ul"
  | "li";

export default function Reveal({
  as = "div",
  lift = false,
  className,
  children,
}: {
  as?: RevealTag;
  lift?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -60px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const Tag = as as "div";
  const classes =
    "of-reveal" +
    (lift ? " of-lift" : "") +
    (shown ? " of-reveal-in" : "") +
    (className ? " " + className : "");

  return (
    <Tag ref={ref} className={classes}>
      {children}
    </Tag>
  );
}
`;

const PROBLEMSOLUTION_TSX = `import Reveal from "./Reveal";
import type { ProblemSolutionContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

export default function ProblemSolution({
  content,
}: {
  content: ProblemSolutionContent;
}) {
  const problems = content.problems
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  const solutions = content.solutions
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  const metrics = [1, 2, 3, 4].map((i) => ({
    value: content[\`m\${i}_value\`] as string,
    label: content[\`m\${i}_label\`] as string,
  }));

  return (
    <section
      id="solution"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      <HexGrid />
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10%] top-[20%] h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(239,68,68,0.035)_0%,transparent_70%)]" />

        <div className="absolute right-[-10%] bottom-[10%] h-[450px] w-[450px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.045)_0%,transparent_70%)]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <Reveal className="inline-flex rounded-full border border-white/[0.07] bg-white/[0.025] px-4 py-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
              {content.badge}
            </span>
          </Reveal>

          <Reveal as="h2" className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-tight tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl">
            {content.heading_line1}
            <br />
            <span className="bg-gradient-to-r from-slate-300 via-cyan-300 to-slate-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </Reveal>

          <Reveal as="p" className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">
            {content.description}
          </Reveal>
        </div>

        {/* Main comparison */}
        <div className="relative mx-auto mt-16 max-w-6xl">
          {/* Connecting line */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 hidden h-px w-[70%] -translate-x-1/2 -translate-y-1/2 bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent lg:block" />

          <div className="grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
            {/* Problem */}
            <ComparisonCard
              eyebrow="Without OmniFlow"
              title={content.problem_title}
              items={problems}
              variant="problem"
              delay={0.1}
            />

            {/* Center */}
            <Reveal className="relative z-10 flex justify-center">
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-cyan-400/20 bg-[#0a1727] shadow-[0_0_50px_rgba(34,211,238,0.08)]">
                <div
                  className="of-spin-slow absolute inset-1 rounded-full border border-dashed border-cyan-400/15"
                  style={{ animationDuration: "8s" }}
                />

                <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06]">
                  <span className="of-pulse h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.8)]" />
                </div>
              </div>
            </Reveal>

            {/* Solution */}
            <ComparisonCard
              eyebrow="With OmniFlow"
              title={content.solution_title}
              items={solutions}
              variant="solution"
              delay={0.2}
            />
          </div>
        </div>

        {/* Bottom metrics */}
        <Reveal className="mx-auto mt-14 grid max-w-4xl grid-cols-2 divide-x divide-white/[0.06] border-y border-white/[0.06] py-7 sm:grid-cols-4">
          {metrics.map((metric) => (
            <Metric key={metric.label} value={metric.value} label={metric.label} />
          ))}
        </Reveal>
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
    <Reveal lift className={\`relative overflow-hidden rounded-3xl border p-6 transition-colors duration-500 sm:p-8 \${
        isSolution
          ? "border-cyan-400/10 bg-cyan-400/[0.025] hover:border-cyan-400/20"
          : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.1]"
      }\`}>
      {/* Top glow */}
      <div
        className={\`absolute left-0 top-0 h-px w-full \${
          isSolution
            ? "bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent"
            : "bg-gradient-to-r from-transparent via-white/10 to-transparent"
        }\`}
      />

      <div className="flex items-center gap-2">
        <span
          className={\`h-1.5 w-1.5 rounded-full \${
            isSolution ? "bg-cyan-400" : "bg-slate-600"
          }\`}
        />

        <span
          className={\`text-[10px] font-medium uppercase tracking-[0.18em] \${
            isSolution ? "text-cyan-400/70" : "text-slate-600"
          }\`}
        >
          {eyebrow}
        </span>
      </div>

      <h3 className="mt-5 font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.03em] text-white">
        {title}
      </h3>

      <div className="mt-7 space-y-3">
        {items.map((item, index) => (
          <Reveal className="flex items-center gap-3">
            <span
              className={\`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] \${
                isSolution
                  ? "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-300"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-600"
              }\`}
            >
              {isSolution ? "✓" : "×"}
            </span>

            <span className="text-sm text-slate-400">{item}</span>
          </Reveal>
        ))}
      </div>
    </Reveal>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
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
}`;

const HOWITWORKS_TSX = `import Reveal from "./Reveal";
import type { HowItWorksContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

const stepIcons = ["↗", "✦", "◇", "✓"];

interface WorkflowStepData {
  number: string;
  type: string;
  title: string;
  description: string;
  icon: string;
}

export default function HowItWorks({
  content,
}: {
  content: HowItWorksContent;
}) {
  const workflowSteps: WorkflowStepData[] = [1, 2, 3, 4].map((i, index) => ({
    number: \`0\${i}\`,
    type: content[\`s\${i}_type\`] as string,
    title: content[\`s\${i}_title\`] as string,
    description: content[\`s\${i}_desc\`] as string,
    icon: stepIcons[index],
  }));

  return (
    <section
      id="how-it-works"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      {/* Kinetic hexagon grid */}
      <HexGrid />

      {/* Background — static glows (perf-safe) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[15%] top-[20%] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.065)_0%,transparent_70%)]" />

        <div className="absolute bottom-[10%] right-[10%] h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.045)_0%,transparent_70%)]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <Reveal className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-4 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
              {content.badge}
            </span>
          </Reveal>

          <Reveal as="h2" className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl">
            {content.heading_line1}
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </Reveal>

          <Reveal as="p" className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">
            {content.description}
          </Reveal>
        </div>

        {/* Workflow */}
        <div className="relative mx-auto mt-20 max-w-5xl">
          {/* Main workflow line */}
          <div className="pointer-events-none absolute left-[31px] top-8 hidden h-[calc(100%-64px)] w-px bg-gradient-to-b from-cyan-400/30 via-blue-400/20 to-violet-400/10 md:block" />

          <div className="space-y-5">
            {workflowSteps.map((step, index) => (
              <WorkflowStep key={step.number} step={step} index={index} />
            ))}
          </div>
        </div>

        {/* Mini builder preview */}
        <Reveal className="mx-auto mt-20 max-w-5xl">
          <div className="overflow-hidden rounded-[26px] border border-white/[0.07] bg-[#081522] shadow-2xl">
            {/* Builder header */}
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-white/10" />
                  <span className="h-2 w-2 rounded-full bg-white/10" />
                  <span className="h-2 w-2 rounded-full bg-white/10" />
                </div>

                <span className="hidden text-[10px] text-slate-600 sm:block">
                  Automation Builder
                </span>
              </div>

              <div className="rounded-full border border-emerald-400/10 bg-emerald-400/[0.03] px-3 py-1">
                <span className="text-[9px] text-emerald-300">
                  Workflow active
                </span>
              </div>
            </div>

            {/* Builder body */}
            <div className="grid min-h-[330px] lg:grid-cols-[180px_1fr]">
              {/* Sidebar */}
              <div className="hidden border-r border-white/[0.05] p-4 lg:block">
                <div className="text-[9px] uppercase tracking-[0.15em] text-slate-700">
                  Nodes
                </div>

                <div className="mt-4 space-y-2">
                  {["Trigger", "AI action", "Condition", "Response"].map(
                    (item) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.015] px-3 py-2.5"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400/50" />

                        <span className="text-[9px] text-slate-600">
                          {item}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>

              {/* Canvas */}
              <div className="relative overflow-hidden p-5 sm:p-7">
                {/* Canvas grid */}
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.025]"
                  style={{
                    backgroundImage:
                      "linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)",
                    backgroundSize: "36px 36px",
                  }}
                />

                <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-3">
                  <BuilderNode
                    type="TRIGGER"
                    title="New customer message"
                    icon="↗"
                    active
                  />

                  <FlowLine />

                  <BuilderNode
                    type="AI"
                    title="Understand intent"
                    icon="✦"
                    active
                  />

                  <FlowLine />

                  <div className="grid w-full max-w-lg grid-cols-2 gap-3">
                    <BuilderNode type="ACTION" title="High intent" icon="✓" />

                    <BuilderNode type="ACTION" title="Needs support" icon="→" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Bottom CTA statement */}
        <Reveal className="mt-14 text-center">
          <p className="text-xs text-slate-700">{content.bottom_note}</p>
        </Reveal>
      </div>
    </section>
  );
}

function WorkflowStep({
  step,
  index,
}: {
  step: WorkflowStepData;
  index: number;
}) {
  return (
    <Reveal lift className="group relative flex gap-4 md:gap-6">
      {/* Number */}
      <div className="relative z-10 flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-white/[0.07] bg-[#081522] shadow-xl transition-colors duration-300 group-hover:border-cyan-400/15">
        <span className="text-[10px] font-medium tracking-[0.12em] text-cyan-400/60">
          {step.number}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 transition-colors duration-300 group-hover:border-white/[0.1] sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.025] text-sm text-cyan-300">
            {step.icon}
          </div>

          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.16em] text-slate-700">
              {step.type}
            </div>

            <h3 className="mt-1 text-sm font-medium text-white sm:text-base">
              {step.title}
            </h3>
          </div>

          <p className="text-xs leading-6 text-slate-600 sm:ml-auto sm:max-w-sm">
            {step.description}
          </p>
        </div>
      </div>
    </Reveal>
  );
}

function FlowLine() {
  return (
    <div className="flex h-5 justify-center">
      <div className="of-pulse h-full w-px bg-gradient-to-b from-cyan-400/20 to-violet-400/20" />
    </div>
  );
}

function BuilderNode({
  type,
  title,
  icon,
  active = false,
}: {
  type: string;
  title: string;
  icon: string;
  active?: boolean;
}) {
  return (
    <Reveal lift className={\`relative w-full max-w-xs rounded-xl border p-3 transition-colors duration-300 \${
        active
          ? "border-cyan-400/15 bg-cyan-400/[0.025]"
          : "border-white/[0.06] bg-white/[0.015]"
      }\`}>
      <div className="flex items-center gap-3">
        <div
          className={\`flex h-8 w-8 items-center justify-center rounded-lg border text-[11px] \${
            active
              ? "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-300"
              : "border-white/[0.06] bg-white/[0.02] text-slate-500"
          }\`}
        >
          {icon}
        </div>

        <div>
          <div className="text-[8px] uppercase tracking-[0.12em] text-slate-700">
            {type}
          </div>

          <div className="mt-1 text-[10px] font-medium text-slate-300">
            {title}
          </div>
        </div>

        {active && (
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan-400" />
        )}
      </div>
    </Reveal>
  );
}`;

const WHYOMNIFLOW_TSX = `import Reveal from "./Reveal";
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
    <Reveal className={\`group border-b border-white/[0.06] py-6 transition-colors duration-300 first:pt-0 last:border-b-0 sm:py-7 \${accent.hoverBorder}\`}>
      <div className="flex gap-5 sm:gap-6">
        <span
          className={\`font-mono text-sm tracking-widest text-slate-600 transition-colors duration-300 \${accent.numberText}\`}
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
    </Reveal>
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

      <Reveal className="relative rounded-2xl border border-white/[0.07] bg-[#081522]/95 p-5 sm:p-6">
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
              <Reveal className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3.5 py-3">
                <span
                  className={\`of-pulse flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-xs \${accent.text}\`}
                  style={{ animationDelay: \`\${i * 0.6}s\`, animationDuration: "3s" }}
                >
                  {event.icon}
                </span>
                <span className="flex-1 text-xs text-slate-300 sm:text-[13px]">
                  {event.text}
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">
                  {event.time}
                </span>
              </Reveal>
            );
          })}
        </div>

        {/* Card footer */}
        <Reveal className="mt-5 flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
          <span className="text-[11px] text-slate-500">
            AI handling conversations while your team is offline
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-cyan-300">
            <span className="of-pulse h-1 w-1 rounded-full bg-cyan-400" />
            Active
          </span>
        </Reveal>
      </Reveal>

      {/* Floating chip */}
      <Reveal className="absolute -right-3 -top-4 sm:-right-5">
        <div className="of-float flex items-center gap-2 rounded-xl border border-violet-400/20 bg-[#0a1727] px-3 py-2 shadow-lg shadow-black/30">
          <span className="text-xs text-violet-300">✦</span>
          <span className="text-[11px] font-medium text-slate-300">
            No conversation missed
          </span>
        </div>
      </Reveal>
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
    title: content[\`b\${index + 1}_title\`] as string,
    description: content[\`b\${index + 1}_desc\`] as string,
  }));

  return (
    <section id="why-omniflow" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-0 top-1/4 h-[420px] w-[560px] rounded-full bg-cyan-500/[0.035] blur-3xl" />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
          {/* Left: heading + benefit rows */}
          <div>
            <Reveal>
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
            </Reveal>

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
}`;

const TRUST_TSX = `import Reveal from "./Reveal";
import type { TrustContent } from "../../lib/content-defaults";

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

const pillarMeta: { icon: string; accent: Accent }[] = [
  { icon: "◇", accent: "cyan" },
  { icon: "◎", accent: "blue" },
  { icon: "✦", accent: "violet" },
  { icon: "◆", accent: "cyan" },
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

export default function Trust({ content }: { content: TrustContent }) {
  const pillars: TrustPillar[] = pillarMeta.map((meta, index) => ({
    ...meta,
    title: content[\`p\${index + 1}_title\`] as string,
    description: content[\`p\${index + 1}_desc\`] as string,
  }));

  const principles = content.principles
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section id="trust" className="relative overflow-hidden py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[380px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/[0.03] blur-3xl" />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        {/* Section header */}
        <Reveal className="mx-auto max-w-2xl text-center">
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
        </Reveal>

        {/* Pillar cards */}
        <div className="mt-14 grid gap-4 sm:mt-16 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
          {pillars.map((pillar, index) => {
            const accent = accentStyles[pillar.accent];
            return (
              <Reveal className={\`rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 transition-colors duration-300 \${accent.hoverBorder}\`}>
                <div
                  className={\`mb-5 flex h-10 w-10 items-center justify-center rounded-xl border text-base \${accent.iconBox}\`}
                >
                  {pillar.icon}
                </div>
                <h3 className="text-base font-semibold text-white">
                  {pillar.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {pillar.description}
                </p>
              </Reveal>
            );
          })}
        </div>

        {/* Principles strip */}
        <Reveal className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-8 gap-y-3 sm:mt-12">
          {principles.map((principle, i) => (
            <div key={principle} className="flex items-center gap-2">
              <span
                className={\`of-pulse h-1 w-1 rounded-full \${
                  accentStyles[(["cyan", "blue", "violet"] as Accent[])[i % 3]].dot
                }\`}
                style={{ animationDelay: \`\${i * 0.4}s\`, animationDuration: "2.6s" }}
              />
              <span className="text-xs text-slate-500 sm:text-sm">
                {principle}
              </span>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}`;

const CUSTOMERMEMORY_TSX = `import Reveal from "./Reveal";
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
            <Reveal className="inline-flex items-center gap-2 rounded-full border border-violet-400/10 bg-violet-400/[0.035] px-4 py-2">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />

              <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-300/80">
                {content.badge}
              </span>
            </Reveal>

            <Reveal as="h2" className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl">
              {content.heading_line1}
              <br />

              <span className="bg-gradient-to-r from-violet-300 via-blue-400 to-cyan-300 bg-clip-text text-transparent">
                {content.heading_line2}
              </span>
            </Reveal>

            <Reveal as="p" className="mt-6 max-w-xl text-sm leading-7 text-slate-500 sm:text-base">
              {content.description}
            </Reveal>

            {/* Context points */}
            <div className="mt-8 space-y-3">
              {contextItems.map((item, index) => (
                <Reveal className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-violet-400/10 bg-violet-400/[0.035] text-[9px] text-violet-300">
                    ✓
                  </span>

                  <span className="text-xs text-slate-500">{item}</span>
                </Reveal>
              ))}
            </div>
          </div>

          {/* Memory visualization */}
          <Reveal className="relative mx-auto w-full max-w-xl">
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
                  <Reveal className="rounded-xl border border-white/[0.05] bg-white/[0.018] p-3.5">
                    <div className="text-[9px] uppercase tracking-[0.12em] text-slate-700">
                      {item.label}
                    </div>

                    <div className="mt-2 text-[11px] font-medium text-slate-300">
                      {item.value}
                    </div>
                  </Reveal>
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
          </Reveal>
        </div>

        {/* Bottom statement */}
        <Reveal className="mx-auto mt-20 max-w-3xl text-center">
          <div className="h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />

          <p className="mt-8 text-xs leading-6 text-slate-700">
            {content.bottom_note}
          </p>
        </Reveal>
      </div>
    </section>
  );
}`;

const MULTICHANNEL_TSX = `import Reveal from "./Reveal";
import type { MultiChannelContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

interface Channel {
  name: string;
  short: string;
  description: string;
  position: "left" | "right";
}

export default function MultiChannel({
  content,
}: {
  content: MultiChannelContent;
}) {
  const positions: ("left" | "right")[] = ["left", "right", "left", "right"];

  const channels: Channel[] = [1, 2, 3, 4].map((i, index) => ({
    name: content[\`c\${i}_name\`] as string,
    short: content[\`c\${i}_short\`] as string,
    description: content[\`c\${i}_desc\`] as string,
    position: positions[index],
  }));

  const actions = content.actions
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  return (
    <section
      id="channels"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      {/* Background — static glow + dot texture (perf-safe) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[550px] w-[550px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.06)_0%,transparent_70%)]" />

        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.8) 1px, transparent 0)",
            backgroundSize: "32px 32px",
          }}
        />
      </div>

      {/* Kinetic hexagon grid */}
      <HexGrid opacity={0.07} />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <Reveal className="inline-flex items-center gap-2 rounded-full border border-blue-400/10 bg-blue-400/[0.035] px-4 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-blue-300/80">
              {content.badge}
            </span>
          </Reveal>

          <Reveal as="h2" className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl">
            {content.heading_line1}
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </Reveal>

          <Reveal as="p" className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">
            {content.description}
          </Reveal>
        </div>

        {/* Main visual */}
        <div className="relative mx-auto mt-20 max-w-5xl">
          {/* Desktop connection lines */}
          <div className="pointer-events-none absolute inset-0 hidden lg:block">
            <div className="absolute left-[24%] top-1/2 h-px w-[26%] bg-gradient-to-r from-cyan-400/0 via-cyan-400/20 to-cyan-400/40" />

            <div className="absolute right-[24%] top-1/2 h-px w-[26%] bg-gradient-to-l from-violet-400/0 via-violet-400/20 to-violet-400/40" />
          </div>

          <div className="grid items-center gap-10 lg:grid-cols-[1fr_240px_1fr]">
            {/* Left channels */}
            <div className="space-y-4">
              {channels
                .filter((channel) => channel.position === "left")
                .map((channel, index) => (
                  <ChannelCard
                    key={channel.name}
                    channel={channel}
                    direction="left"
                    delay={0.15 + index * 0.1}
                  />
                ))}
            </div>

            {/* Center */}
            <Reveal className="relative mx-auto flex h-52 w-52 items-center justify-center">
              {/* Rings — CSS spin */}
              <div
                className="of-spin-slow absolute inset-0 rounded-full border border-cyan-400/10"
                style={{ animationDuration: "18s" }}
              />

              <div
                className="of-spin-rev absolute inset-7 rounded-full border border-dashed border-blue-400/15"
                style={{ animationDuration: "13s" }}
              />

              <div className="absolute inset-12 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.07)_0%,transparent_70%)]" />

              {/* Core */}
              <div className="relative flex h-28 w-28 flex-col items-center justify-center rounded-3xl border border-cyan-400/20 bg-[#0a1929] shadow-[0_0_70px_rgba(34,211,238,0.08)]">
                <span className="of-pulse absolute h-14 w-14 rounded-full bg-cyan-400/[0.08] blur-xl" />

                <span className="relative text-2xl text-cyan-300">✦</span>

                <span className="relative mt-2 text-[9px] font-medium uppercase tracking-[0.15em] text-slate-500">
                  OmniFlow
                </span>

                <span className="relative mt-0.5 text-[8px] text-slate-700">
                  AI Engine
                </span>
              </div>

              {/* Pulse ripple — CSS */}
              <span className="of-ripple absolute h-28 w-28 rounded-full border border-cyan-400/30" />
            </Reveal>

            {/* Right channels */}
            <div className="space-y-4">
              {channels
                .filter((channel) => channel.position === "right")
                .map((channel, index) => (
                  <ChannelCard
                    key={channel.name}
                    channel={channel}
                    direction="right"
                    delay={0.2 + index * 0.1}
                  />
                ))}
            </div>
          </div>
        </div>

        {/* Automation strip */}
        <Reveal className="mx-auto mt-16 max-w-4xl rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <div className="flex flex-col items-center justify-between gap-5 sm:flex-row">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/10 bg-cyan-400/[0.04]">
                <span className="text-sm text-cyan-300">↗</span>
              </div>

              <div>
                <div className="text-xs font-medium text-white">
                  {content.workflow_title}
                </div>

                <div className="mt-1 text-[9px] text-slate-600">
                  {content.workflow_subtitle}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap justify-center gap-2">
              {actions.map((action, index) => (
                <Reveal className="rounded-full border border-white/[0.05] bg-white/[0.02] px-3 py-1.5 text-[9px] text-slate-500">
                  {action}
                </Reveal>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Bottom statement */}
        <Reveal className="mt-14 text-center">
          <p className="text-xs text-slate-700">{content.bottom_note}</p>
        </Reveal>
      </div>
    </section>
  );
}

function ChannelCard({
  channel,
  direction,
  delay,
}: {
  channel: {
    name: string;
    short: string;
    description: string;
  };
  direction: "left" | "right";
  delay: number;
}) {
  return (
    <Reveal lift className="group relative rounded-2xl border border-white/[0.06] bg-[#091624]/95 p-4 transition-colors duration-300 hover:border-cyan-400/10">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.025] text-xs font-semibold text-slate-400 transition-colors duration-300 group-hover:border-cyan-400/15 group-hover:text-cyan-300">
          {channel.short}
        </div>

        <div>
          <div className="text-xs font-medium text-slate-200">
            {channel.name}
          </div>

          <div className="mt-1 text-[9px] text-slate-700">
            {channel.description}
          </div>
        </div>

        <div className="ml-auto">
          <span
            className="of-pulse block h-1.5 w-1.5 rounded-full bg-cyan-400"
            style={{ animationDelay: \`\${delay}s\` }}
          />
        </div>
      </div>

      {/* Connection indicator */}
      <div
        className={\`absolute top-1/2 hidden h-px w-8 -translate-y-1/2 lg:block \${
          direction === "left"
            ? "-right-8 bg-gradient-to-r from-cyan-400/30 to-transparent"
            : "-left-8 bg-gradient-to-l from-violet-400/30 to-transparent"
        }\`}
      />
    </Reveal>
  );
}
`;

const AIINTELLIGENCE_TSX = `import Reveal from "./Reveal";
import type { AiIntelligenceContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

export default function AIIntelligence({
  content,
}: {
  content: AiIntelligenceContent;
}) {
  const intelligenceItems = [1, 2, 3].map((i) => ({
    number: \`0\${i}\`,
    title: content[\`i\${i}_title\`] as string,
    description: content[\`i\${i}_desc\`] as string,
    tags: (content[\`i\${i}_tags\`] as string)
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
          <Reveal className="inline-flex items-center gap-2 rounded-full border border-cyan-400/15 bg-cyan-400/[0.035] px-4 py-2">
            <span className="of-pulse h-1.5 w-1.5 rounded-full bg-cyan-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-300/80">
              {content.badge}
            </span>
          </Reveal>

          <Reveal as="h2" className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl">
            {content.heading_line1}
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </Reveal>

          <Reveal as="p" className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">
            {content.description}
          </Reveal>
        </div>

        {/* AI visual */}
        <Reveal className="relative mx-auto mt-16 max-w-5xl">
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
                        animationDelay: \`\${item * 0.18}s\`,
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
                  <Reveal className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-cyan-400/10 bg-cyan-400/[0.04] text-[9px] text-cyan-300">
                      0{index + 1}
                    </span>

                    <span className="text-[10px] text-slate-500">{item}</span>

                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </Reveal>
                ),
              )}
            </div>
          </div>
        </Reveal>

        {/* Three intelligence pillars */}
        <div className="mt-16 grid gap-4 md:grid-cols-3">
          {intelligenceItems.map((item, index) => (
            <Reveal lift className="group rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 transition-colors duration-500 hover:border-cyan-400/10 hover:bg-white/[0.025]">
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
            </Reveal>
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
    <Reveal className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="mb-4">
        <div className="text-xs font-medium text-slate-300">{title}</div>

        <div className="mt-1 text-[9px] text-slate-700">{subtitle}</div>
      </div>

      {children}
    </Reveal>
  );
}

function Tag({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <span
      className={\`rounded-full border px-2.5 py-1 text-[9px] \${
        active
          ? "border-cyan-400/10 bg-cyan-400/[0.035] text-cyan-400/70"
          : "border-white/[0.05] text-slate-700"
      }\`}
    >
      {label}
    </span>
  );
}
`;

const TEAM_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listTeam,
  requirePortalAccessToken,
  type TeamMember,
} from "../../../../lib/omniflow/portal";
import TeamClient from "./TeamClient";


export default async function TeamPage() {
  const session = await getOmniFlowSession();

  let initialMembers: TeamMember[] | null = null;
  let initialRole: string | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const overview = await listTeam(accessToken);
      if (overview) {
        initialMembers = overview.members;
        initialRole = overview.myRole;
      }
    }
  }

  return <TeamClient initialMembers={initialMembers} initialRole={initialRole} />;
}
`;

const TEAM_TRANSFORMS = [
      { name: "p174-team-signature", from: `export default function TeamPage() {`, to: `export default function TeamClient({
  initialMembers,
  initialRole,
}: {
  initialMembers?: TeamMember[] | null;
  initialRole?: string | null;
}) {` },
      { name: "p174-team-members", from: `const [members, setMembers] = useState<TeamMember[]>([]);`, to: `const [members, setMembers] = useState<TeamMember[]>(initialMembers ?? []);` },
      { name: "p174-team-role", from: `const [myRole, setMyRole] = useState<string | null>(null);`, to: `const [myRole, setMyRole] = useState<string | null>(initialRole ?? null);` },
      { name: "p174-team-loading", from: `const [loading, setLoading] = useState(true);`, to: `const [loading, setLoading] = useState(initialMembers === null);` },
];

const LAYOUT_SWAP_FROM = `      <body className={\`\${inter.variable} \${sora.variable}\`}>
        {children}`;

const LAYOUT_SWAP_TO = `      <body className={\`\${inter.variable} \${sora.variable}\`}>
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('of-js');",
          }}
        />
        {children}`;

const GLOBALS_APPEND = `

/* Scroll reveal (server sections + client Reveal islands) */

.of-reveal.of-lift {
  transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}

.of-reveal.of-lift:hover {
  transform: translateY(-4px) !important;
}

html.of-js .of-reveal:not(.of-reveal-in) {
  opacity: 0;
  transform: translateY(24px);
}

html.of-js .of-reveal.of-reveal-in {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}
`;


const NEW_FILES = [
  { path: "Omniflow/app/components/Reveal.tsx", content: REVEAL_TSX, marker: "export default function Reveal", name: "p171-reveal-island" },
  { path: "Omniflow/app/components/ProblemSolution.tsx", content: PROBLEMSOLUTION_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-problemsolution-server" },
  { path: "Omniflow/app/components/HowItWorks.tsx", content: HOWITWORKS_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-howitworks-server" },
  { path: "Omniflow/app/components/WhyOmniFlow.tsx", content: WHYOMNIFLOW_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-whyomniflow-server" },
  { path: "Omniflow/app/components/Trust.tsx", content: TRUST_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-trust-server" },
  { path: "Omniflow/app/components/CustomerMemory.tsx", content: CUSTOMERMEMORY_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-customermemory-server" },
  { path: "Omniflow/app/components/MultiChannel.tsx", content: MULTICHANNEL_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-multichannel-server" },
  { path: "Omniflow/app/components/AIIntelligence.tsx", content: AIINTELLIGENCE_TSX, marker: 'import Reveal from "./Reveal";', name: "p172-aiintelligence-server" },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

function splitClientPage(pagePath, clientName, transforms, serverPage, label) {
  const clientPath = pagePath.replace("page.tsx", clientName);
  const pageText = fs.readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  if (fs.existsSync(clientPath) && pageText.includes(clientName.replace(".tsx", ""))) {
    alreadyTotal++;
    console.log("= " + pagePath + " (split already done)");
    return;
  }
  if (!pageText.includes('"use client"')) {
    warnTotal++;
    console.log("  ? " + pagePath + " :: " + label + " unexpected page shape — report this");
    return;
  }

  let clientText = pageText;
  for (const swap of transforms) {
    const fromCount = clientText.split(swap.from).length - 1;
    if (fromCount !== 1) {
      warnTotal++;
      console.log("  ? " + pagePath + " :: " + swap.name + " NOT FOUND — report this");
      return;
    }
    clientText = clientText.replace(swap.from, swap.to);
  }

  const backup = pagePath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(pagePath, backup);
  fs.writeFileSync(clientPath, clientText, "utf8");
  fs.writeFileSync(pagePath, serverPage.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal += 2;
  console.log("+ " + clientPath + " (new): " + label);
  console.log("+ " + pagePath + " (server wrapper): " + label);
}

const TEAM_PAGE = "Omniflow/app/dashboard/(portal)/team/page.tsx";
if (fs.existsSync(TEAM_PAGE)) {
  splitClientPage(TEAM_PAGE, "TeamClient.tsx", TEAM_TRANSFORMS, TEAM_SERVER_PAGE, "p174-team-split");
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + TEAM_PAGE);
}

const LAYOUT_PATH = "Omniflow/app/layout.tsx";
if (fs.existsSync(LAYOUT_PATH)) {
  const layoutText = fs.readFileSync(LAYOUT_PATH, "utf8").replace(/\r\n/g, "\n");
  if (layoutText.includes("classList.add('of-js')")) {
    alreadyTotal++;
    console.log("= " + LAYOUT_PATH + " (bootstrap already present)");
  } else if (layoutText.split(LAYOUT_SWAP_FROM).length - 1 === 1) {
    const backup = LAYOUT_PATH + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(LAYOUT_PATH, backup);
    fs.writeFileSync(LAYOUT_PATH, layoutText.replace(LAYOUT_SWAP_FROM, LAYOUT_SWAP_TO), "utf8");
    appliedTotal++;
    console.log("+ " + LAYOUT_PATH + " (1): p173-ofjs-bootstrap");
  } else {
    warnTotal++;
    console.log("  ? " + LAYOUT_PATH + " :: p173-ofjs-bootstrap NOT FOUND — report this");
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + LAYOUT_PATH);
}

const GLOBALS_PATH = "Omniflow/app/globals.css";
if (fs.existsSync(GLOBALS_PATH)) {
  const globalsText = fs.readFileSync(GLOBALS_PATH, "utf8").replace(/\r\n/g, "\n");
  if (globalsText.includes("of-reveal")) {
    alreadyTotal++;
    console.log("= " + GLOBALS_PATH + " (reveal css already present)");
  } else {
    const backup = GLOBALS_PATH + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(GLOBALS_PATH, backup);
    fs.writeFileSync(GLOBALS_PATH, globalsText + GLOBALS_APPEND, "utf8");
    appliedTotal++;
    console.log("+ " + GLOBALS_PATH + " (1): p173-reveal-css");
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + GLOBALS_PATH);
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);