// add_polish_pack.mjs — Sidebar unread badge + WhatsApp phone capture.
// Sidebar: live unread-conversation count badge on the Conversations nav item
// (polls the same BFF endpoint every 10s, desktop + mobile).
// Bridge: OMNIFLOW_PHONE env value is attached to every status report, so the
// portal WhatsApp page shows the connected number.
//
// Run from the bot ROOT (folder containing Omniflow/ and src/):
//   node add_polish_pack.mjs
//
// CRLF-tolerant, idempotent, backups: *.pre_polish.bak

import fs from "node:fs";

const TARGETS = [
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "imports gain useEffect",
        from: `import { useState } from "react";`,
        to: `import { useEffect, useState } from "react";`,
      },
      {
        name: "unread count hook",
        from: `  const pathname = usePathname();

  return (
    <nav className="space-y-1">`,
        to: `  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let alive = true;

    async function loadUnread() {
      try {
        const response = await fetch("/api/omniflow/portal/conversations", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200 || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          conversations?: { unread?: boolean }[];
        } | null;
        if (
          alive &&
          payload &&
          Array.isArray(payload.conversations)
        ) {
          setUnreadCount(
            payload.conversations.filter(
              (conversation) => conversation.unread === true
            ).length
          );
        }
      } catch {
        // Transient network issue — the next poll retries.
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
  }, []);

  return (
    <nav className="space-y-1">`,
      },
      {
        name: "nav link gains relative anchor",
        from: "            className={`flex items-center gap-3 rounded-xl border py-2.5 text-sm transition-colors duration-200 ${",
        to: "            className={`relative flex items-center gap-3 rounded-xl border py-2.5 text-sm transition-colors duration-200 ${",
      },
      {
        name: "unread badge element",
        from: `            {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
          </Link>`,
        to: `            {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
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
          </Link>`,
      },
    ],
  },
  {
    file: "src/control_plane_bridge.py",
    swaps: [
      {
        name: "docstring gains OMNIFLOW_PHONE",
        from: `  OMNIFLOW_COMMAND_POLL_SECONDS (optional, default: 15)`,
        to: `  OMNIFLOW_COMMAND_POLL_SECONDS (optional, default: 15)
  OMNIFLOW_PHONE                (optional — shown as the connected WhatsApp number in the portal)`,
      },
      {
        name: "init reads phone",
        from: `        self.client_id = int(
            os.getenv("OMNIFLOW_CLIENT_ID", "1")
        )`,
        to: `        self.client_id = int(
            os.getenv("OMNIFLOW_CLIENT_ID", "1")
        )

        self.phone = (
            str(os.getenv("OMNIFLOW_PHONE", "")).strip() or None
        )`,
      },
      {
        name: "status reports include phone",
        from: `    def report_status(self, state, phone=None):`,
        to: `    def report_status(self, state, phone=None):
        if phone is None and getattr(self, "phone", None):
            phone = self.phone`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

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

  const backup = target.file + ".pre_polish.bak";
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