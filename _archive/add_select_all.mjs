// add_select_all.mjs - Phase 63: select every filtered conversation at once.
//
// Website only: the bulk bar gains "Select all" (every conversation in the
// current filtered view) and "Clear" buttons. No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_BAR_FROM = `          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>`;

const PAGE_BAR_TO = `          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelectedIds((items ?? []).map((item) => item.id))}
            disabled={bulkBusy}
            title="Select every conversation in the current view"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Clear
          </button>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "page-select-all", from: PAGE_BAR_FROM, to: PAGE_BAR_TO },
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

  const backup = target.file + ".pre_selall.bak";
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