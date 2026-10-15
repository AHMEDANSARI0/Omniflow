// add_batch_97_100.mjs - one-file batch covering Phases 97-100.
//
// Website only, no CP change, no restart:
//   Ph97   Double-click a message to quote it in the reply
//   Ph98   Compact / cozy density toggle for the inbox list (persisted)
//   Ph99   Day pills stick under the header while scrolling a long thread
//   Ph100  Export the loaded messages as CSV (next to Transcript)
//
// Anchors verified against the tree produced by Phases 51-96 and the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph97: quote a message on double-click ------------------------------------

const DETAIL_QUOTE_FROM = `              <div
                className={\`max-w-[85%] rounded-2xl border px-4 py-2.5 sm:max-w-[70%] \${`;

const DETAIL_QUOTE_TO = `              <div
                onDoubleClick={() =>
                  setDraft(
                    (current) =>
                      current +
                      (current && !current.endsWith("\\n") ? "\\n" : "") +
                      "> " +
                      message.body.replace(/\\n/g, "\\n> ") +
                      "\\n\\n"
                  )
                }
                title="Double-click to quote this message in your reply"
                className={\`max-w-[85%] rounded-2xl border px-4 py-2.5 sm:max-w-[70%] \${`;

// --- Ph98: density state + persistence ------------------------------------------

const INBOX_DENSITY_STATE_FROM = `  const [syncedAt, setSyncedAt] = useState<Date | null>(null);`;

const INBOX_DENSITY_STATE_TO = `  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [compactList, setCompactList] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem("ofl_density") === "compact") {
        setCompactList(true);
      }
    } catch {
      // Storage can be unavailable in private modes.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("ofl_density", compactList ? "compact" : "cozy");
    } catch {
      // Storage can be unavailable in private modes.
    }
  }, [compactList]);`;

// --- Ph98: row padding follows the density ----------------------------------------

const INBOX_ROW_PAD_FROM = `                className="block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]"`;

const INBOX_ROW_PAD_TO = `                className={\`block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] \${compactList ? "p-2.5" : "p-4"} transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]\`}`;

// --- Ph98: density button before the "?" button --------------------------------------

const INBOX_DENSITY_BTN_FROM = `        <button
          type="button"
          onClick={() => setHelpOpen((open) => !open)}
          title="Keyboard shortcuts"`;

const INBOX_DENSITY_BTN_TO = `        <button
          type="button"
          onClick={() => setCompactList((current) => !current)}
          title={
            compactList
              ? "Roomy list"
              : "Fit more conversations on the screen"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            compactList
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {compactList ? "Compact" : "Cozy"}
        </button>
        <button
          type="button"
          onClick={() => setHelpOpen((open) => !open)}
          title="Keyboard shortcuts"`;

// --- Ph99: sticky day pills -------------------------------------------------------------

const DETAIL_STICKY_FROM = `            {threadDayLabel(index) && (
              <div className="flex justify-center">
                <span className="rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {threadDayLabel(index)}
                </span>
              </div>
            )}`;

const DETAIL_STICKY_TO = `            {threadDayLabel(index) && (
              <div className="sticky top-[4.25rem] z-10 flex justify-center">
                <span className="rounded-full border border-white/[0.06] bg-[#06101d] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 shadow-sm">
                  {threadDayLabel(index)}
                </span>
              </div>
            )}`;

// --- Ph100: CSV export handler + button -----------------------------------------------

const DETAIL_CSV_FN_FROM = `  async function sendReply() {`;

const DETAIL_CSV_FN_TO = `  function exportThreadCsv() {
    if (!messages || messages.length === 0) return;
    const csvCell = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const lines = ["created_at,direction,intent,body"];
    for (const message of messages) {
      lines.push(
        [
          message.createdAt,
          message.direction,
          message.intent ?? "",
          message.body,
        ]
          .map(csvCell)
          .join(",")
      );
    }
    const blob = new Blob(["\\ufeff" + lines.join("\\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "omniflow-conversation-" + id + ".csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function sendReply() {`;

const DETAIL_CSV_BTN_FROM = `                    onClick={() => downloadTranscript()}
                    title="Download the loaded messages as a text file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Transcript
                  </button>`;

const DETAIL_CSV_BTN_TO = `                    onClick={() => downloadTranscript()}
                    title="Download the loaded messages as a text file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Transcript
                  </button>
                  <button
                    type="button"
                    onClick={() => exportThreadCsv()}
                    title="Download the loaded messages as a CSV file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    CSV
                  </button>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p98-density-state", from: INBOX_DENSITY_STATE_FROM, to: INBOX_DENSITY_STATE_TO },
      { name: "p98-row-padding", from: INBOX_ROW_PAD_FROM, to: INBOX_ROW_PAD_TO },
      { name: "p98-density-button", from: INBOX_DENSITY_BTN_FROM, to: INBOX_DENSITY_BTN_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p97-quote-reply", from: DETAIL_QUOTE_FROM, to: DETAIL_QUOTE_TO },
      { name: "p99-sticky-day-pills", from: DETAIL_STICKY_FROM, to: DETAIL_STICKY_TO },
      { name: "p100-csv-handler", from: DETAIL_CSV_FN_FROM, to: DETAIL_CSV_FN_TO },
      { name: "p100-csv-button", from: DETAIL_CSV_BTN_FROM, to: DETAIL_CSV_BTN_TO },
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

  const backup = target.file + ".pre_b97100.bak";
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