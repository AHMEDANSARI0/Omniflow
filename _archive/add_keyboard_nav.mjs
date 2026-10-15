// add_keyboard_nav.mjs - Phase 61: drive the inbox from the keyboard.
//
// Website only: j moves down the conversation list, k moves up, Enter opens
// the highlighted conversation. Works with every filter combination and
// ignores keystrokes while typing in an input. No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_IMPORT_FROM = `import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";`;

const PAGE_IMPORT_TO = `import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";`;

const PAGE_NAV_FROM = `  const [bulkBusy, setBulkBusy] = useState(false);`;

const PAGE_NAV_TO = `  const [bulkBusy, setBulkBusy] = useState(false);
  const router = useRouter();
  const [activeRowIndex, setActiveRowIndex] = useState(-1);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!items || items.length === 0) return;
      event.preventDefault();
      if (event.key === "j" || event.key === "k") {
        setActiveRowIndex((current) => {
          const next =
            event.key === "j"
              ? Math.min(items.length - 1, current + 1)
              : Math.max(0, current <= 0 ? 0 : current - 1);
          const row = document.querySelector(
            '[data-conv-row="' + items[next].id + '"]'
          );
          row?.scrollIntoView({ block: "nearest" });
          return next;
        });
        return;
      }
      if (activeRowIndex >= 0 && activeRowIndex < items.length) {
        void router.push("/dashboard/conversations/" + items[activeRowIndex].id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, activeRowIndex, router]);`;

const PAGE_ROW_FROM = `          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2">`;

const PAGE_ROW_TO = `          {items.map((item) => (
            <li
              key={item.id}
              data-conv-row={item.id}
              className={
                "flex items-start gap-2 rounded-2xl " +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }
            >`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "page-router-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO },
      { name: "page-nav-state-and-effect", from: PAGE_NAV_FROM, to: PAGE_NAV_TO },
      { name: "page-row-highlight", from: PAGE_ROW_FROM, to: PAGE_ROW_TO },
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

  const backup = target.file + ".pre_knav.bak";
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