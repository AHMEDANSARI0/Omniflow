// add_url_views.mjs - Phase 60: inbox filters become shareable links.
//
// Website only: every filter, sort and search choice is mirrored into the
// address bar, so "needs reply + unassigned" or any other view can be
// bookmarked or shared, and opening such a link restores the whole view.
// No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_SEED_FROM = `    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    try {`;

const PAGE_SEED_TO = `    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    const statusParam = urlFilters.get("status");
    if (statusParam === "open" || statusParam === "closed") {
      statusRef.current = statusParam;
      setStatusFilter(statusParam);
    }
    if (urlFilters.get("needs_reply") === "1") {
      replyFilterRef.current = "1";
      setReplyFilter("1");
    }
    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    const daysParam = urlFilters.get("days");
    if (daysParam === "1" || daysParam === "7" || daysParam === "30") {
      daysRef.current = daysParam;
      setDaysFilter(daysParam);
    }
    if (urlFilters.get("sort") === "oldest") {
      oldestRef.current = true;
      setOldestFirst(true);
    }
    const assignedParam = urlFilters.get("assigned");
    if (assignedParam === "me" || assignedParam === "unassigned") {
      assignedRef.current = assignedParam;
      setAssignedFilter(assignedParam);
    }
    const channelParam = urlFilters.get("channel");
    if (channelParam === "whatsapp" || channelParam === "website") {
      channelRef.current = channelParam;
      setChannelFilter(channelParam);
    }
    const tagParam = urlFilters.get("tag");
    if (tagParam) {
      tagRef.current = tagParam;
      setTagFilter(tagParam);
    }
    try {`;

const PAGE_SYNC_FROM = `  const refresh = useCallback(async () => {`;

const PAGE_SYNC_TO = `  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (channelFilter !== "all") params.set("channel", channelFilter);
    if (tagFilter !== "all") params.set("tag", tagFilter);
    if (replyFilter) params.set("needs_reply", replyFilter);
    if (unreadFilter) params.set("unread", unreadFilter);
    if (daysFilter) params.set("days", daysFilter);
    if (assignedFilter) params.set("assigned", assignedFilter);
    if (starredFilter) params.set("starred", starredFilter);
    if (oldestFirst) params.set("sort", "oldest");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query
        ? window.location.pathname + "?" + query
        : window.location.pathname
    );
  }, [
    search,
    statusFilter,
    channelFilter,
    tagFilter,
    replyFilter,
    unreadFilter,
    daysFilter,
    assignedFilter,
    starredFilter,
    oldestFirst,
  ]);

  const refresh = useCallback(async () => {`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "page-url-parse", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "page-url-sync", from: PAGE_SYNC_FROM, to: PAGE_SYNC_TO },
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

  const backup = target.file + ".pre_urls.bak";
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