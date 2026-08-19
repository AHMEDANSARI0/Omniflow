"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Use cases", href: "#use-cases" },
  { label: "Why OmniFlow", href: "#why-omniflow" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };

    handleScroll();

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const handleNavClick = () => {
    setMobileOpen(false);
  };

  return (
    <>
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.7,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6 lg:px-8"
      >
        <motion.nav
          animate={{
            backgroundColor: scrolled
              ? "rgba(7, 17, 31, 0.35)"
              : "rgba(7, 17, 31, 0)",
            borderColor: scrolled
              ? "rgba(255, 255, 255, 0.08)"
              : "rgba(255, 255, 255, 0.04)",
            boxShadow: scrolled
              ? "0 15px 50px rgba(0, 0, 0, 0.15)"
              : "0 0 0 rgba(0, 0, 0, 0)",
          }}
          transition={{
            duration: 0.35,
            ease: "easeOut",
          }}
          className="mx-auto max-w-7xl rounded-2xl border px-4 py-3 backdrop-blur-xl sm:px-5"
        >
          <div className="flex items-center justify-between">
            {/* Logo */}
            <motion.a
              href="#"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="group flex items-center gap-2"
              onClick={handleNavClick}
            >
              <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06]">
                <motion.span
                  animate={{
                    opacity: [0.5, 1, 0.5],
                    scale: [0.9, 1, 0.9],
                  }}
                  transition={{
                    duration: 2.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]"
                />
              </div>

              <span className="font-[var(--font-heading)] text-lg font-semibold tracking-[-0.03em] text-white">
                Omni<span className="text-cyan-400">Flow</span>
              </span>
            </motion.a>

            {/* Desktop Navigation */}
            <div className="hidden items-center gap-6 md:flex lg:gap-8">
              {navItems.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                />
              ))}
            </div>

            {/* Desktop CTA */}
            <div className="hidden md:block">
              <motion.a
                href="#get-started"
                whileHover={{
                  y: -2,
                  scale: 1.02,
                }}
                whileTap={{
                  scale: 0.97,
                }}
                className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-semibold text-[#07111f]"
              >
                <span className="relative z-10">Get Started</span>

                <span className="relative z-10 transition-transform duration-300 group-hover:translate-x-0.5">
                  →
                </span>

                <span className="absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-0" />
              </motion.a>
            </div>

            {/* Mobile button */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.9 }}
              onClick={() => setMobileOpen((current) => !current)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
              className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] md:hidden"
            >
              <div className="flex w-4 flex-col gap-1.5">
                <motion.span
                  animate={
                    mobileOpen
                      ? {
                        rotate: 45,
                        y: 4,
                      }
                      : {
                        rotate: 0,
                        y: 0,
                      }
                  }
                  transition={{ duration: 0.25 }}
                  className="block h-px w-full bg-slate-300"
                />

                <motion.span
                  animate={{
                    opacity: mobileOpen ? 0 : 1,
                    x: mobileOpen ? 5 : 0,
                  }}
                  transition={{ duration: 0.2 }}
                  className="block h-px w-full bg-slate-300"
                />

                <motion.span
                  animate={
                    mobileOpen
                      ? {
                        rotate: -45,
                        y: -4,
                      }
                      : {
                        rotate: 0,
                        y: 0,
                      }
                  }
                  transition={{ duration: 0.25 }}
                  className="block h-px w-full bg-slate-300"
                />
              </div>
            </motion.button>
          </div>

          {/* Mobile Navigation */}
          <AnimatePresence>
            {mobileOpen && (
              <motion.div
                initial={{
                  height: 0,
                  opacity: 0,
                }}
                animate={{
                  height: "auto",
                  opacity: 1,
                }}
                exit={{
                  height: 0,
                  opacity: 0,
                }}
                transition={{
                  duration: 0.3,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="overflow-hidden md:hidden"
              >
                <div className="mt-4 border-t border-white/[0.06] pt-4">
                  <div className="space-y-1">
                    {navItems.map((item, index) => (
                      <motion.a
                        key={item.href}
                        href={item.href}
                        initial={{
                          opacity: 0,
                          x: -10,
                        }}
                        animate={{
                          opacity: 1,
                          x: 0,
                        }}
                        transition={{
                          delay: index * 0.05,
                        }}
                        onClick={handleNavClick}
                        className="block rounded-xl px-3 py-3 text-sm text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-white"
                      >
                        {item.label}
                      </motion.a>
                    ))}

                    <motion.a
                      href="#get-started"
                      initial={{
                        opacity: 0,
                        y: 10,
                      }}
                      animate={{
                        opacity: 1,
                        y: 0,
                      }}
                      transition={{
                        delay: 0.15,
                      }}
                      onClick={handleNavClick}
                      className="mt-2 flex items-center justify-center rounded-xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-[#07111f]"
                    >
                      Get Started →
                    </motion.a>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.nav>
      </motion.header>
    </>
  );
}

function NavLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <motion.a
      href={href}
      whileHover={{ y: -1 }}
      className="group relative py-2 text-sm text-slate-400 transition-colors duration-300 hover:text-white"
    >
      {label}

      <span className="absolute bottom-0 left-0 h-px w-0 bg-cyan-400 transition-all duration-300 group-hover:w-full" />
    </motion.a>
  );
}