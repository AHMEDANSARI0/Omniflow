// add_thread_search.mjs - Phase 38: search inside a conversation thread.
//
// The conversation page gets a search box above the messages that filters the
// loaded messages by text (case-insensitive) as you type. Website only, no
// backend changes, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

const PAGE_STATE_FROM = `  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);`;

const PAGE_STATE_TO = `  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");`;

const PAGE_MEMO_FROM = `  const [threadQuery, setThreadQuery] = useState("");`;

const PAGE_MEMO_TO = `  const [threadQuery, setThreadQuery] = useState("");

  const visibleMessages =
    threadQuery.trim() && messages
      ? messages.filter((message) =>
          message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())
        )
      : messages;`;

const PAGE_INPUT_FROM = `          className="space-y-3"
        >
          {hasMore && (`;

const PAGE_INPUT_TO = `          className="space-y-3"
        >
          {messages.length > 3 && (
            <div className="sticky top-0 z-10 -mx-1 bg-[#06101d]/90 px-1 py-2 backdrop-blur">
              <input
                type="search"
                value={threadQuery}
                onChange={(event) => setThreadQuery(event.target.value)}
                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
            </div>
          )}
          {hasMore && (`;

const PAGE_MAP_FROM = `          {messages.map((message) => (`;

const PAGE_MAP_TO = `          {(visibleMessages ?? messages).map((message) => (`;

const PAGE_EMPTY_FROM = `      ) : messages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages in this conversation yet.</p>
        </div>
      ) : (`;

const PAGE_EMPTY_TO = `      ) : messages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages in this conversation yet.</p>
        </div>
      ) : visibleMessages && visibleMessages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages match your search.</p>
        </div>
      ) : (`;

// Driver

const TARGETS = [
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-filtered-list", from: PAGE_MEMO_FROM, to: PAGE_MEMO_TO },
      { name: "page-search-input", from: PAGE_INPUT_FROM, to: PAGE_INPUT_TO },
      { name: "page-map", from: PAGE_MAP_FROM, to: PAGE_MAP_TO },
      { name: "page-empty-state", from: PAGE_EMPTY_FROM, to: PAGE_EMPTY_TO },
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

  const backup = target.file + ".pre_tsearch.bak";
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