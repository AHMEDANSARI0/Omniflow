"use client";

import { motion } from "motion/react";
import { ArrowRight, PlayCircle } from "lucide-react";
import type { HeroContent } from "../../lib/content-defaults";
import Button from "./ui/Button";
import Container from "./ui/Container";
import WorkflowAnimation from "./WorkflowAnimation";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The hero: light, calm, product-led. Copy on the left, the live
 * OmniFlow automation run on the right, and an honest channel strip
 * underneath — WhatsApp is live today, the rest are on the roadmap.
 */
export default function Hero({ content }: { content: HeroContent }) {
  const channels = content.integrations
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return (
    <section className="of-hero-glow relative overflow-hidden bg-canvas">
      <Container className="pb-16 pt-28 sm:pb-20 sm:pt-32 lg:pt-36">
        <div className="grid items-center gap-14 lg:grid-cols-[1.02fr_0.98fr]">
          <div>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-2"
            >
              {content.badge}
            </motion.p>

            <motion.h1
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.06, ease: EASE }}
              className="mt-5 font-display text-[44px] font-semibold leading-[1.04] tracking-[-0.03em] text-ink sm:text-[56px] lg:text-[68px]"
            >
              {content.heading_line1}{" "}
              <em className="of-gradient bg-clip-text italic text-transparent">
                {content.heading_line2}
              </em>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.12, ease: EASE }}
              className="mt-5 max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg"
            >
              {content.description}
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.18, ease: EASE }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <Button href="/dashboard/login" size="lg">
                {content.primary_button}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/#how-it-works" variant="secondary" size="lg">
                <PlayCircle className="h-4 w-4 text-brand" aria-hidden />
                {content.secondary_button}
              </Button>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
            className="flex justify-center lg:justify-end"
          >
            <WorkflowAnimation />
          </motion.div>
        </div>

        {/* channel strip — honest availability */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="mt-16 border-t border-line/80 pt-8 sm:mt-20"
        >
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-3">
            {content.channels_label}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            {channels.map((name) => {
              const live = name.toLowerCase() === "whatsapp";
              return (
                <span
                  key={name}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
                    live
                      ? "border-ok/25 bg-ok-soft text-ok"
                      : "border-line bg-white text-ink-2"
                  }`}
                >
                  {live ? (
                    <span
                      aria-hidden
                      className="of-pulse h-1.5 w-1.5 rounded-full bg-ok"
                    />
                  ) : null}
                  {name}
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider ${
                      live ? "text-ok" : "text-ink-3"
                    }`}
                  >
                    {live ? "Live" : "Soon"}
                  </span>
                </span>
              );
            })}
          </div>
          <p className="mt-3 text-center text-xs text-ink-3">
            WhatsApp today. More channels as OmniFlow expands.
          </p>
        </motion.div>
      </Container>
    </section>
  );
}
