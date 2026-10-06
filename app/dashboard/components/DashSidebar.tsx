"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import SignOutButton from "./SignOutButton";
import PortalIcon from "./PortalIcon";
import {
  DASHBOARD_LINK,
  NAV_GROUPS,
  SETTINGS_LINK,
  findNav,
  isNavActive,
  type NavGroup,
  type NavItem,
} from "./portalNav";
import { useUnreadCount } from "./useUnreadCount";

// §246: groups are dropdowns (the group holding the current page opens by
// itself); Dashboard and Settings stay top-level; search and alerts live in
// the top bar (DashTopbar), which also opens the phone drawer below.

const INBOX_HREF = "/dashboard/conversations";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2"
      title="OmniFlow Portal"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand-soft">
        <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
      </div>
      {!compact && (
        <>
          <span className="whitespace-nowrap text-base font-semibold tracking-[-0.03em] text-ink">
            Omni<span className="text-brand">Flow</span>
          </span>
          <span className="ml-1 hidden rounded-md border border-line bg-white px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-2 min-[360px]:inline-block">
            Portal
          </span>
        </>
      )}
    </Link>
  );
}

function UnreadBadge({ count, compact }: { count: number; compact: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={
        compact
          ? "absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-400 px-1 text-[9px] font-bold text-[#07111f]"
          : "ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-cyan-400 px-1.5 text-[10px] font-bold text-[#07111f]"
      }
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function NavLinks({
  collapsed = false,
  onNavigate,
  onExpand,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  onExpand?: () => void;
}) {
  const pathname = usePathname();
  const unreadCount = useUnreadCount();
  const activeGroup = findNav(pathname).group?.id ?? null;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const isOpen = (group: NavGroup) => openGroups[group.id] ?? group.id === activeGroup;

  const renderLink = (item: NavItem, nested: boolean) => {
    const active = isNavActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        title={item.label}
        aria-current={active ? "page" : undefined}
        className={`relative flex items-center gap-3 rounded-xl border text-sm transition-colors duration-200 ${
          collapsed ? "justify-center px-0 py-2.5" : nested ? "py-2 pl-3 pr-3" : "px-3 py-2.5"
        } ${
          active
            ? "border-brand/20 bg-brand-soft text-ink"
            : "border-transparent text-ink-3 hover:bg-soft hover:text-ink"
        }`}
      >
        <PortalIcon name={item.icon} className={`h-4 w-4 ${active ? "text-brand" : ""}`} />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {item.href === INBOX_HREF && <UnreadBadge count={unreadCount} compact={collapsed} />}
      </Link>
    );
  };

  const renderGroup = (group: NavGroup) => {
    const open = isOpen(group);
    const holdsActive = group.id === activeGroup;
    const groupUnread = group.items.some((item) => item.href === INBOX_HREF) ? unreadCount : 0;
    const panelId = "nav-group-" + group.id;

    if (collapsed) {
      return (
        <button
          key={group.id}
          type="button"
          title={group.title}
          aria-label={"Open " + group.title + " menu"}
          onClick={() => {
            setOpenGroups((current) => ({ ...current, [group.id]: true }));
            onExpand?.();
          }}
          className={`relative flex w-full items-center justify-center rounded-xl border py-2.5 transition-colors duration-200 ${
            holdsActive
              ? "border-brand/20 bg-brand-soft text-brand"
              : "border-transparent text-ink-3 hover:bg-soft hover:text-ink"
          }`}
        >
          <PortalIcon name={group.icon} />
          <UnreadBadge count={groupUnread} compact />
        </button>
      );
    }

    return (
      <div key={group.id}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpenGroups((current) => ({ ...current, [group.id]: !open }))}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-200 hover:bg-soft ${
            holdsActive ? "font-medium text-ink" : "text-ink-2 hover:text-ink"
          }`}
        >
          <PortalIcon name={group.icon} className={`h-4 w-4 ${holdsActive ? "text-brand" : ""}`} />
          <span className="truncate">{group.title}</span>
          {!open && <UnreadBadge count={groupUnread} compact={false} />}
          <PortalIcon
            name="chevronDown"
            className={`h-3.5 w-3.5 text-ink-3 transition-transform duration-200 ${
              open ? "rotate-180" : ""
            } ${!open && groupUnread > 0 ? "" : "ml-auto"}`}
          />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={panelId}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="ml-5 space-y-0.5 border-l border-line py-1 pl-2">
                {group.items.map((item) => renderLink(item, true))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    // Groups scroll; Settings stays pinned below them so it is always in view.
    <nav aria-label="Portal" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-2">
        {renderLink(DASHBOARD_LINK, false)}
        {collapsed ? (
          <div className="mx-3 my-2 border-t border-line" />
        ) : (
          <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2">
            Menu
          </p>
        )}
        {NAV_GROUPS.map(renderGroup)}
      </div>
      <div className="mb-2 border-t border-line pt-2">{renderLink(SETTINGS_LINK, false)}</div>
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
      <div className="flex flex-col items-center gap-3 border-t border-line pt-4">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          title="Visit website"
          aria-label="Visit website"
          className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors duration-200 hover:bg-soft hover:text-ink-2"
        >
          <PortalIcon name="externalLink" />
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
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-ink-3 transition-colors duration-200 hover:bg-soft hover:text-ink-2"
      >
        <PortalIcon name="externalLink" className="h-3.5 w-3.5" /> Visit website
      </a>
      <div className="px-3">
        <p className="truncate text-[11px] text-ink-3" title={userEmail}>
          {userEmail}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-700">
          Workspace {clientId} · {role}
        </p>
      </div>
      <div className="px-3 pb-1">
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
  mobileOpen,
  onMobileClose,
}: {
  userEmail: string;
  clientId: number;
  role: string;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {

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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-soft text-ink-3 transition-colors duration-200 hover:border-line-2 hover:text-ink"
          >
            <PortalIcon name={collapsed ? "sidebarOpen" : "sidebarClose"} />
          </button>
        </div>

        <NavLinks collapsed={collapsed} onExpand={collapsed ? onToggle : undefined} />

        <SidebarFooter
          userEmail={userEmail}
          clientId={clientId}
          role={role}
          collapsed={collapsed}
        />
      </motion.aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onMobileClose}
              className="fixed inset-0 z-40 bg-ink/20 lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-white px-4 py-6 lg:hidden"
            >
              <div className="mb-6 flex items-center justify-between px-2">
                <BrandMark />
                <button
                  type="button"
                  onClick={onMobileClose}
                  aria-label="Close menu"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-3"
                >
                  <PortalIcon name="close" />
                </button>
              </div>
              <NavLinks onNavigate={onMobileClose} />
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
