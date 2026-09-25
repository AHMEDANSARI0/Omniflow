"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUnreadCount } from "./useUnreadCount";

const TABS = [
  { href: "/dashboard", label: "Home", icon: "\u2302", exact: true },
  { href: "/dashboard/conversations", label: "Inbox", icon: "\u2709", exact: false },
  { href: "/dashboard/customers", label: "Customers", icon: "\u25a4", exact: false },
  { href: "/dashboard/broadcasts", label: "Broadcasts", icon: "\u21bb", exact: false },
];

export default function MobileTabBar() {
  const pathname = usePathname();
  const unreadCount = useUnreadCount();

  if (pathname.startsWith("/dashboard/conversations/")) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 backdrop-blur-md lg:hidden"
      style={{ paddingBottom: "max(0.25rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-between px-2 pt-1.5">
        {TABS.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={
                "relative flex min-w-16 flex-1 flex-col items-center gap-0.5 rounded-xl px-2 pb-1 pt-1.5 text-[10px] font-medium transition-colors duration-300 " +
                (active ? "text-brand" : "text-ink-3 active:text-ink-2")
              }
            >
              <span className="relative text-base leading-none">
                {tab.icon}
                {tab.label === "Inbox" && unreadCount > 0 ? (
                  <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-rose-500/90 px-1 text-center text-[9px] font-semibold leading-4 text-ink">
                    {unreadCount > 99 ? "99+" : String(unreadCount)}
                  </span>
                ) : null}
              </span>
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
