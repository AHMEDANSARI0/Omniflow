// add_batch_106_110.mjs - one-file batch covering Phases 106-110.
//
//   Ph106  Inbox rows stop prefetching their conversation pages
//          (Next prefetched every row -> dozens of background renders + CP
//          calls per inbox view; pages now load on click only)
//   Ph107  The intent-summary timer drops from 30s to 60s
//   Ph108  next.config: poweredByHeader off, compression on
//   Ph109  Customer rows stop prefetching too
//   Ph110  The thread shows an amber "away message is active" banner
//          whenever business hours are enabled and currently closed
//
// Website only, no CP change, no restart. Idempotent: a rerun applies
// nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";
const CUSTOMERS_PAGE_PATH = "Omniflow/app/dashboard/(portal)/customers/page.tsx";
const NEXT_CONFIG_PATH = "Omniflow/next.config.ts";

// --- Ph106: no prefetch on inbox rows ----------------------------------------

const INBOX_PREFETCH_FROM = `                className={\`block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] \${compactList ? "p-2.5" : "p-4"} transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]\`}`;

const INBOX_PREFETCH_TO = `                prefetch={false}
                className={\`block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] \${compactList ? "p-2.5" : "p-4"} transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]\`}`;

// --- Ph107: intent summary poll 30s -> 60s -------------------------------------

const INBOX_TIMER_FROM = `    }, 30_000);`;

const INBOX_TIMER_TO = `    }, 60_000);`;

// --- Ph108: next.config baseline --------------------------------------------------

const CONFIG_FROM = `const nextConfig: NextConfig = {
  /* config options here */
};`;

const CONFIG_TO = `const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
};`;

// --- Ph109: no prefetch on customer rows ---------------------------------------------

const CUST_PREFETCH_FROM = `              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="min-w-0 flex-1 p-4 transition-colors duration-300 hover:bg-white/[0.03]"
              >`;

const CUST_PREFETCH_TO = `              <Link
                prefetch={false}
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="min-w-0 flex-1 p-4 transition-colors duration-300 hover:bg-white/[0.03]"
              >`;

// --- Ph110: away banner (state + effect + render) --------------------------------------

const DETAIL_AWAY_STATE_FROM = `  }, [router]);`;

const DETAIL_AWAY_STATE_TO = `  }, [router]);

  const [awayActive, setAwayActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/business-hours", {
          credentials: "same-origin",
        });
        const payload = (await response.json()) as {
          business_hours?: {
            enabled?: boolean;
            timezone?: string;
            days?: { enabled: boolean; start: string; end: string }[];
          };
        };
        const config = payload.business_hours;
        if (!config || !config.enabled || cancelled) return;
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: config.timezone,
          hour12: false,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).formatToParts(new Date());
        const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
        const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
        const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
        const day = (config.days ?? [])[dayNames.indexOf(weekday)];
        const now = hour.padStart(2, "0") + ":" + minute;
        const openNow =
          day && day.enabled && now >= day.start && now <= day.end;
        if (!openNow && !cancelled) setAwayActive(true);
      } catch {
        // Transient network issue, the banner stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);`;

const DETAIL_AWAY_RENDER_FROM = `            <p className="mt-0.5 text-[10px] text-slate-600">
              Press Esc to return to the inbox
            </p>`;

const DETAIL_AWAY_RENDER_TO = `            <p className="mt-0.5 text-[10px] text-slate-600">
              Press Esc to return to the inbox
            </p>
            {awayActive && (
              <p className="mt-0.5 text-[10px] font-medium text-amber-300">
                Away message is active. Customers get an automatic reply until
                business hours.
              </p>
            )}`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p106-no-row-prefetch", from: INBOX_PREFETCH_FROM, to: INBOX_PREFETCH_TO },
      { name: "p107-summary-60s", from: INBOX_TIMER_FROM, to: INBOX_TIMER_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p110-away-state", from: DETAIL_AWAY_STATE_FROM, to: DETAIL_AWAY_STATE_TO },
      { name: "p110-away-render", from: DETAIL_AWAY_RENDER_FROM, to: DETAIL_AWAY_RENDER_TO },
    ],
  },
  {
    file: CUSTOMERS_PAGE_PATH,
    swaps: [
      { name: "p109-no-cust-prefetch", from: CUST_PREFETCH_FROM, to: CUST_PREFETCH_TO },
    ],
  },
  {
    file: NEXT_CONFIG_PATH,
    swaps: [
      { name: "p108-next-config", from: CONFIG_FROM, to: CONFIG_TO },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
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

  const backup = target.file + ".pre_b106110.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

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