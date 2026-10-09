"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import SignOutButton from "./SignOutButton";
import Icon from "../../components/ui/Icon";
import { ADMIN_NAV } from "../../../lib/omniflow/admin-nav";
import {
  ArrowUpRight,
  ChevronsLeft,
  ChevronsRight,
  Menu,
  X,
} from "lucide-react";

// §259: one nav list (ADMIN_NAV) feeds the sidebar and the dashboard.
const navItems = ADMIN_NAV;

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/admin" className="flex items-center gap-2" title="OmniFlow Admin">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand-soft">
        <span className="h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_12px_rgba(79,70,229,0.45)]" />
      </div>
      {!compact && (
        <>
          <span className="whitespace-nowrap text-base font-semibold tracking-[-0.03em] text-ink">
            Omni<span className="text-brand">Flow</span>
          </span>
          <span className="ml-1 rounded-md border border-line bg-soft px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-3">
            Admin
          </span>
        </>
      )}
    </Link>
  );
}

function NavLinks({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="space-y-1">
      {navItems.map((item) => {
        const isActive =
          item.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(item.href);

        if (!item.enabled) {
          return (
            <div
              key={item.href}
              title={`${item.label} — coming soon`}
              className={`flex cursor-not-allowed items-center rounded-xl py-2.5 opacity-50 ${
                collapsed ? "justify-center px-0" : "justify-between px-3"
              }`}
            >
              <span className="flex items-center gap-3 text-sm text-ink-3">
                <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                {!collapsed && item.label}
              </span>
              {!collapsed && (
                <span className="rounded-md border border-line bg-soft px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-ink-3">
                  Soon
                </span>
              )}
            </div>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={item.label}
            className={`flex items-center gap-3 rounded-xl border py-2.5 text-sm transition-colors duration-200 ${
              collapsed ? "justify-center px-0" : "px-3"
            } ${
              isActive
                ? "border-brand/20 bg-brand-soft text-ink"
                : "border-transparent text-ink-3 hover:bg-line/60 hover:text-ink"
            }`}
          >
            <span className={`shrink-0 ${isActive ? "text-brand" : ""}`}>
              <Icon name={item.icon} className="h-4 w-4" />
            </span>
            {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter({
  userEmail,
  collapsed = false,
}: {
  userEmail: string;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-3 border-t border-line pt-4">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          title="View website"
          className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors duration-200 hover:bg-line/60 hover:text-ink-2"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </a>
        <SignOutButton compact />
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-ink-3 transition-colors duration-200 hover:bg-line/60 hover:text-ink-2"
      >
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /> View website
      </a>
      <div className="px-3">
        <p className="truncate text-[11px] text-ink-3" title={userEmail}>
          {userEmail}
        </p>
      </div>
      <div className="px-3 pb-1">
        <SignOutButton />
      </div>
    </div>
  );
}

export default function AdminSidebar({
  userEmail,
  collapsed,
  onToggle,
}: {
  userEmail: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar (collapsible) */}
      <motion.aside
        animate={{ width: collapsed ? 76 : 256 }}
        initial={false}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="sticky top-0 z-40 hidden h-screen flex-col overflow-hidden border-r border-line bg-white px-3 py-6 lg:flex"
      >
        <div
          className={`mb-6 flex ${
            collapsed
              ? "flex-col items-center gap-4"
              : "items-center justify-between px-2"
          }`}
        >
          <BrandMark compact={collapsed} />
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-soft text-xs text-ink-3 transition-colors duration-200 hover:border-line-2 hover:text-ink"
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronsLeft className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>

        <div className="flex-1">
          <NavLinks collapsed={collapsed} />
        </div>

        <SidebarFooter userEmail={userEmail} collapsed={collapsed} />
      </motion.aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-line bg-white/90 px-4 py-3 backdrop-blur-xl lg:hidden">
        <BrandMark />
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white shadow-card text-ink-2"
        >
          {mobileOpen ? (
            <X className="h-4 w-4" aria-hidden />
          ) : (
            <Menu className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 z-40 bg-soft backdrop-blur-sm lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-white px-4 py-6 lg:hidden"
            >
              <div className="mb-8 flex items-center justify-between px-2">
                <BrandMark />
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-3"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="flex-1">
                <NavLinks onNavigate={() => setMobileOpen(false)} />
              </div>
              <SidebarFooter userEmail={userEmail} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
