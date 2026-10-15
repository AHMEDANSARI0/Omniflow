// add_batch_115_116.mjs - one-file batch covering Phases 115-116.
//
//   Ph115  THE counts-query fix. Every inbox view (and every 15s poll) ran
//          THREE correlated EXISTS/GROUP-BY subqueries over the whole
//          messages table (needs_reply, overdue, unread) - the single
//          slowest thing in the portal. Rewritten as ONE pass: a "recent"
//          CTE aggregates the per-conversation last-in/last-out once, then
//          the counts are simple FILTERs over a LEFT JOIN. Same numbers,
//          same parameters contract (the one shape the chip_counts suite
//          pins - make_interval(hours => %s) - is preserved).
//   Ph116  One more index (conversation_id, direction, id) on messages,
//          created lazily by the existing once-per-process migration so
//          the aggregate becomes an index-only scan on big inboxes.
//
// Control plane only, no website change. Vercel deploys on push; the index
// creates itself on the first request after deploy. No restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_PATH = "OmniFlow-Control-Plane/portal_conversations.py";

// --- Ph115: single-pass counts query -----------------------------------------

const COUNTS_FROM = `        counts_sql = (
            "SELECT COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
            " )) AS needs_reply,"
            " COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " od WHERE od.conversation_id = c.id"
            " GROUP BY od.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN od.direction = 'in' THEN od.id END), 0)"
            " > COALESCE(MAX(CASE WHEN od.direction = 'out' THEN od.id END), 0)"
            " AND MAX(CASE WHEN od.direction = 'in' THEN od.created_at END)"
            " < NOW() - make_interval(hours => %s)"
            " )) AS overdue,"
            " COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))"
            " )) AS unread,"
            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"
            " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
            " WHERE c.client_id = %s AND c.status = 'open'"
        )`;

const COUNTS_TO = `        counts_sql = (
            " WITH recent AS ("
            " SELECT m.conversation_id,"
            " COALESCE(MAX(CASE WHEN m.direction = 'in' THEN m.id END), 0) AS last_in,"
            " MAX(CASE WHEN m.direction = 'in' THEN m.created_at END) AS last_in_at,"
            " COALESCE(MAX(CASE WHEN m.direction = 'out' THEN m.id END), 0) AS last_out"
            " FROM " + portal_db._q(portal_db.MSGS_TABLE) + " m"
            " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " oc"
            " ON oc.id = m.conversation_id"
            " WHERE oc.client_id = %s AND oc.status = 'open'"
            " GROUP BY m.conversation_id"
            " )"
            " SELECT COUNT(*) FILTER (WHERE recent.last_in > recent.last_out) AS needs_reply,"
            " COUNT(*) FILTER (WHERE recent.last_in > recent.last_out"
            " AND recent.last_in_at < NOW() - make_interval(hours => %s)) AS overdue,"
            " COUNT(*) FILTER (WHERE recent.last_in_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))) AS unread,"
            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"
            " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
            " LEFT JOIN recent ON recent.conversation_id = c.id"
            " WHERE c.client_id = %s AND c.status = 'open'"
        )`;

const COUNTS_PARAMS_FROM = `                    cur.execute(counts_sql, (OVERDUE_HOURS, principal["client_id"]))`;

const COUNTS_PARAMS_TO = `                    cur.execute(counts_sql, (principal["client_id"], OVERDUE_HOURS, principal["client_id"]))`;

// --- Ph116: aggregate-friendly index in the lazy migration ----------------------

const INDEX_FROM = `    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.CONV_TABLE) +
            " ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE"
        )
    conn.commit()
    _STAR_COLUMN_READY = True`;

const INDEX_TO = `    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.CONV_TABLE) +
            " ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_messages_conv_dir"
            " ON " + portal_db._q(portal_db.MSGS_TABLE) +
            " (conversation_id, direction, id)"
        )
    conn.commit()
    _STAR_COLUMN_READY = True`;

// Driver

const TARGETS = [
  {
    file: CP_PATH,
    swaps: [
      { name: "p115-counts-single-pass", from: COUNTS_FROM, to: COUNTS_TO },
      { name: "p115-counts-params", from: COUNTS_PARAMS_FROM, to: COUNTS_PARAMS_TO },
      { name: "p116-agg-index", from: INDEX_FROM, to: INDEX_TO },
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

  const backup = target.file + ".pre_b115116.bak";
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