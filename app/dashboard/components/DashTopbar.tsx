"use client";

import { usePathname } from "next/navigation";
import AlertsBell from "./AlertsBell";
import { openCommandPalette } from "./CommandPalette";
import { BrandMark } from "./DashSidebar";
import PortalIcon from "./PortalIcon";
import { findNav } from "./portalNav";

// §246: the one portal header for every screen size - search and alerts sit
// top right. Desktop shows where you are; phones show the brand and menu.

export default function DashTopbar({
  menuOpen,
  onMenu,
}: {
  menuOpen: boolean;
  onMenu: () => void;
}) {
  const pathname = usePathname();
  const { group, item } = findNav(pathname);

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-line bg-white/90 px-4 backdrop-blur-md lg:sticky lg:z-30 lg:h-16 lg:px-10">
      <div className="lg:hidden">
        <BrandMark />
      </div>
      <p className="hidden min-w-0 truncate text-sm text-ink-3 lg:block">
        {group && <span>{group.title} / </span>}
        <span className="font-medium text-ink">{item ? item.label : "Portal"}</span>
      </p>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openCommandPalette()}
          aria-label="Search pages, chats and customers"
          className="flex h-9 w-9 items-center justify-center gap-2.5 rounded-xl border border-line bg-soft text-sm text-ink-3 transition-colors duration-200 hover:border-line-2 hover:bg-white lg:w-72 lg:justify-start lg:px-3 xl:w-80"
        >
          <PortalIcon name="search" />
          <span className="hidden flex-1 truncate text-left lg:inline">Search pages, chats, customers</span>
          <kbd className="hidden rounded-md border border-line bg-white px-1.5 py-0.5 font-sans text-[10px] text-ink-3 lg:inline">
            Ctrl K
          </kbd>
        </button>
        <AlertsBell />
        <button
          type="button"
          onClick={onMenu}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white text-ink-2 shadow-card lg:hidden"
        >
          <PortalIcon name={menuOpen ? "close" : "menu"} />
        </button>
      </div>
    </header>
  );
}
