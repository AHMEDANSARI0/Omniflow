// add_batch_67_71.mjs - one-file batch covering Phases 67-71.
//
// Website only, no CP change, no restart:
//   Ph67  Keyboard shortcuts help ("?" opens a cheat-sheet panel)
//   Ph68  Quick Close/Reopen button on every inbox row
//   Ph69  Emoji quick-insert bar in the reply composer
//   Ph70  Conversation name in the browser tab title
//   Ph71  "Updated hh:mm:ss" freshness stamp in the inbox toolbar
//
// All anchors are verified against the tree produced by Phases 51-66 and the
// whole file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph67 + Ph71: help + freshness state ---------------------------------

const INBOX_STATE_FROM = `  const [liveMode, setLiveMode] = useState(true);
  const liveModeRef = useRef(true);`;

const INBOX_STATE_TO = `  const [liveMode, setLiveMode] = useState(true);
  const liveModeRef = useRef(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);`;

// --- Ph67: "?" toggles the shortcuts panel --------------------------------

const INBOX_HELP_EFFECT_FROM = `    }, POLL_MS);`;

const INBOX_HELP_EFFECT_TO = `    }, POLL_MS);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "?") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setHelpOpen((open) => !open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);`;

// --- Ph71: stamp the last successful refresh -------------------------------

const INBOX_SYNCED_FROM = `        appendRef.current = false;
        setPending(false);`;

const INBOX_SYNCED_TO = `        appendRef.current = false;
        setPending(false);
        setSyncedAt(new Date());`;

// --- Ph68: single-row status toggle helper ---------------------------------

const INBOX_HELPER_FROM = `  async function bulkAction(action: string, assigneeEmail?: string) {
    if (bulkBusy || selectedIds.length === 0) return;
    if (
      !window.confirm(`;

const INBOX_HELPER_TO = `  async function toggleConversationStatus(id: number, status: string) {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: status === "open" ? "close" : "reopen",
          ids: [id],
        }),
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the list updates on the next poll.
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkAction(action: string, assigneeEmail?: string) {
    if (bulkBusy || selectedIds.length === 0) return;
    if (
      !window.confirm(`;

// --- Ph68: Close/Reopen button next to the row star -------------------------

const INBOX_ROW_FROM = `                      {item.starred ? "\\u2605" : "\\u2606"}
                    </button>`;

const INBOX_ROW_TO = `                      {item.starred ? "\\u2605" : "\\u2606"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleConversationStatus(item.id, item.status)}
                      title={
                        item.status === "open"
                          ? "Close this conversation"
                          : "Reopen this conversation"
                      }
                      className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:text-white"
                    >
                      {item.status === "open" ? "Close" : "Reopen"}
                    </button>`;

// --- Ph67 + Ph71: "?" button and freshness stamp in the toolbar -------------

const INBOX_TOOLBAR_FROM = `          {liveMode ? "Live" : "Paused"}
        </button>`;

const INBOX_TOOLBAR_TO = `          {liveMode ? "Live" : "Paused"}
        </button>
        <span className="text-[10px] text-slate-600">
          {syncedAt ? "Updated " + syncedAt.toLocaleTimeString() : ""}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen((open) => !open)}
          title="Keyboard shortcuts"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-white"
        >
          ?
        </button>`;

// --- Ph67: the shortcuts panel ------------------------------------------------

const INBOX_MODAL_FROM = `        </motion.ul>
      )}`;

const INBOX_MODAL_TO = `        </motion.ul>
      )}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0b1829] p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-white">
              Keyboard shortcuts
            </h2>
            <ul className="mt-3 space-y-2 text-xs text-slate-300">
              <li className="flex items-center justify-between gap-6">
                <span>Focus search</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">/</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Move down / up the list</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">j / k</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Open the highlighted chat</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">Enter</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Back to the inbox (inside a chat)</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">Esc</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Open or close this panel</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">?</kbd>
              </li>
            </ul>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="mt-4 w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:text-white"
            >
              Got it
            </button>
          </div>
        </div>
      )}`;

// --- Ph69: emoji quick-insert bar ----------------------------------------------

const DETAIL_EMOJI_FROM = `          <textarea
            value={draft}`;

const DETAIL_EMOJI_TO = `          <div className="hidden max-w-[176px] flex-wrap items-end gap-0.5 sm:flex">
            {["\\u{1F44D}", "\\u{1F64F}", "\\u{1F600}", "\\u{1F622}", "\\u{1F621}", "\\u{1F44C}", "\\u{1F91D}", "\\u{1F4B0}", "\\u{1F4E6}", "\\u{1F69A}", "\\u2705", "\\u274C", "\\u23F0", "\\u{1F4DE}", "\\u{1F60A}", "\\u{1F44B}"].map(
              (emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((current) => current + emoji)}
                  className="rounded px-1 text-base leading-6 transition-colors hover:bg-white/[0.06]"
                >
                  {emoji}
                </button>
              )
            )}
          </div>
          <textarea
            value={draft}`;

// --- Ph70: conversation name in the tab title ------------------------------------

const DETAIL_TITLE_FROM = `  const title = conversation?.contactName || conversation?.contactId || "Conversation";`;

const DETAIL_TITLE_TO = `  const title = conversation?.contactName || conversation?.contactId || "Conversation";

  useEffect(() => {
    document.title = title + " \\u00b7 OmniFlow";
    return () => {
      document.title = "OmniFlow";
    };
  }, [title]);`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p67+p71-state", from: INBOX_STATE_FROM, to: INBOX_STATE_TO },
      { name: "p67-shortcut-effect", from: INBOX_HELP_EFFECT_FROM, to: INBOX_HELP_EFFECT_TO },
      { name: "p71-synced-at", from: INBOX_SYNCED_FROM, to: INBOX_SYNCED_TO },
      { name: "p68-status-helper", from: INBOX_HELPER_FROM, to: INBOX_HELPER_TO },
      { name: "p68-status-button", from: INBOX_ROW_FROM, to: INBOX_ROW_TO },
      { name: "p67+p71-toolbar", from: INBOX_TOOLBAR_FROM, to: INBOX_TOOLBAR_TO },
      { name: "p67-help-modal", from: INBOX_MODAL_FROM, to: INBOX_MODAL_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p69-emoji-bar", from: DETAIL_EMOJI_FROM, to: DETAIL_EMOJI_TO },
      { name: "p70-title-effect", from: DETAIL_TITLE_FROM, to: DETAIL_TITLE_TO },
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

  const backup = target.file + ".pre_b6771.bak";
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