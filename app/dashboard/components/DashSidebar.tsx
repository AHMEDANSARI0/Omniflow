"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { openCommandPalette } from "./CommandPalette";
import SignOutButton from "./SignOutButton";
import AlertsBell from "./AlertsBell";
import { useUnreadCount } from "./useUnreadCount";

interface NavItem {
  label: string;
  href: string;
  icon: string;
  enabled: boolean;
}

const navItems: NavItem[] = [
  {
    label: "Knowledge base",
    href: "/dashboard/knowledge-base",
    icon: "\u25a6",
    enabled: true,
  },
  { label: "Overview", href: "/dashboard", icon: "\u2302", enabled: true },
  {
    label: "WhatsApp setup",
    href: "/dashboard/channels/whatsapp",
    icon: "\u2706",
    enabled: true,
  },
  { label: "Configure AI", href: "/dashboard/bot", icon: "\u2736", enabled: true },
  {
    label: "Conversations",
    href: "/dashboard/conversations",
    icon: "\u270e",
    enabled: true,
  },
  {
    label: "Customers",
    href: "/dashboard/customers",
    icon: "\u2606",
    enabled: true,
  },
  {
    label: "Automations",
    href: "/dashboard/automations",
    icon: "\u2301",
    enabled: true,
  },
  {
    label: "Analytics",
    href: "/dashboard/analytics",
    icon: "\u25c9",
    enabled: true,
  },
  {
    label: "Business profile",
    href: "/dashboard/profile",
    icon: "\u25ad",
    enabled: true,
  },
  { label: "Broadcasts", href: "/dashboard/broadcasts", icon: "➤", enabled: true },
  { label: "COD confirmations", href: "/dashboard/cod", icon: "\u25a4", enabled: true },
  { label: "Courier", href: "/dashboard/courier", icon: "\u25bb", enabled: true },
  { label: "Media", href: "/dashboard/media", icon: "\u25a6", enabled: true },
  { label: "Integrations", href: "/dashboard/integrations", icon: "\u21c4", enabled: true },
  { label: "Compliance", href: "/dashboard/compliance", icon: "\u26e8", enabled: true },
  { label: "Growth", href: "/dashboard/growth", icon: "\u25b2", enabled: true },
  { label: "Win-back", href: "/dashboard/winback", icon: "\u21bb", enabled: true },
  { label: "Sequences", href: "/dashboard/sequences", icon: "\u2192", enabled: true },
  { label: "Segments", href: "/dashboard/segments", icon: "\u25ce", enabled: true },
  { label: "Pipeline", href: "/dashboard/pipeline", icon: "\u25c8", enabled: true },
  { label: "Quick replies", href: "/dashboard/saved-replies", icon: "/", enabled: true },
  { label: "Activity", href: "/dashboard/activity", icon: "\u2261", enabled: true },
  { label: "Weekly", href: "/dashboard/weekly", icon: "\u2248", enabled: true },
  { label: "Team", href: "/dashboard/team", icon: "⚑", enabled: true },
  { label: "Settings", href: "/dashboard/settings", icon: "\u2699", enabled: true },
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2"
      title="OmniFlow Portal"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06]">
        <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
      </div>
      {!compact && (
        <>
          <span className="whitespace-nowrap text-base font-semibold tracking-[-0.03em] text-white">
            Omni<span className="text-cyan-400">Flow</span>
          </span>
          <span className="ml-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500">
            Portal
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
  const unreadCount = useUnreadCount();

  return (
    <nav className="space-y-1">
      {navItems.map((item) => {
        const isActive =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
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
              <span className="flex items-center gap-3 text-sm text-slate-500">
                <span className="text-xs">{item.icon}</span>
                {!collapsed && item.label}
              </span>
              {!collapsed && (
                <span className="rounded-md border border-white/[0.06] bg-white/[0.02] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-600">
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
            className={`relative flex items-center gap-3 rounded-xl border py-2.5 text-sm transition-colors duration-200 ${
              collapsed ? "justify-center px-0" : "px-3"
            } ${
              isActive
                ? "border-cyan-400/20 bg-cyan-400/[0.06] text-white"
                : "border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-white"
            }`}
          >
            <span className={`text-xs ${isActive ? "text-cyan-300" : ""}`}>
              {item.icon}
            </span>
            {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
            {item.href === "/dashboard/conversations" &&
              unreadCount > 0 &&
              (collapsed ? (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-400 px-1 text-[9px] font-bold text-[#07111f]">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-cyan-400 px-1.5 text-[10px] font-bold text-[#07111f]">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ))}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter({
  userEmail,
  clientId,
  role,
  collapsed = false,
}: {
  userEmail: string;
  clientId: number;
  role: string;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-3 border-t border-white/[0.06] pt-4">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          title="Visit website"
          className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
        >
          ↗
        </a>
        <SignOutButton compact />
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-white/[0.06] pt-4">
      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
      >
      <button
        type="button"
        onClick={() => openCommandPalette()}
        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
      >
        <span className="flex items-center gap-2">
          <span>⌕</span> Search
        </span>
        <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-slate-600">
          Ctrl K
        </span>
      </button>
        <span>↗</span> Visit website
      </a>
      <div className="px-3">
        <p className="truncate text-[11px] text-slate-500" title={userEmail}>
          {userEmail}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-700">
          Workspace {clientId} · {role}
        </p>
      </div>
      <div className="flex items-center justify-between px-3 pb-1">
        <AlertsBell />
        <SignOutButton />
      </div>
    </div>
  );
}

export default function DashSidebar({
  userEmail,
  clientId,
  role,
  collapsed,
  onToggle,
}: {
  userEmail: string;
  clientId: number;
  role: string;
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
        className="sticky top-0 z-40 hidden h-screen flex-col overflow-hidden border-r border-white/[0.06] bg-[#060f1b] px-3 py-6 lg:flex"
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.02] text-xs text-slate-400 transition-colors duration-200 hover:border-white/[0.16] hover:text-white"
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4">
          <NavLinks collapsed={collapsed} />
        </div>

        <SidebarFooter
          userEmail={userEmail}
          clientId={clientId}
          role={role}
          collapsed={collapsed}
        />
      </motion.aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-white/[0.06] bg-[#060f1b]/90 px-4 py-3 backdrop-blur-md lg:hidden">
        <BrandMark />
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-300"
        >
          {mobileOpen ? "✕" : "☰"}
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
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/[0.06] bg-[#060f1b] px-4 py-6 lg:hidden"
            >
              <div className="mb-8 flex items-center justify-between px-2">
                <BrandMark />
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400"
                >
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4">
                <NavLinks onNavigate={() => setMobileOpen(false)} />
              </div>
              <SidebarFooter
                userEmail={userEmail}
                clientId={clientId}
                role={role}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}