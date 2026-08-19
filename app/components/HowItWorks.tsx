"use client";

import { motion } from "motion/react";

const workflowSteps = [
  {
    number: "01",
    type: "Trigger",
    title: "Customer sends a message",
    description:
      "Start your automation whenever a customer reaches out through a connected channel.",
    icon: "↗",
  },
  {
    number: "02",
    type: "AI",
    title: "OmniFlow understands",
    description:
      "AI analyzes the message, conversation context and customer intent in real time.",
    icon: "✦",
  },
  {
    number: "03",
    type: "Decision",
    title: "Choose what happens next",
    description:
      "Use intelligent conditions and workflow logic to decide the right next action.",
    icon: "◇",
  },
  {
    number: "04",
    type: "Action",
    title: "Automation takes action",
    description:
      "Send a reply, qualify a lead, route the conversation or trigger another workflow.",
    icon: "✓",
  },
];

export default function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <motion.div
          animate={{
            y: [0, -30, 0],
            opacity: [0.15, 0.3, 0.15],
          }}
          transition={{
            duration: 11,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute left-[15%] top-[20%] h-[420px] w-[420px] rounded-full bg-blue-500/[0.04] blur-[150px]"
        />

        <motion.div
          animate={{
            y: [0, 30, 0],
            opacity: [0.15, 0.3, 0.15],
          }}
          transition={{
            duration: 13,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute bottom-[10%] right-[10%] h-[400px] w-[400px] rounded-full bg-cyan-400/[0.035] blur-[140px]"
        />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{
              opacity: 0,
              y: 20,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            viewport={{
              once: true,
              amount: 0.3,
            }}
            transition={{
              duration: 0.7,
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-4 py-2"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
              How it works
            </span>
          </motion.div>

          <motion.h2
            initial={{
              opacity: 0,
              y: 30,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            viewport={{
              once: true,
              amount: 0.3,
            }}
            transition={{
              duration: 0.8,
              delay: 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="mt-6 font-[var(--font-heading)] text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white sm:text-5xl lg:text-6xl"
          >
            Build once.
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              Let it run.
            </span>
          </motion.h2>

          <motion.p
            initial={{
              opacity: 0,
              y: 20,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            viewport={{
              once: true,
              amount: 0.3,
            }}
            transition={{
              duration: 0.7,
              delay: 0.18,
            }}
            className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base"
          >
            Turn repetitive conversations into intelligent workflows with a
            simple visual automation system.
          </motion.p>
        </div>

        {/* Workflow */}
        <div className="relative mx-auto mt-20 max-w-5xl">
          {/* Main workflow line */}
          <div className="pointer-events-none absolute left-[31px] top-8 hidden h-[calc(100%-64px)] w-px bg-gradient-to-b from-cyan-400/30 via-blue-400/20 to-violet-400/10 md:block" />

          <div className="space-y-5">
            {workflowSteps.map((step, index) => (
              <WorkflowStep
                key={step.number}
                step={step}
                index={index}
              />
            ))}
          </div>
        </div>

        {/* Mini builder preview */}
        <motion.div
          initial={{
            opacity: 0,
            y: 30,
          }}
          whileInView={{
            opacity: 1,
            y: 0,
          }}
          viewport={{
            once: true,
            amount: 0.2,
          }}
          transition={{
            duration: 0.8,
            delay: 0.25,
          }}
          className="mx-auto mt-20 max-w-5xl"
        >
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
                    (item, index) => (
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
                    <BuilderNode
                      type="ACTION"
                      title="High intent"
                      icon="✓"
                    />

                    <BuilderNode
                      type="ACTION"
                      title="Needs support"
                      icon="→"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Bottom CTA statement */}
        <motion.div
          initial={{
            opacity: 0,
          }}
          whileInView={{
            opacity: 1,
          }}
          viewport={{
            once: true,
          }}
          transition={{
            duration: 0.8,
            delay: 0.35,
          }}
          className="mt-14 text-center"
        >
          <p className="text-xs text-slate-700">
            Your workflows can evolve as your business grows.
          </p>
        </motion.div>
      </div>
    </section>
  );
}

function WorkflowStep({
  step,
  index,
}: {
  step: (typeof workflowSteps)[number];
  index: number;
}) {
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 25,
      }}
      whileInView={{
        opacity: 1,
        y: 0,
      }}
      viewport={{
        once: true,
        amount: 0.2,
      }}
      transition={{
        duration: 0.7,
        delay: index * 0.08,
        ease: [0.22, 1, 0.36, 1],
      }}
      whileHover={{
        x: 4,
      }}
      className="group relative flex gap-4 md:gap-6"
    >
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
    </motion.div>
  );
}

function FlowLine() {
  return (
    <div className="flex h-5 justify-center">
      <motion.div
        animate={{
          opacity: [0.2, 0.8, 0.2],
        }}
        transition={{
          duration: 1.8,
          repeat: Infinity,
        }}
        className="h-full w-px bg-gradient-to-b from-cyan-400/20 to-violet-400/20"
      />
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
    <motion.div
      whileHover={{
        y: -3,
      }}
      className={`relative w-full max-w-xs rounded-xl border p-3 transition-colors duration-300 ${
        active
          ? "border-cyan-400/15 bg-cyan-400/[0.025]"
          : "border-white/[0.06] bg-white/[0.015]"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg border text-[11px] ${
            active
              ? "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-300"
              : "border-white/[0.06] bg-white/[0.02] text-slate-500"
          }`}
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
    </motion.div>
  );
}