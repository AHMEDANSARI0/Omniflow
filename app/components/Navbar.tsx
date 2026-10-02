"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import Logo from "./ui/Logo";
import useScrolled from "./hooks/useScrolled";
import { NAV_ACTIONS, NAV_ITEMS, type NavItem } from "../../lib/marketing/navigation";
import { NAVBAR_SCROLL_THRESHOLD } from "../../lib/marketing/site";

/**
 * The glass navbar (§216). Enters with a soft spring (CSS), starts
 * large and hero-integrated, and compacts into a floating bar once the
 * page scrolls past NAVBAR_SCROLL_THRESHOLD. All styling lives in
 * globals.css (.of-nav*) so the transition is pure CSS; links are the
 * admin-editable nav list (server pages pass getMarketingList("nav")).
 */
export default function Navbar({ items = NAV_ITEMS }: { items?: readonly NavItem[] }) {
  const scrolled = useScrolled(NAVBAR_SCROLL_THRESHOLD);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth >= 1024) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="of-nav" data-scrolled={scrolled || open ? "true" : "false"}>
      <nav aria-label="Main" className="of-nav-bar">
        <a href="/" aria-label="OmniFlow home" className="shrink-0 rounded-lg">
          <Logo />
        </a>

        <ul className="hidden items-center gap-0.5 lg:flex">
          {items.map((item) => (
            <li key={item.label + item.href}>
              <a
                href={item.href}
                className="rounded-lg px-3 py-2 text-[14px] font-medium text-ink-2 transition-colors duration-200 hover:bg-white/80 hover:text-ink"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-1.5">
          <a
            href={NAV_ACTIONS.login.href}
            className="hidden rounded-lg px-3 py-2 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink lg:inline-flex"
          >
            {NAV_ACTIONS.login.label}
          </a>
          <a
            href={NAV_ACTIONS.primary.href}
            className="hidden h-10 items-center gap-1.5 rounded-xl bg-brand px-4 text-[14px] font-semibold text-white shadow-cta transition-all duration-200 hover:-translate-y-px hover:bg-brand-2 sm:inline-flex"
          >
            {NAV_ACTIONS.primary.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </a>
          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white/90 text-ink transition-colors hover:border-line-2 lg:hidden"
          >
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </nav>

      <div
        id={panelId}
        className="of-nav-panel lg:hidden"
        data-open={open ? "true" : "false"}
        inert={!open}
      >
        <ul className="space-y-0.5 p-3">
          {items.map((item) => (
            <li key={item.label + item.href}>
              <a
                href={item.href}
                onClick={close}
                className="block rounded-xl px-3 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-soft"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-2">
          <a
            href={NAV_ACTIONS.login.href}
            onClick={close}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-line-2 bg-white text-sm font-semibold text-ink"
          >
            {NAV_ACTIONS.login.label}
          </a>
          <a
            href={NAV_ACTIONS.primary.href}
            onClick={close}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand text-sm font-semibold text-white shadow-cta"
          >
            {NAV_ACTIONS.primary.label}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </header>
  );
}
