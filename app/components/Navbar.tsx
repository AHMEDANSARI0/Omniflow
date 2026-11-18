"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, X } from "lucide-react";
import Logo from "./ui/Logo";
import { NAV_ACTIONS, NAV_ITEMS, type NavItem } from "../../lib/marketing/navigation";

/* ============================================================================
   Navbar — floating glassmorphic bar with responsive mobile drawer
   ============================================================================ */

export default function Navbar({ items = NAV_ITEMS }: { items?: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname() || "/";
  const panelId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 960) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const close = () => setOpen(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <header ref={rootRef} className="of-nav" data-scrolled={scrolled || open ? "true" : "false"}>
      <nav aria-label="Main" className="of-nav-bar">
        <a
          href="/"
          aria-label="OmniFlow home"
          className="-my-1 shrink-0 whitespace-nowrap rounded-lg py-1 transition-opacity hover:opacity-80"
        >
          <Logo />
        </a>

        <ul className="of-nav-links hidden items-center gap-0.5 lg:flex">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.label + item.href} className="shrink-0">
                <a
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    "inline-flex shrink-0 items-center whitespace-nowrap rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-200 xl:px-3 xl:text-[14px] " +
                    (active
                      ? "bg-white text-ink shadow-[0_1px_2px_rgba(16,24,40,0.06)] hover:bg-soft"
                      : "text-ink-2 hover:bg-white/80 hover:text-brand")
                  }
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>

        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <a
            href={NAV_ACTIONS.login.href}
            className="of-nav-login hidden shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-[14px] font-medium text-ink-2 transition-colors hover:bg-white/80 hover:text-brand lg:inline-flex"
          >
            {NAV_ACTIONS.login.label}
          </a>
          <a
            href={NAV_ACTIONS.primary.href}
            className="of-nav-cta hidden h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-brand px-4 text-[14px] font-semibold text-white shadow-cta transition-all duration-200 hover:-translate-y-px hover:bg-brand-2 sm:inline-flex"
          >
            <span className="whitespace-nowrap">{NAV_ACTIONS.primary.label}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </a>
          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="of-nav-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-white/90 text-ink transition-colors hover:border-line-2 hover:bg-white lg:hidden"
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
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.label + item.href}>
                <a
                  href={item.href}
                  onClick={close}
                  aria-current={active ? "page" : undefined}
                  className={
                    "block rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors " +
                    (active
                      ? "bg-brand-soft text-brand-2 hover:bg-brand/15"
                      : "text-ink hover:bg-soft")
                  }
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-2">
          <a
            href={NAV_ACTIONS.login.href}
            onClick={close}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-line-2 bg-white text-sm font-semibold text-ink transition-colors hover:bg-canvas"
          >
            {NAV_ACTIONS.login.label}
          </a>
          <a
            href={NAV_ACTIONS.primary.href}
            onClick={close}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand text-sm font-semibold text-white shadow-cta transition-colors hover:bg-brand-2"
          >
            {NAV_ACTIONS.primary.label}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </header>
  );
}
