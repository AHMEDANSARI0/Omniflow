"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Button from "./ui/Button";
import Logo from "./ui/Logo";

const LINKS = [
  { label: "Product", href: "/#product" },
  { label: "Solutions", href: "/use-cases" },
  { label: "Features", href: "/features" },
  { label: "Resources", href: "/blog" },
  { label: "Pricing", href: "/pricing" },
];

/**
 * The floating SaaS navbar: transparent over the hero, then a
 * translucent white surface with a hairline border once the page
 * scrolls. Same hierarchy on mobile behind an animated panel.
 */
export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const surface = scrolled
    ? "border-b border-line/80 bg-white/85 shadow-[0_8px_30px_-24px_rgba(11,18,32,0.35)] backdrop-blur-xl"
    : "border-b border-transparent bg-transparent";

  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${surface}`}>
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-6 lg:px-8"
      >
        <a href="/" aria-label="OmniFlow home" className="shrink-0">
          <Logo />
        </a>

        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-soft hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          <a
            href="/dashboard/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:text-ink"
          >
            Login
          </a>
          <Button href="/dashboard/login" size="sm">
            Get Started
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white/80 text-ink lg:hidden"
        >
          {open ? (
            <X className="h-5 w-5" aria-hidden />
          ) : (
            <Menu className="h-5 w-5" aria-hidden />
          )}
        </button>
      </nav>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="border-b border-line bg-white/95 backdrop-blur-xl lg:hidden"
          >
            <div className="mx-auto w-full max-w-6xl space-y-1 px-5 pb-5 pt-2 sm:px-6">
              {LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-3 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-soft"
                >
                  {link.label}
                </a>
              ))}
              <div className="flex flex-col gap-2 pt-3">
                <Button href="/dashboard/login" variant="secondary" onClick={() => setOpen(false)}>
                  Login
                </Button>
                <Button href="/dashboard/login" onClick={() => setOpen(false)}>
                  Get Started
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
