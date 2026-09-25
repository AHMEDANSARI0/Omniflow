// add_batch_87_91.mjs - one-file batch covering Phases 87-91.
//
// Website only, no CP change, no restart:
//   Ph87  Unread rows get a soft cyan background (triage at a glance)
//   Ph88  WhatsApp quick-link in the Customer card
//   Ph89  The conversation widens on very large screens (2xl+)
//   Ph90  Short composer placeholder; the shortcut hint moves to a tooltip
//   Ph91  Visible "Press Esc to return to the inbox" hint in the header
//
// Anchors verified against the tree produced by Phases 51-86 and the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";
const CUSTOMER_CARD_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/CustomerCard.tsx";

// --- Ph87: soft background on unread rows ------------------------------------

const INBOX_UNREAD_FROM = `              className={
                "flex items-start gap-2 rounded-2xl " +
                (item.needsReply && item.status === "open"
                  ? "border-l-2 border-l-amber-400/60 "
                  : "") +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }`;

const INBOX_UNREAD_TO = `              className={
                "flex items-start gap-2 rounded-2xl " +
                (item.unread ? "bg-cyan-400/[0.03] " : "") +
                (item.needsReply && item.status === "open"
                  ? "border-l-2 border-l-amber-400/60 "
                  : "") +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }`;

// --- Ph88: WhatsApp quick-link in the Customer card header ----------------------

const CARD_LINK_FROM = `        <Link
          href={"/dashboard/conversations?q=" + encodeURIComponent(contactId)}
          className="text-[10px] font-medium text-cyan-300 transition-colors hover:text-cyan-200"
        >
          All chats \u2192
        </Link>`;

const CARD_LINK_TO = `        <div className="flex items-center gap-3">
          {contactId && (
            <a
              href={\`https://wa.me/\${contactId.replace(/[^0-9]/g, "")}\`}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-medium text-emerald-300 transition-colors hover:text-emerald-200"
            >
              WhatsApp \u2192
            </a>
          )}
          <Link
            href={"/dashboard/conversations?q=" + encodeURIComponent(contactId)}
            className="text-[10px] font-medium text-cyan-300 transition-colors hover:text-cyan-200"
          >
            All chats \u2192
          </Link>
        </div>`;

// --- Ph89: wider thread on 2xl screens ---------------------------------------------

const DETAIL_WIDE_FROM = `    <div className="mx-auto max-w-3xl">`;

const DETAIL_WIDE_TO = `    <div className="mx-auto max-w-3xl 2xl:max-w-5xl">`;

// --- Ph90: short placeholder + tooltip with the send shortcuts -----------------------

const DETAIL_PLACEHOLDER_FROM = `            placeholder="Reply as a human agent — Enter to send, Shift+Enter for a new line"`;

const DETAIL_PLACEHOLDER_TO = `            placeholder="Reply as a human agent"`;

const DETAIL_TOOLTIP_FROM = `          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}`;

const DETAIL_TOOLTIP_TO = `          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            title="Enter sends the reply, Shift+Enter inserts a new line"`;

// --- Ph91: visible Esc hint under the header contact id -------------------------------

const DETAIL_HINT_FROM = `              {conversation?.contactId ?? (id ? \`#\${id}\` : "")}
            </p>`;

const DETAIL_HINT_TO = `              {conversation?.contactId ?? (id ? \`#\${id}\` : "")}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-600">
              Press Esc to return to the inbox
            </p>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p87-unread-bg", from: INBOX_UNREAD_FROM, to: INBOX_UNREAD_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p89-wide-thread", from: DETAIL_WIDE_FROM, to: DETAIL_WIDE_TO },
      { name: "p90-placeholder", from: DETAIL_PLACEHOLDER_FROM, to: DETAIL_PLACEHOLDER_TO },
      { name: "p90-tooltip", from: DETAIL_TOOLTIP_FROM, to: DETAIL_TOOLTIP_TO },
      { name: "p91-esc-hint", from: DETAIL_HINT_FROM, to: DETAIL_HINT_TO },
    ],
  },
  {
    file: CUSTOMER_CARD_PATH,
    swaps: [
      { name: "p88-wa-link", from: CARD_LINK_FROM, to: CARD_LINK_TO },
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

  const backup = target.file + ".pre_b8791.bak";
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