// add_jump_to_latest.mjs - Phase 59: the thread opens at the newest message.
//
// Website only: after the thread loads (and whenever new messages arrive
// while the reader is already near the bottom) the page follows the latest
// message, and a floating "Jump to latest" button appears once the reader
// scrolls up. No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";



const PAGE_EFFECT_FROM = `  }, [draft, id]);`;

const PAGE_EFFECT_TO = `  }, [draft, id]);

  const threadBottomRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);

  useEffect(() => {
    function onScroll() {
      const fromBottom =
        document.documentElement.scrollHeight -
        window.innerHeight -
        window.scrollY;
      setNearBottom(fromBottom < 160);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!nearBottom) return;
    threadBottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, nearBottom]);`;

const PAGE_SENTINEL_FROM = `            </Fragment>
          ))}
        </motion.div>`;

const PAGE_SENTINEL_TO = `            </Fragment>
          ))}
          <div ref={threadBottomRef} className="h-px" />
        </motion.div>`;

const PAGE_BUTTON_FROM = `      {!expired && !notFound && (
        <form
          onSubmit={(event) => {`;

const PAGE_BUTTON_TO = `        {!nearBottom && (
          <button
            type="button"
            onClick={() =>
              threadBottomRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "end",
              })
            }
            className="fixed bottom-28 right-6 z-20 rounded-full border border-white/[0.1] bg-[#0b1829] px-4 py-2 text-xs font-medium text-slate-200 shadow-lg transition-colors hover:text-white"
          >
            Jump to latest
          </button>
        )}
      {!expired && !notFound && (
        <form
          onSubmit={(event) => {`;

// Driver

const TARGETS = [
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "page-scroll-effects", from: PAGE_EFFECT_FROM, to: PAGE_EFFECT_TO },
      { name: "page-bottom-sentinel", from: PAGE_SENTINEL_FROM, to: PAGE_SENTINEL_TO },
      { name: "page-jump-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_jump.bak";
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