"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { FaqContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

interface FaqItem {
  question: string;
  answer: string;
}

export default function FAQ({ content }: { content: FaqContent }) {
  const items: FaqItem[] = [1, 2, 3, 4, 5, 6]
    .map((i) => ({
      question: content[`q${i}`] as string,
      answer: content[`a${i}`] as string,
    }))
    .filter((item) => item.question.trim() !== "");

  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="relative overflow-hidden py-24 sm:py-32">
      {/* Kinetic hexagon grid */}
      <HexGrid opacity={0.06} showDots={false} />

      {/* Background glow */}
      <div className="pointer-events-none absolute right-0 top-1/4 h-[380px] w-[520px] rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.04)_0%,transparent_70%)]" />

      <div className="relative mx-auto max-w-3xl px-5 sm:px-8">
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
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400" />
            </span>
            <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
              {content.badge}
            </span>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
            {content.heading_line1}{" "}
            <span className="bg-gradient-to-r from-blue-300 via-cyan-300 to-violet-300 bg-clip-text text-transparent">
              {content.heading_line2}
            </span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">
            {content.description}
          </p>
        </motion.div>

        {/* Accordion */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
          className="mt-12 space-y-3 sm:mt-14"
        >
          {items.map((item, index) => {
            const isOpen = openIndex === index;
            return (
              <div
                key={item.question}
                className={`overflow-hidden rounded-2xl border transition-colors duration-300 ${
                  isOpen
                    ? "border-cyan-400/20 bg-white/[0.02]"
                    : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left sm:px-6 sm:py-5"
                >
                  <span
                    className={`text-sm font-medium sm:text-base ${
                      isOpen ? "text-white" : "text-slate-300"
                    }`}
                  >
                    {item.question}
                  </span>
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-sm transition-all duration-300 ${
                      isOpen
                        ? "rotate-45 border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-300"
                        : "border-white/[0.08] bg-white/[0.02] text-slate-500"
                    }`}
                  >
                    +
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="px-5 pb-5 text-sm leading-relaxed text-slate-400 sm:px-6 sm:pb-6">
                        {item.answer}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </motion.div>

        {/* Contact strip */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.15 }}
          className="mt-10 flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.015] px-6 py-6 text-center sm:mt-12 sm:flex-row sm:gap-4"
        >
          <p className="text-sm text-slate-400">{content.contact_text}</p>
          <a
            href={`mailto:${content.contact_email}`}
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-2 text-sm font-medium text-cyan-300 transition-colors duration-300 hover:border-cyan-400/40"
          >
            ✉ {content.contact_email}
          </a>
        </motion.div>
      </div>
    </section>
  );
}