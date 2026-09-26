// add_batch_77_81.mjs - one-file batch covering Phases 77-81.
//
// Website only, no CP change, no restart:
//   Ph77  "s" keyboard toggle (starred view), listed in the cheat-sheet
//   Ph78  Escape closes the shortcuts panel
//   Ph79  The reply composer grows with the text (up to ~6 lines)
//   Ph80  Manual Refresh button next to the freshness stamp
//   Ph81  Amber accent on rows waiting for a reply
//
// Anchors verified against the tree produced by Phases 51-76 and the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph77: widen the shortcut guard with "s" ---------------------------------

const INBOX_KEYGUARD_FROM = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a"
      ) {`;

const INBOX_KEYGUARD_TO = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a" &&
        event.key !== "s"
      ) {`;

// --- Ph77: s handler after the a handler --------------------------------------

const INBOX_HANDLERS_FROM = `      if (event.key === "a") {
        const next = assignedRef.current === "me" ? "" : "me";
        assignedRef.current = next;
        setAssignedFilter(next);
        void refresh();
      }`;

const INBOX_HANDLERS_TO = `      if (event.key === "a") {
        const next = assignedRef.current === "me" ? "" : "me";
        assignedRef.current = next;
        setAssignedFilter(next);
        void refresh();
        return;
      }
      if (event.key === "s") {
        const next = starredRef.current ? "" : "1";
        starredRef.current = next;
        setStarredFilter(next);
        void refresh();
      }`;

// --- Ph77: list s in the shortcuts panel ----------------------------------------

const INBOX_MODAL_FROM = `              <li className="flex items-center justify-between gap-6">
                <span>Toggle assigned-to-me</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">a</kbd>
              </li>`;

const INBOX_MODAL_TO = `              <li className="flex items-center justify-between gap-6">
                <span>Toggle assigned-to-me</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">a</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle the starred view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">s</kbd>
              </li>`;

// --- Ph78: Escape closes the shortcuts panel --------------------------------------

const INBOX_ESC_FROM = `    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "?") return;`;

const INBOX_ESC_TO = `    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHelpOpen(false);
        return;
      }
      if (event.key !== "?") return;`;

// --- Ph80: manual Refresh button before the freshness stamp -------------------------

const INBOX_REFRESH_FROM = `        <span className="text-[10px] text-slate-600">
          {syncedAt ? "Updated " + syncedAt.toLocaleTimeString() : ""}
        </span>`;

const INBOX_REFRESH_TO = `        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending}
          title="Refresh now"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
        >
          {pending ? "Refreshing" : "Refresh"}
        </button>
        <span className="text-[10px] text-slate-600">
          {syncedAt ? "Updated " + syncedAt.toLocaleTimeString() : ""}
        </span>`;

// --- Ph81: amber accent on rows waiting for a reply ----------------------------------

const INBOX_ACCENT_FROM = `              className={
                "flex items-start gap-2 rounded-2xl " +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }`;

const INBOX_ACCENT_TO = `              className={
                "flex items-start gap-2 rounded-2xl " +
                (item.needsReply && item.status === "open"
                  ? "border-l-2 border-l-amber-400/60 "
                  : "") +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }`;

// --- Ph79: auto-growing composer (ref + height effect) --------------------------------

const DETAIL_COMPOSER_EFFECT_FROM = `  useEffect(() => {
    if (!draft) return;`;

const DETAIL_COMPOSER_EFFECT_TO = `  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = Math.min(composer.scrollHeight, 160) + "px";
  }, [draft]);

  useEffect(() => {
    if (!draft) return;`;

const DETAIL_TEXTAREA_FROM = `          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}`;

const DETAIL_TEXTAREA_TO = `          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p77-key-guard", from: INBOX_KEYGUARD_FROM, to: INBOX_KEYGUARD_TO },
      { name: "p77-s-handler", from: INBOX_HANDLERS_FROM, to: INBOX_HANDLERS_TO },
      { name: "p77-modal-entry", from: INBOX_MODAL_FROM, to: INBOX_MODAL_TO },
      { name: "p78-esc-closes", from: INBOX_ESC_FROM, to: INBOX_ESC_TO },
      { name: "p80-refresh-button", from: INBOX_REFRESH_FROM, to: INBOX_REFRESH_TO },
      { name: "p81-reply-accent", from: INBOX_ACCENT_FROM, to: INBOX_ACCENT_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p79-composer-effect", from: DETAIL_COMPOSER_EFFECT_FROM, to: DETAIL_COMPOSER_EFFECT_TO },
      { name: "p79-textarea-ref", from: DETAIL_TEXTAREA_FROM, to: DETAIL_TEXTAREA_TO },
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

  const backup = target.file + ".pre_b7781.bak";
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