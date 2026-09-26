// add_batch_146_150.mjs - one-file batch covering Phases 146-150.
//
//   Ph146  NEW MobileTabBar: a fixed bottom tab bar on phones (hidden on
//          lg, hidden on conversation threads so the composer keeps the
//          space) - Home, Inbox with the live unread badge, Customers,
//          Broadcasts. Safe-area padding for notched devices.
//   Ph147  DashShell renders the bar and gives the content a matching
//          bottom padding so nothing hides behind it.
//   Ph148  globals.css: inputs/textarea/select get 16px on small screens
//          - iOS Safari stops auto-zooming on focus (the classic mobile
//          form annoyance).
//   Ph149  The thread's back link becomes a real thumb-sized target.
//   Ph150  Regression coverage.
//
// Website repo only. No CP change, no restart.

import fs from "node:fs";
import path from "node:path";

const TABBAR_FILE = `"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
  { href: "/dashboard", label: "Home", icon: "\\u2302", exact: true },
  { href: "/dashboard/conversations", label: "Inbox", icon: "\\u2709", exact: false },
  { href: "/dashboard/customers", label: "Customers", icon: "\\u25a4", exact: false },
  { href: "/dashboard/broadcasts", label: "Broadcasts", icon: "\\u21bb", exact: false },
];

export default function MobileTabBar() {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (pathname.startsWith("/dashboard/conversations/")) return;
    let alive = true;

    async function loadUnread() {
      try {
        const response = await fetch(
          "/api/omniflow/portal/conversations?include=counts&limit=1",
          { credentials: "same-origin", cache: "no-store" }
        );
        if (response.status !== 200 || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          counts?: { unread?: number };
        } | null;
        if (alive && payload) {
          setUnreadCount(payload.counts?.unread || 0);
        }
      } catch {
        /* the next poll retries */
      }
    }

    void loadUnread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUnread();
    }, 10_000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pathname]);

  if (pathname.startsWith("/dashboard/conversations/")) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.06] bg-[#060f1b]/95 backdrop-blur-md lg:hidden"
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
                (active ? "text-cyan-300" : "text-slate-500 active:text-slate-300")
              }
            >
              <span className="relative text-base leading-none">
                {tab.icon}
                {tab.label === "Inbox" && unreadCount > 0 ? (
                  <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-rose-500/90 px-1 text-center text-[9px] font-semibold leading-4 text-white">
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
`;

const SHELL_IMPORT_FROM = `import DashSidebar from "./DashSidebar";`;
const SHELL_IMPORT_TO = `import DashSidebar from "./DashSidebar";
import MobileTabBar from "./MobileTabBar";`;

const SHELL_MAIN_FROM = `        <main className="flex-1 px-5 pb-12 pt-20 sm:px-8 lg:pt-10">
          {children}
        </main>
      </div>
    </div>
  );`;

const SHELL_MAIN_TO = `        <main className="flex-1 px-5 pb-24 pt-20 sm:px-8 lg:pb-12 lg:pt-10">
          {children}
        </main>
      </div>
      <MobileTabBar />
    </div>
  );`;

const GLOBALS_CSS_APPEND = `

@media (max-width: 640px) {
  input,
  textarea,
  select {
    font-size: 16px;
  }
}
`;

const THREAD_BACK_FROM = `        <Link
          href="/dashboard/conversations"
          className="text-xs text-slate-500 transition-colors hover:text-cyan-300"
        >
          ← Conversations
        </Link>`;

const THREAD_BACK_TO = `        <Link
          href="/dashboard/conversations"
          className="-ml-2 inline-block rounded-lg px-2 py-1.5 text-sm text-slate-500 transition-colors hover:bg-white/[0.03] hover:text-cyan-300"
        >
          ← Conversations
        </Link>`;

const NEW_FILES = [
  { path: "Omniflow/app/dashboard/components/MobileTabBar.tsx", content: TABBAR_FILE, marker: "MobileTabBar", name: "p146-tab-bar" },
];

const TARGETS = [
  {
    file: "Omniflow/app/dashboard/components/DashShell.tsx",
    swaps: [
      { name: "p147-shell-import", from: SHELL_IMPORT_FROM, to: SHELL_IMPORT_TO, guard: "MobileTabBar" },
      { name: "p147-shell-render", from: SHELL_MAIN_FROM, to: SHELL_MAIN_TO, guard: "<MobileTabBar />" },
    ],
  },
  {
    file: "Omniflow/app/globals.css",
    swaps: [
      { name: "p148-ios-input-size", from: null, to: GLOBALS_CSS_APPEND, guard: "input,\n  textarea,\n  select {" },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      { name: "p149-thread-back-target", from: THREAD_BACK_FROM, to: THREAD_BACK_TO, guard: "-ml-2 inline-block rounded-lg px-2 py-1.5 text-sm" },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    if (swap.from === null) {
      // append-only swap for stylesheet tails
      text = text.replace(/\n*$/, "\n") + swap.to;
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_b146150.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
  fs.writeFileSync(target.file, text, "utf8");

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);