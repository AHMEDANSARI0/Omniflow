// add_load_more.mjs - Phase 42: Load more pagination for the inbox.
//
// GET /portal/conversations accepts page=N (OFFSET (N-1)*limit, list only).
// The inbox gets a Load more button after 50 rows and appends the next page;
// changing any filter resets to page 1. Requires Phase 39 applied first.
// No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_PARSE_FROM = `    limit = max(1, min(50, limit))`;

const CP_PARSE_TO = `    limit = max(1, min(50, limit))
    raw_page = request.args.get("page") or ""
    try:
        page = int(raw_page) if raw_page else 1
    except (TypeError, ValueError):
        page = 1
    page = max(1, page)`;

const CP_OFFSET_FROM = `    params.append(limit)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)`;

const CP_OFFSET_TO = `    params.append(limit)
    if page > 1:
        sql += " OFFSET %s"
        params.append((page - 1) * limit)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)`;

// lib/omniflow/portal.ts

const LIB_SIGNATURE_FROM = `  unreadFilter?: string,
  starredFilter?: string
): Promise<`;

const LIB_SIGNATURE_TO = `  unreadFilter?: string,
  starredFilter?: string,
  page?: number
): Promise<`;

const LIB_PART_FROM = `  const starredPart = starredFilter === "1" ? "starred=1" : "";`;

const LIB_PART_TO = `  const starredPart = starredFilter === "1" ? "starred=1" : "";
  const pagePart = page && page >= 2 && page <= 100 ? "page=" + Math.floor(page) : "";`;

const LIB_PARTS_FROM = `    unreadPart,
    starredPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `    unreadPart,
    starredPart,
    pagePart,
  ].filter(Boolean);`;

// BFF conversations route

const BFF_PARSE_FROM = `    const starredFilter = url.searchParams.get("starred") === "1" ? "1" : "";`;

const BFF_PARSE_TO = `    const starredFilter = url.searchParams.get("starred") === "1" ? "1" : "";
    const pageRaw = url.searchParams.get("page") || "";
    const pageNumber = Number(pageRaw);
    const pageFilter =
      pageRaw && Number.isInteger(pageNumber) && pageNumber >= 2 && pageNumber <= 100
        ? pageNumber
        : undefined;`;

const BFF_CALL_FROM = `      unreadFilter,
      starredFilter
    );`;

const BFF_CALL_TO = `      unreadFilter,
      starredFilter,
      pageFilter
    );`;

// inbox page

const PAGE_STATE_FROM = `  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");`;

const PAGE_STATE_TO = `  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");
  const pageRef = useRef(1);
  const appendRef = useRef(false);
  const lastKeyRef = useRef("");`;

const PAGE_KEY_FROM = `  const refresh = useCallback(async () => {
    try {
      const listParams = new URLSearchParams();`;

const PAGE_KEY_TO = `  const refresh = useCallback(async () => {
    try {
      const filtersKey = [
        searchRef.current,
        statusRef.current,
        intentRef.current,
        channelRef.current,
        tagRef.current,
        replyFilterRef.current,
        oldestRef.current ? "oldest" : "",
        assignedRef.current,
        daysRef.current,
        unreadRef.current,
        starredRef.current,
      ].join("|");
      if (filtersKey !== lastKeyRef.current) {
        pageRef.current = 1;
        lastKeyRef.current = filtersKey;
      }
      const listParams = new URLSearchParams();`;

const PAGE_PARAM_FROM = `      if (starredRef.current) listParams.set("starred", starredRef.current);`;

const PAGE_PARAM_TO = `      if (starredRef.current) listParams.set("starred", starredRef.current);
      if (pageRef.current > 1) listParams.set("page", String(pageRef.current));`;

const PAGE_MERGE_FROM = `      if (Array.isArray(payload.conversations)) {
        setItems(payload.conversations);
        setPending(false);`;

const PAGE_MERGE_TO = `      if (Array.isArray(payload.conversations)) {
        const incoming = payload.conversations;
        setItems((current) => {
          if (!appendRef.current || !current) return incoming;
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...incoming.filter((item) => !seen.has(item.id))];
        });
        appendRef.current = false;
        setPending(false);`;

const PAGE_BUTTON_FROM = `        </motion.ul>
      )}`;

const PAGE_BUTTON_TO = `        </motion.ul>
      )}
      {items && items.length >= 50 && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              appendRef.current = true;
              pageRef.current += 1;
              void refresh();
            }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white"
          >
            Load more
          </button>
        </div>
      )}`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-page-parse", from: CP_PARSE_FROM, to: CP_PARSE_TO },
      { name: "cp-page-offset", from: CP_OFFSET_FROM, to: CP_OFFSET_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-page-part", from: LIB_PART_FROM, to: LIB_PART_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-page-parse", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-page-call", from: BFF_CALL_FROM, to: BFF_CALL_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-filter-key", from: PAGE_KEY_FROM, to: PAGE_KEY_TO },
      { name: "inbox-page-param", from: PAGE_PARAM_FROM, to: PAGE_PARAM_TO },
      { name: "inbox-merge", from: PAGE_MERGE_FROM, to: PAGE_MERGE_TO },
      { name: "inbox-load-more", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_more.bak";
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