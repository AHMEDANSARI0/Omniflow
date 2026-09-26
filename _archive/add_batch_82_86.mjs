// add_batch_82_86.mjs - one-file batch covering Phases 82-86.
//
// Website only, no CP change, no restart:
//   Ph82  "u" keyboard toggle (unread-only view), listed in the cheat-sheet
//   Ph83  "x" keyboard toggle (select/deselect the highlighted chat)
//   Ph84  Clear error message when a reply fails to send
//   Ph85  The inbox refreshes the moment the window regains focus
//   Ph86  "Clear filters" button in the empty state
//
// Anchors verified against the tree produced by Phases 51-81 and the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph82 + Ph83: widen the shortcut guard with u and x ----------------------

const INBOX_KEYGUARD_FROM = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a" &&
        event.key !== "s"
      ) {`;

const INBOX_KEYGUARD_TO = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a" &&
        event.key !== "s" &&
        event.key !== "u" &&
        event.key !== "x"
      ) {`;

// --- Ph82 + Ph83: u and x handlers after the s handler ------------------------

const INBOX_HANDLERS_FROM = `      if (event.key === "s") {
        const next = starredRef.current ? "" : "1";
        starredRef.current = next;
        setStarredFilter(next);
        void refresh();
      }`;

const INBOX_HANDLERS_TO = `      if (event.key === "s") {
        const next = starredRef.current ? "" : "1";
        starredRef.current = next;
        setStarredFilter(next);
        void refresh();
        return;
      }
      if (event.key === "u") {
        const next = unreadRef.current ? "" : "1";
        unreadRef.current = next;
        setUnreadFilter(next);
        void refresh();
        return;
      }
      if (event.key === "x") {
        if (activeRowIndex >= 0 && activeRowIndex < items.length) {
          toggleSelected(items[activeRowIndex].id);
        }
      }`;

// --- Ph82 + Ph83: list u and x in the shortcuts panel ---------------------------

const INBOX_MODAL_FROM = `              <li className="flex items-center justify-between gap-6">
                <span>Toggle the starred view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">s</kbd>
              </li>`;

const INBOX_MODAL_TO = `              <li className="flex items-center justify-between gap-6">
                <span>Toggle the starred view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">s</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle unread-only</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">u</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Select or deselect the highlighted chat</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">x</kbd>
              </li>`;

// --- Ph85: refresh when the window regains focus ---------------------------------

const INBOX_FOCUS_LISTENER_FROM = `    }, POLL_MS);`;

const INBOX_FOCUS_LISTENER_TO = `    }, POLL_MS);
    function onFocus() {
      if (liveModeRef.current) void refresh();
    }
    window.addEventListener("focus", onFocus);`;

const INBOX_FOCUS_CLEANUP_FROM = `      window.clearInterval(timer);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };`;

const INBOX_FOCUS_CLEANUP_TO = `      window.clearInterval(timer);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      window.removeEventListener("focus", onFocus);
    };`;

// --- Ph86: Clear filters button in the empty state --------------------------------

const INBOX_EMPTY_FROM = `              : "Messages appear here as soon as your WhatsApp connector is linked and customers start chatting."}
          </p>`;

const INBOX_EMPTY_TO = `              : "Messages appear here as soon as your WhatsApp connector is linked and customers start chatting."}
          </p>
          {!pending &&
          (search ||
            replyFilter ||
            unreadFilter ||
            starredFilter ||
            assignedFilter ||
            daysFilter ||
            statusFilter !== "all" ||
            channelFilter !== "all" ||
            tagFilter !== "all" ||
            oldestFirst) && (
            <button
              type="button"
              onClick={() => resetFilters()}
              className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-white"
            >
              Clear filters
            </button>
          )}`;

// --- Ph84: send-failure feedback (state, logic, display) ----------------------------

const DETAIL_ERROR_STATE_FROM = `  const [statusBusy, setStatusBusy] = useState(false);`;

const DETAIL_ERROR_STATE_TO = `  const [statusBusy, setStatusBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);`;

const DETAIL_ERROR_LOGIC_FROM = `      if (response.ok) {
        setDraft("");
        void refresh();
      }`;

const DETAIL_ERROR_LOGIC_TO = `      if (response.ok) {
        setDraft("");
        setSendError(null);
        void refresh();
      } else {
        setSendError(
          "The reply did not go through. Check the connection and try again."
        );
      }`;

const DETAIL_ERROR_DISPLAY_FROM = `        )}
      {!expired && !notFound && (
        <form`;

const DETAIL_ERROR_DISPLAY_TO = `        )}
        {sendError && (
          <p className="mb-2 text-[11px] font-medium text-amber-300">
            {sendError}
          </p>
        )}
      {!expired && !notFound && (
        <form`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p82+p83-key-guard", from: INBOX_KEYGUARD_FROM, to: INBOX_KEYGUARD_TO },
      { name: "p82+p83-handlers", from: INBOX_HANDLERS_FROM, to: INBOX_HANDLERS_TO },
      { name: "p82+p83-modal", from: INBOX_MODAL_FROM, to: INBOX_MODAL_TO },
      { name: "p85-focus-listener", from: INBOX_FOCUS_LISTENER_FROM, to: INBOX_FOCUS_LISTENER_TO },
      { name: "p85-focus-cleanup", from: INBOX_FOCUS_CLEANUP_FROM, to: INBOX_FOCUS_CLEANUP_TO },
      { name: "p86-empty-clear", from: INBOX_EMPTY_FROM, to: INBOX_EMPTY_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p84-error-state", from: DETAIL_ERROR_STATE_FROM, to: DETAIL_ERROR_STATE_TO },
      { name: "p84-error-logic", from: DETAIL_ERROR_LOGIC_FROM, to: DETAIL_ERROR_LOGIC_TO },
      { name: "p84-error-display", from: DETAIL_ERROR_DISPLAY_FROM, to: DETAIL_ERROR_DISPLAY_TO },
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

  const backup = target.file + ".pre_b8286.bak";
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