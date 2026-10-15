// add_live_toggle.mjs - Phase 65: pause the inbox auto-refresh.
//
// Website only: a Live/Paused toggle next to the sound control. Paused
// stops the background polling until re-enabled (the ref keeps the running
// interval honest). No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_STATE_FROM = `  const [soundEnabled, setSoundEnabled] = useState(false);`;

const PAGE_STATE_TO = `  const [soundEnabled, setSoundEnabled] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const liveModeRef = useRef(true);`;

const PAGE_POLL_FROM = `    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);`;

const PAGE_POLL_TO = `    const timer = window.setInterval(() => {
      if (liveModeRef.current && document.visibilityState === "visible")
        void refresh();
    }, POLL_MS);`;

const PAGE_BUTTON_FROM = `          {soundEnabled ? "Sound on" : "Sound off"}
        </button>`;

const PAGE_BUTTON_TO = `          {soundEnabled ? "Sound on" : "Sound off"}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = !liveMode;
            setLiveMode(next);
            liveModeRef.current = next;
          }}
          title={
            liveMode
              ? "The inbox refreshes itself"
              : "Auto-refresh is paused - click Resume to go live again"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            liveMode
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {liveMode ? "Live" : "Paused"}
        </button>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "page-live-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-live-poll", from: PAGE_POLL_FROM, to: PAGE_POLL_TO },
      { name: "page-live-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_live.bak";
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