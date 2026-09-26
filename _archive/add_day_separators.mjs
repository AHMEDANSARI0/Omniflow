// add_day_separators.mjs - Phase 45: day separators in the message thread.
//
// Website only: messages group under Today / Yesterday / date pills, computed
// from the loaded messages (works with Load older and thread search). No
// backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

const PAGE_IMPORT_FROM = `import { useCallback, useEffect, useRef, useState } from "react";`;

const PAGE_IMPORT_TO = `import { Fragment, useCallback, useEffect, useRef, useState } from "react";`;

const PAGE_HELPERS_FROM = `  const visibleMessages =
    threadQuery.trim() && messages
      ? messages.filter((message) =>
          message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())
        )
      : messages;`;

const PAGE_HELPERS_TO = `  const visibleMessages =
    threadQuery.trim() && messages
      ? messages.filter((message) =>
          message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())
        )
      : messages;

  const threadMessages: ConversationMessage[] = visibleMessages ?? messages ?? [];

  const threadDayLabel = (index: number): string | null => {
    const current = threadMessages[index];
    if (!current || !current.createdAt) return null;
    const key = new Date(current.createdAt).toDateString();
    const previous = index > 0 ? threadMessages[index - 1] : null;
    if (previous && previous.createdAt &&
      new Date(previous.createdAt).toDateString() === key
    ) {
      return null;
    }
    const date = new Date(current.createdAt);
    if (date.toDateString() === new Date().toDateString()) return "Today";
    if (date.toDateString() === new Date(Date.now() - 86400000).toDateString()) {
      return "Yesterday";
    }
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };`;

const PAGE_MAP_FROM = `          {(visibleMessages ?? messages).map((message) => (
            <div
              key={message.id}`;

const PAGE_MAP_TO = `          {threadMessages.map((message, index) => (
            <Fragment key={message.id}>
            {threadDayLabel(index) && (
              <div className="flex justify-center">
                <span className="rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {threadDayLabel(index)}
                </span>
              </div>
            )}
            <div`;

const PAGE_MAP_CLOSE_FROM = `              </div>
            </div>
          ))}
        </motion.div>`;

const PAGE_MAP_CLOSE_TO = `              </div>
            </div>
            </Fragment>
          ))}
        </motion.div>`;

// Driver

const TARGETS = [
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "page-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO },
      { name: "page-helpers", from: PAGE_HELPERS_FROM, to: PAGE_HELPERS_TO },
      { name: "page-map-open", from: PAGE_MAP_FROM, to: PAGE_MAP_TO },
      { name: "page-map-close", from: PAGE_MAP_CLOSE_FROM, to: PAGE_MAP_CLOSE_TO },
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

  const backup = target.file + ".pre_daysplit.bak";
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