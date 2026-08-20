"use client";

import { useState, useActionState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  submitEarlyAccess,
  type EarlyAccessState,
} from "../actions/early-access";
import type { FinalCtaContent } from "../../lib/content-defaults";
import HexGrid from "./HexGrid";

const initialFormState: EarlyAccessState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors duration-300 focus:border-cyan-400/40";

export default function FinalCTA({ content }: { content: FinalCtaContent }) {
  const [formOpen, setFormOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    submitEarlyAccess,
    initialFormState
  );

  const notes = content.notes
    .split("|")
    .map((n) => n.trim())
    .filter(Boolean);

  return (
    <section id="get-started" className="relative overflow-hidden py-24 sm:py-32">
      <HexGrid opacity={0.12} />
      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-[#081522]/70 px-6 py-16 text-center sm:px-12 sm:py-20"
        >
          {/* Panel background glows */}
          <div className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-cyan-500/[0.07] blur-3xl" />
          <div className="pointer-events-none absolute -bottom-40 left-1/4 h-64 w-96 rounded-full bg-violet-500/[0.05] blur-3xl" />
          <div className="pointer-events-none absolute -bottom-40 right-1/4 h-64 w-96 rounded-full bg-blue-500/[0.05] blur-3xl" />

          {/* Animated top edge line */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
            <motion.div
              className="h-full w-1/2 bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent"
              animate={{ x: ["-100%", "300%"] }}
              transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          <div className="relative">
            {/* Pill */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.02] px-3.5 py-1.5"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
              </span>
              <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
                {content.badge}
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.25 }}
              className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl lg:leading-[1.12]"
            >
              {content.heading_line1}{" "}
              <span className="bg-gradient-to-r from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
                {content.heading_line2}
              </span>
            </motion.h2>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.35 }}
              className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg"
            >
              {content.description}
            </motion.p>

            {/* Success message OR buttons + form */}
            {state.success ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4 }}
                className="mx-auto mt-9 max-w-md rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.05] px-6 py-5"
              >
                <p className="text-sm font-medium text-emerald-300">
                  ✓ {state.message}
                </p>
              </motion.div>
            ) : (
              <>
                {/* Buttons */}
                <motion.div
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.45 }}
                  className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4"
                >
                  <motion.button
                    type="button"
                    onClick={() => setFormOpen((v) => !v)}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/[0.15] transition-shadow duration-300 hover:shadow-cyan-500/[0.3] sm:w-auto"
                  >
                    {formOpen ? "Close form" : content.primary_button}
                    <span aria-hidden="true">{formOpen ? "↑" : "→"}</span>
                  </motion.button>
                  <motion.a
                    href="#how-it-works"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.02] px-7 py-3.5 text-sm font-semibold text-slate-300 transition-colors duration-300 hover:border-white/[0.2] hover:text-white sm:w-auto"
                  >
                    {content.secondary_button}
                  </motion.a>
                </motion.div>

                {/* Expanding form */}
                <AnimatePresence>
                  {formOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <form
                        action={formAction}
                        className="mx-auto mt-8 max-w-md space-y-3 text-left"
                      >
                        {/* Honeypot — hidden from humans */}
                        <input
                          type="text"
                          name="website"
                          tabIndex={-1}
                          autoComplete="off"
                          aria-hidden="true"
                          className="absolute -left-[9999px] h-0 w-0 opacity-0"
                        />

                        <input
                          type="text"
                          name="name"
                          required
                          placeholder="Your name"
                          aria-label="Your name"
                          className={inputClass}
                        />
                        <input
                          type="email"
                          name="email"
                          required
                          placeholder="Work email"
                          aria-label="Work email"
                          className={inputClass}
                        />
                        <input
                          type="text"
                          name="company"
                          placeholder="Company (optional)"
                          aria-label="Company (optional)"
                          className={inputClass}
                        />

                        {!state.success && state.message && (
                          <p className="text-xs text-red-300">{state.message}</p>
                        )}

                        <button
                          type="submit"
                          disabled={pending}
                          className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-3 text-sm font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {pending ? "Submitting…" : "Request early access"}
                        </button>

                        <p className="text-center text-[11px] text-slate-600">
                          No spam — we&apos;ll only contact you about early access.
                        </p>
                      </form>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {/* Notes strip */}
            <motion.div
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.6 }}
              className="mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-2.5"
            >
              {notes.map((note) => (
                <div key={note} className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-slate-600" />
                  <span className="text-xs text-slate-500">{note}</span>
                </div>
              ))}
            </motion.div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}