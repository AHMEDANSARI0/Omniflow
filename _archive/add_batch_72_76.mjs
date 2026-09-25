// add_batch_72_76.mjs - one-file batch covering Phases 72-76.
//
// Website only, no CP change, no restart:
//   Ph72  Channel dot + label on every inbox row
//   Ph73  Character counter (n / 4096) in the reply composer
//   Ph74  r / a keyboard toggles (needs-reply view, assigned-to-me)
//   Ph75  Copy number on click in the inbox row
//   Ph76  Match count while searching inside a conversation
//
// Anchors verified against the tree produced by Phases 51-71 and the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph72: channel dot above the row time ----------------------------------

const INBOX_CHANNEL_FROM = `                    <p
                      className={\`mt-1 text-[10px] \${
                        item.needsReply && item.status === "open" && item.lastMessageAt
                          ? "text-amber-300/80"
                          : "text-slate-600"
                      }\`}
                    >
                      {item.needsReply && item.status === "open" && item.lastMessageAt
                        ? "waiting " + waitingLabel(item.lastMessageAt)
                        : formatTime(item.lastMessageAt)}
                    </p>`;

const INBOX_CHANNEL_TO = `                    <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-600">
                      <span
                        className={
                          "inline-block h-1.5 w-1.5 rounded-full " +
                          (item.channel === "whatsapp"
                            ? "bg-emerald-400"
                            : "bg-cyan-400")
                        }
                      />
                      {item.channel}
                    </p>
                    <p
                      className={\`mt-1 text-[10px] \${
                        item.needsReply && item.status === "open" && item.lastMessageAt
                          ? "text-amber-300/80"
                          : "text-slate-600"
                      }\`}
                    >
                      {item.needsReply && item.status === "open" && item.lastMessageAt
                        ? "waiting " + waitingLabel(item.lastMessageAt)
                        : formatTime(item.lastMessageAt)}
                    </p>`;

// --- Ph74: widen the shortcut key guard --------------------------------------

const INBOX_KEYGUARD_FROM = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter"
      ) {`;

const INBOX_KEYGUARD_TO = `      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a"
      ) {`;

// --- Ph74: r / a handlers after the Enter-open branch -------------------------

const INBOX_HANDLERS_FROM = `      if (activeRowIndex >= 0 && activeRowIndex < items.length) {
        void router.push("/dashboard/conversations/" + items[activeRowIndex].id);
      }`;

const INBOX_HANDLERS_TO = `      if (activeRowIndex >= 0 && activeRowIndex < items.length) {
        void router.push("/dashboard/conversations/" + items[activeRowIndex].id);
        return;
      }
      if (event.key === "r") {
        const next = replyFilterRef.current ? "" : "1";
        replyFilterRef.current = next;
        setReplyFilter(next);
        void refresh();
        return;
      }
      if (event.key === "a") {
        const next = assignedRef.current === "me" ? "" : "me";
        assignedRef.current = next;
        setAssignedFilter(next);
        void refresh();
      }`;

// --- Ph74: list r / a in the shortcuts panel -----------------------------------

const INBOX_MODAL_FROM = `              <li className="flex items-center justify-between gap-6">
                <span>Open or close this panel</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">?</kbd>
              </li>`;

const INBOX_MODAL_TO = `              <li className="flex items-center justify-between gap-6">
                <span>Toggle the needs-reply view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">r</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle assigned-to-me</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">a</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Open or close this panel</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">?</kbd>
              </li>`;

// --- Ph75: copy number on click in the row --------------------------------------

const INBOX_COPYNUM_FROM = `                      <p className="truncate text-xs text-slate-500">
                        {item.contactId ?? "\u2014"}
                      </p>`;

const INBOX_COPYNUM_TO = `                      {item.contactId ? (
                        <button
                          type="button"
                          onClick={() =>
                            void navigator.clipboard.writeText(item.contactId ?? "")
                          }
                          title="Copy number"
                          className="truncate text-left text-xs text-slate-500 transition-colors hover:text-slate-300"
                        >
                          {item.contactId}
                        </button>
                      ) : (
                        <p className="truncate text-xs text-slate-500">\u2014</p>
                      )}`;

// --- Ph73: character counter before the Send button ------------------------------

const DETAIL_COUNTER_FROM = `          />
          <button
            type="submit"`;

const DETAIL_COUNTER_TO = `          />
          <div className="hidden shrink-0 flex-col items-end text-[10px] text-slate-600 sm:flex">
            {draft.length} / 4096
          </div>
          <button
            type="submit"`;

// --- Ph76: match count under the thread search box --------------------------------

const DETAIL_MATCHCOUNT_FROM = `                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
            </div>`;

const DETAIL_MATCHCOUNT_TO = `                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
              {threadQuery.trim() && (
                <p className="mt-1 text-right text-[10px] text-slate-600">
                  {threadMessages.length}{" "}
                  {threadMessages.length === 1 ? "match" : "matches"}
                </p>
              )}
            </div>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p72-channel-dot", from: INBOX_CHANNEL_FROM, to: INBOX_CHANNEL_TO },
      { name: "p74-key-guard", from: INBOX_KEYGUARD_FROM, to: INBOX_KEYGUARD_TO },
      { name: "p74-r-a-handlers", from: INBOX_HANDLERS_FROM, to: INBOX_HANDLERS_TO },
      { name: "p74-modal-entries", from: INBOX_MODAL_FROM, to: INBOX_MODAL_TO },
      { name: "p75-copy-number", from: INBOX_COPYNUM_FROM, to: INBOX_COPYNUM_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p73-char-counter", from: DETAIL_COUNTER_FROM, to: DETAIL_COUNTER_TO },
      { name: "p76-match-count", from: DETAIL_MATCHCOUNT_FROM, to: DETAIL_MATCHCOUNT_TO },
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

  const backup = target.file + ".pre_b7276.bak";
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