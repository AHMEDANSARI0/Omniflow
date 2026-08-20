"use client";

import { motion } from "motion/react";
import type { FooterContent } from "../../lib/content-defaults";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: "#product" },
      { label: "How it works", href: "#how-it-works" },
      { label: "Features", href: "#features" },
      { label: "Use cases", href: "#use-cases" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "AI Intelligence", href: "#intelligence" },
      { label: "Multi-Channel", href: "#channels" },
      { label: "Customer Memory", href: "#memory" },
      { label: "Why OmniFlow", href: "#why-omniflow" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Trust & principles", href: "#trust" },
      { label: "Early access", href: "#get-started" },
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];

export default function Footer({ content }: { content: FooterContent }) {
  const socials = [
    { label: "LinkedIn", href: content.linkedin_url },
    { label: "X", href: content.x_url },
    { label: "Instagram", href: content.instagram_url },
  ].filter((s) => s.href.trim() !== "");

  return (
    <footer className="relative overflow-hidden border-t border-white/[0.06] bg-[#050d18]">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-1/2 top-0 h-[300px] w-[600px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.035)_0%,transparent_70%)]" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
        {/* Main footer */}
        <div className="grid gap-12 py-16 lg:grid-cols-[1.4fr_2fr] lg:gap-20 lg:py-20">
          {/* Brand */}
          <motion.div
            initial={{ opacity: 0, y: 25 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <a href="#" className="group inline-flex items-center gap-2">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05]">
                <motion.span
                  animate={{ opacity: [0.5, 1, 0.5], scale: [0.9, 1, 0.9] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                  className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]"
                />
              </div>

              <span className="font-[var(--font-heading)] text-xl font-semibold tracking-[-0.03em] text-white">
                Omni<span className="text-cyan-400">Flow</span>
              </span>
            </a>

            <p className="mt-6 max-w-sm text-sm leading-7 text-slate-500">
              {content.description}
            </p>

            {/* Status */}
            <div className="mt-7 inline-flex items-center gap-2 rounded-full border border-emerald-400/10 bg-emerald-400/[0.035] px-3 py-1.5">
              <motion.span
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="h-1.5 w-1.5 rounded-full bg-emerald-400"
              />

              <span className="text-[10px] text-emerald-300">
                {content.status_label}
              </span>
            </div>
          </motion.div>

          {/* Links */}
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {columns.map((column, columnIndex) => (
              <motion.div
                key={column.title}
                initial={{ opacity: 0, y: 25 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{
                  duration: 0.65,
                  delay: columnIndex * 0.1,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                  {column.title}
                </h3>

                <ul className="mt-5 space-y-3.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="group inline-flex items-center text-sm text-slate-600 transition-colors duration-300 hover:text-slate-300"
                      >
                        <span>{link.label}</span>

                        <span className="ml-1.5 -translate-x-1 text-cyan-400 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100">
                          →
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.06]" />

        {/* Bottom */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          className="flex flex-col gap-5 py-7 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-xs text-slate-700">
            © {new Date().getFullYear()} OmniFlow. All rights reserved.
          </p>

          <div className="flex items-center gap-5">
            {socials.map((social) => (
              <a
                key={social.label}
                href={social.href}
                {...(social.href !== "#"
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="text-xs text-slate-700 transition-colors duration-300 hover:text-slate-400"
              >
                {social.label}
              </a>
            ))}
          </div>
        </motion.div>
      </div>
    </footer>
  );
}