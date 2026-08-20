"use client";

import { motion } from "motion/react";

const channels = [
  {
    name: "WhatsApp",
    short: "WA",
    description: "Conversations",
    position: "left",
  },
  {
    name: "Instagram",
    short: "IG",
    description: "Direct messages",
    position: "right",
  },
  {
    name: "Messenger",
    short: "MS",
    description: "Customer chats",
    position: "left",
  },
  {
    name: "Telegram",
    short: "TG",
    description: "Community & support",
    position: "right",
  },
];

export default function MultiChannel() {
  return (
    <section
      id="channels"
      className="relative overflow-hidden border-t border-white/[0.05] bg-[#07111f] py-28 sm:py-36"
    >
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <motion.div
          animate={{
            scale: [1, 1.12, 1],
            opacity: [0.15, 0.3, 0.15],
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute left-1/2 top-1/2 h-[550px] w-[550px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.06)_0%,transparent_70%)]"
        />

        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.8) 1px, transparent 0)",
            backgroundSize: "32px 32px",
          }}
        />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7 }}
            className="inline-flex items-center gap-2 rounded-full border border-blue-400/10 bg-blue-400/[0.035] px-4 py-2"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />

            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-blue-300/80">
              Multi-channel automation
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
            One intelligence layer.
            <br />

            <span className="bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-300 bg-clip-text text-transparent">
              Every channel.
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
            Connect the platforms your customers already use and let one
            intelligent automation layer handle the conversations.
          </motion.p>
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
            <motion.div
              initial={{
                opacity: 0,
                scale: 0.8,
              }}
              whileInView={{
                opacity: 1,
                scale: 1,
              }}
              viewport={{
                once: true,
                amount: 0.3,
              }}
              transition={{
                duration: 0.9,
                delay: 0.25,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative mx-auto flex h-52 w-52 items-center justify-center"
            >
              {/* Rings */}
              <motion.div
                animate={{
                  rotate: 360,
                }}
                transition={{
                  duration: 18,
                  repeat: Infinity,
                  ease: "linear",
                }}
                className="absolute inset-0 rounded-full border border-cyan-400/10"
              />

              <motion.div
                animate={{
                  rotate: -360,
                }}
                transition={{
                  duration: 13,
                  repeat: Infinity,
                  ease: "linear",
                }}
                className="absolute inset-7 rounded-full border border-dashed border-blue-400/15"
              />

              <div className="absolute inset-12 rounded-full bg-cyan-400/[0.04] blur-2xl" />

              {/* Core */}
              <div className="relative flex h-28 w-28 flex-col items-center justify-center rounded-3xl border border-cyan-400/20 bg-[#0a1929] shadow-[0_0_70px_rgba(34,211,238,0.08)]">
                <motion.div
                  animate={{
                    scale: [0.85, 1.1, 0.85],
                    opacity: [0.45, 1, 0.45],
                  }}
                  transition={{
                    duration: 2.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="absolute h-14 w-14 rounded-full bg-cyan-400/[0.08] blur-xl"
                />

                <span className="relative text-2xl text-cyan-300">✦</span>

                <span className="relative mt-2 text-[9px] font-medium uppercase tracking-[0.15em] text-slate-500">
                  OmniFlow
                </span>

                <span className="relative mt-0.5 text-[8px] text-slate-700">
                  AI Engine
                </span>
              </div>

              {/* Pulse */}
              <motion.div
                animate={{
                  scale: [1, 1.5],
                  opacity: [0.3, 0],
                }}
                transition={{
                  duration: 2.5,
                  repeat: Infinity,
                  ease: "easeOut",
                }}
                className="absolute h-28 w-28 rounded-full border border-cyan-400/30"
              />
            </motion.div>

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
            amount: 0.25,
          }}
          transition={{
            duration: 0.7,
            delay: 0.35,
          }}
          className="mx-auto mt-16 max-w-4xl rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5"
        >
          <div className="flex flex-col items-center justify-between gap-5 sm:flex-row">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/10 bg-cyan-400/[0.04]">
                <span className="text-sm text-cyan-300">↗</span>
              </div>

              <div>
                <div className="text-xs font-medium text-white">
                  One workflow layer
                </div>

                <div className="mt-1 text-[9px] text-slate-600">
                  Build once. Automate everywhere.
                </div>
              </div>
            </div>

            <div className="flex flex-wrap justify-center gap-2">
              {["Reply", "Qualify", "Route", "Follow-up"].map(
                (action, index) => (
                  <motion.div
                    key={action}
                    initial={{
                      opacity: 0,
                      scale: 0.9,
                    }}
                    whileInView={{
                      opacity: 1,
                      scale: 1,
                    }}
                    viewport={{
                      once: true,
                    }}
                    transition={{
                      delay: 0.45 + index * 0.08,
                    }}
                    className="rounded-full border border-white/[0.05] bg-white/[0.02] px-3 py-1.5 text-[9px] text-slate-500"
                  >
                    {action}
                  </motion.div>
                ),
              )}
            </div>
          </div>
        </motion.div>

        {/* Bottom statement */}
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
            delay: 0.45,
          }}
          className="mt-14 text-center"
        >
          <p className="text-xs text-slate-700">
            More channels can be added as your business grows.
          </p>
        </motion.div>
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
    <motion.div
      initial={{
        opacity: 0,
        x: direction === "left" ? -30 : 30,
      }}
      whileInView={{
        opacity: 1,
        x: 0,
      }}
      viewport={{
        once: true,
        amount: 0.3,
      }}
      transition={{
        duration: 0.7,
        delay,
        ease: [0.22, 1, 0.36, 1],
      }}
      whileHover={{
        y: -3,
        x: direction === "left" ? 4 : -4,
      }}
      className="group relative rounded-2xl border border-white/[0.06] bg-[#091624]/95 p-4  transition-colors duration-300 hover:border-cyan-400/10"
    >
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
          <motion.span
            animate={{
              opacity: [0.25, 1, 0.25],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              delay,
            }}
            className="block h-1.5 w-1.5 rounded-full bg-cyan-400"
          />
        </div>
      </div>

      {/* Connection indicator */}
      <div
        className={`absolute top-1/2 hidden h-px w-8 -translate-y-1/2 lg:block ${
          direction === "left"
            ? "-right-8 bg-gradient-to-r from-cyan-400/30 to-transparent"
            : "-left-8 bg-gradient-to-l from-violet-400/30 to-transparent"
        }`}
      />
    </motion.div>
  );
}