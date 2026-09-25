// add_detail_toolkit.mjs - Phase 40: conversation toolkit (transcript download,
// copy number, open in WhatsApp).
//
// Website only: the conversation page header gets WhatsApp, Copy number and
// Download transcript actions next to Close/Reopen. No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

const PAGE_HANDLERS_FROM = `  async function loadOlder() {`;

const PAGE_HANDLERS_TO = `  function copyNumber() {
    const value = conversation?.contactId || "";
    if (value) void navigator.clipboard.writeText(value);
  }

  function downloadTranscript() {
    if (!messages || !conversation) return;
    const agentLabel = "Agent";
    const customerLabel = conversation.contactName || conversation.contactId || "Customer";
    const lines = messages.map((message) =>
      "[" + (message.createdAt || "unknown") + "] " +
      (message.direction === "out" ? agentLabel : customerLabel) +
      ": " + message.body
    );
    const blob = new Blob(
      ["Conversation with " + customerLabel + "\\n\\n" + lines.join("\\n")],
      { type: "text/plain;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "conversation-" + conversation.id + ".txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadOlder() {`;

const PAGE_BUTTONS_FROM = `                {statusBusy
                  ? "Working…"
                  : conversation.status === "open"
                    ? "Close"
                    : "Reopen"}
              </button>
            </div>
          )}`;

const PAGE_BUTTONS_TO = `                {statusBusy
                  ? "Working…"
                  : conversation.status === "open"
                    ? "Close"
                    : "Reopen"}
              </button>
              {conversation.contactId && (
                <>
                  <a
                    href={\`https://wa.me/\${conversation.contactId.replace(/[^0-9]/g, "")}\`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-400/[0.12]"
                  >
                    WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => copyNumber()}
                    title="Copy number"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadTranscript()}
                    title="Download the loaded messages as a text file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Transcript
                  </button>
                </>
              )}
            </div>
          )}`;

// Driver

const TARGETS = [
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "page-handlers", from: PAGE_HANDLERS_FROM, to: PAGE_HANDLERS_TO },
      { name: "page-buttons", from: PAGE_BUTTONS_FROM, to: PAGE_BUTTONS_TO },
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

  const backup = target.file + ".pre_tool.bak";
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