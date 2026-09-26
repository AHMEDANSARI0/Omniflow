// add_batch_92_96.mjs - one-file batch covering Phases 92-96.
//
// Website only, no CP change, no restart:
//   Ph92  Deterministic avatar color per contact (inbox rows)
//   Ph93  Ctrl+F / Cmd+F focuses the thread search box
//   Ph94  The conversation id shows in the header (#123)
//   Ph95  Thread text size control (A / A+ / A++), persisted
//
// Ph92-96 ship together because the internal anchors interlock; the whole
// file is idempotent: a rerun applies nothing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --- Ph92: avatar hue helper --------------------------------------------------

const INBOX_HELPER_FROM = `function waitingLabel(value: string): string {`;

const INBOX_HELPER_TO = `function avatarHue(seed: string | null): number {
  if (!seed) return 190;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
}

function waitingLabel(value: string): string {`;

// --- Ph92: colored avatar -------------------------------------------------------

const INBOX_AVATAR_FROM = `                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-xs font-semibold text-cyan-300">
                      {(item.contactName || item.contactId || "?").slice(0, 2).toUpperCase()}
                    </span>`;

const INBOX_AVATAR_TO = `                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-xs font-semibold"
                      style={{
                        borderColor: \`hsl(\${avatarHue(item.contactId)} 70% 50% / 0.25)\`,
                        backgroundColor: \`hsl(\${avatarHue(item.contactId)} 70% 50% / 0.08)\`,
                        color: \`hsl(\${avatarHue(item.contactId)} 80% 72%)\`,
                      }}
                    >
                      {(item.contactName || item.contactId || "?").slice(0, 2).toUpperCase()}
                    </span>`;

// --- Ph93 + Ph95: thread refs, text-size state and persistence --------------------

const DETAIL_STATE_FROM = `  const [threadQuery, setThreadQuery] = useState("");`;

const DETAIL_STATE_TO = `  const [threadQuery, setThreadQuery] = useState("");
  const threadSearchRef = useRef<HTMLInputElement | null>(null);
  const [textSize, setTextSize] = useState<"sm" | "base" | "lg">("sm");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("ofl_thread_zoom");
      if (stored === "base" || stored === "lg") setTextSize(stored);
    } catch {
      // Storage can be unavailable in private modes.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("ofl_thread_zoom", textSize);
    } catch {
      // Storage can be unavailable in private modes.
    }
  }, [textSize]);`;

// --- Ph93: Ctrl+F / Cmd+F focuses the search box -------------------------------------

const DETAIL_CTRLF_FROM = `  }, [router]);`;

const DETAIL_CTRLF_TO = `  }, [router]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
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
        threadSearchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);`;

// --- Ph93 + Ph95: search input ref + text-size buttons --------------------------------

const DETAIL_SEARCH_FROM = `                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
              {threadQuery.trim() && (
                <p className="mt-1 text-right text-[10px] text-slate-600">
                  {threadMessages.length}{" "}
                  {threadMessages.length === 1 ? "match" : "matches"}
                </p>
              )}
            </div>`;

const DETAIL_SEARCH_TO = `                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                ref={threadSearchRef}
              />
              {threadQuery.trim() && (
                <p className="mt-1 text-right text-[10px] text-slate-600">
                  {threadMessages.length}{" "}
                  {threadMessages.length === 1 ? "match" : "matches"}
                </p>
              )}
              <div className="mt-1 flex items-center justify-end gap-1">
                <span className="text-[10px] text-slate-600">Text</span>
                {(["sm", "base", "lg"] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setTextSize(size)}
                    className={
                      "rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
                      (textSize === size
                        ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                        : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:text-white")
                    }
                  >
                    {size === "sm" ? "A" : size === "base" ? "A+" : "A++"}
                  </button>
                ))}
              </div>
            </div>`;

// --- Ph94: conversation id in the header ------------------------------------------------

const DETAIL_ID_FROM = `              {conversation?.contactId ?? (id ? \`#\${id}\` : "")}
            </p>`;

const DETAIL_ID_TO = `              {conversation?.contactId ?? (id ? \`#\${id}\` : "")}
              {conversation ? " \u00b7 #" + conversation.id : ""}
            </p>`;

// --- Ph95: message body follows the chosen text size --------------------------------------

const DETAIL_BODY_FROM = `                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">`;

const DETAIL_BODY_TO = `                <p
                  className={
                    "whitespace-pre-wrap break-words " +
                    (textSize === "sm"
                      ? "text-sm"
                      : textSize === "base"
                        ? "text-base"
                        : "text-lg") +
                    " leading-relaxed text-slate-100"
                  }
                >`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p92-hue-helper", from: INBOX_HELPER_FROM, to: INBOX_HELPER_TO },
      { name: "p92-avatar-span", from: INBOX_AVATAR_FROM, to: INBOX_AVATAR_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p93+p95-state", from: DETAIL_STATE_FROM, to: DETAIL_STATE_TO },
      { name: "p93-ctrlf-effect", from: DETAIL_CTRLF_FROM, to: DETAIL_CTRLF_TO },
      { name: "p93+p95-search-block", from: DETAIL_SEARCH_FROM, to: DETAIL_SEARCH_TO },
      { name: "p94-conversation-id", from: DETAIL_ID_FROM, to: DETAIL_ID_TO },
      { name: "p95-body-size", from: DETAIL_BODY_FROM, to: DETAIL_BODY_TO },
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

  const backup = target.file + ".pre_b9296.bak";
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