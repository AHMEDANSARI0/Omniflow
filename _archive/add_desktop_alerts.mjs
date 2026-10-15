// add_desktop_alerts.mjs - Phase 46: desktop alert on new customer messages.
//
// Website only: an Alerts on/off toggle next to Export CSV. When enabled and
// the tab is hidden, a browser notification fires whenever the unread or
// needs-reply total grows (polled counts). Requires Phase 44 applied first
// (the toggle and effect anchor on the Phase 44 mark-all-read block).
// No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_STATE_FROM = `  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
  });`;

const PAGE_STATE_TO = `  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
    unread: 0,
  });`;

const PAGE_PAYLOAD_TYPE_FROM = `        counts?: { needsReply?: number; overdue?: number; unassigned?: number };`;

const PAGE_PAYLOAD_TYPE_TO = `        counts?: {
          needsReply?: number;
          overdue?: number;
          unassigned?: number;
          unread?: number;
        };`;

const PAGE_COUNTS_FROM = `          setChipCounts({
            needsReply: payload.counts.needsReply || 0,
            overdue: payload.counts.overdue || 0,
            unassigned: payload.counts.unassigned || 0,
          });`;

const PAGE_COUNTS_TO = `          setChipCounts({
            needsReply: payload.counts.needsReply || 0,
            overdue: payload.counts.overdue || 0,
            unassigned: payload.counts.unassigned || 0,
            unread: payload.counts.unread || 0,
          });`;

const PAGE_STARRED_FROM = `  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");`;

const PAGE_STARRED_TO = `  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");
  const [alertEnabled, setAlertEnabled] = useState(false);
  const alertTotalRef = useRef(0);`;

const PAGE_FN_FROM = `  async function markAllRead() {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }`;

const PAGE_FN_TO = `  async function toggleAlert() {
    const next = !alertEnabled;
    setAlertEnabled(next);
    try {
      window.localStorage.setItem("ofl_desktop_alert", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
    if (
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission prompt unavailable.
      }
    }
  }

  useEffect(() => {
    const total = chipCounts.unread + chipCounts.needsReply;
    if (
      alertEnabled &&
      total > alertTotalRef.current &&
      document.hidden &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification("New customer message", {
          body: "Open the inbox to reply.",
        });
      } catch {
        // Notifications unavailable in this browser.
      }
    }
    alertTotalRef.current = total;
  }, [chipCounts, alertEnabled]);

  async function markAllRead() {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }`;

const PAGE_SEED_FROM = `    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    void refresh();`;

const PAGE_SEED_TO = `    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    try {
      setAlertEnabled(window.localStorage.getItem("ofl_desktop_alert") === "1");
    } catch {
      // Storage unavailable.
    }
    void refresh();`;

const PAGE_BUTTON_FROM = `        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={bulkBusy || !chipCounts.unread}
          title="Mark every open conversation as read"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          Mark all read
        </button>`;

const PAGE_BUTTON_TO = `        <button
          type="button"
          onClick={() => void toggleAlert()}
          title={
            alertEnabled
              ? "Desktop alerts are on"
              : "Get a desktop alert when new customer messages arrive"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            alertEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {alertEnabled ? "Alerts on" : "Alerts off"}
        </button>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={bulkBusy || !chipCounts.unread}
          title="Mark every open conversation as read"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          Mark all read
        </button>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-counts-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-payload-type", from: PAGE_PAYLOAD_TYPE_FROM, to: PAGE_PAYLOAD_TYPE_TO },
      { name: "inbox-counts-payload", from: PAGE_COUNTS_FROM, to: PAGE_COUNTS_TO },
      { name: "inbox-alert-state", from: PAGE_STARRED_FROM, to: PAGE_STARRED_TO },
      { name: "inbox-toggle-and-effect", from: PAGE_FN_FROM, to: PAGE_FN_TO },
      { name: "inbox-mount-seed", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "inbox-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_alert.bak";
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