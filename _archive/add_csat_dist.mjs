// add_csat_dist.mjs - Phase 29: CSAT distribution and lists on team performance.
//
// Extends GET /portal/team/performance: the CSAT average gets a per-star
// distribution, the list of low ratings (1-2 stars) and recent ratings.
// Team page shows a star bar, a low-ratings alert, and a recent ratings list.
// No bridge changes, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_TEAM_PATH = "OmniFlow-Control-Plane/portal_team.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/team/page.tsx";

// portal_team.py

const CP_QUERY_FROM = `                cur.execute(
                    "SELECT COUNT(*) AS answered, AVG(score) AS avg_score"
                    " FROM " + portal_db._q(portal_db.CSAT_TABLE) +
                    " WHERE client_id = %s AND score IS NOT NULL"
                    " AND answered_at >= NOW()"
                    " - CAST(%s AS INT) * INTERVAL '1 day'",
                    (client_id, PERF_WINDOW_DAYS),
                )
                csat_rows = portal_db.rows(cur)
                csat_row = csat_rows[0] if csat_rows else {}
            conn.commit()`;

const CP_QUERY_TO = `                cur.execute(
                    "SELECT score, COUNT(*) AS total, MAX(answered_at) AS latest"
                    " FROM " + portal_db._q(portal_db.CSAT_TABLE) +
                    " WHERE client_id = %s AND score IS NOT NULL"
                    " AND answered_at >= NOW()"
                    " - CAST(%s AS INT) * INTERVAL '1 day'"
                    " GROUP BY score"
                    " ORDER BY score ASC",
                    (client_id, PERF_WINDOW_DAYS),
                )
                csat_rows = portal_db.rows(cur)
                csat_total = sum(int(row.get("total") or 0) for row in csat_rows)
                csat_weighted = sum(
                    int(row.get("score") or 0) * int(row.get("total") or 0)
                    for row in csat_rows
                )
            conn.commit()`;

const CP_COMPUTE_FROM = `    avg_score = csat_row.get("avg_score")
    try:
        csat_avg = round(float(avg_score), 1) if avg_score is not None else None
    except (TypeError, ValueError):
        csat_avg = None
    return jsonify({
        "ok": True,
        "window_days": PERF_WINDOW_DAYS,
        "members": performance,
        "board": {
            "open_conversations": int(board_row.get("open_total") or 0),
            "unassigned_open": int(board_row.get("unassigned_open") or 0),
            "replies_sent": total_replies,
            "csat_avg": csat_avg,
            "csat_answered": int(csat_row.get("answered") or 0),
        },
    }), 200`;

const CP_COMPUTE_TO = `    dist = [0, 0, 0, 0, 0]
    recent = []
    for row in csat_rows:
        score = int(row.get("score") or 0)
        total = int(row.get("total") or 0)
        if 1 <= score <= 5:
            dist[score - 1] = total
        latest = _iso(row.get("latest"))
        if latest:
            recent.append({"score": score, "at": latest})
    recent.sort(key=lambda item: item["at"], reverse=True)
    recent = recent[:3]
    csat_answered = sum(dist)
    csat_avg = (
        round(csat_weighted / csat_answered, 1) if csat_answered else None
    )
    return jsonify({
        "ok": True,
        "window_days": PERF_WINDOW_DAYS,
        "members": performance,
        "board": {
            "open_conversations": int(board_row.get("open_total") or 0),
            "unassigned_open": int(board_row.get("unassigned_open") or 0),
            "replies_sent": total_replies,
            "csat_avg": csat_avg,
            "csat_answered": csat_answered,
            "csat_dist": dist,
            "csat_low": [
                {"score": score, "count": total}
                for score, total in [(i + 1, dist[i]) for i in range(2)]
                if total
            ],
            "csat_recent": recent,
        },
    }), 200`;

// lib/omniflow/portal.ts

const LIB_BOARD_FROM = `export interface TeamPerformanceBoard {
  openConversations: number;
  unassignedOpen: number;
  repliesSent: number;
  csatAvg: number | null;
  csatAnswered: number;
}`;

const LIB_BOARD_TO = `export interface CsatLowBucket {
  score: number;
  count: number;
}

export interface CsatRecentRating {
  score: number;
  at: string;
}

export interface TeamPerformanceBoard {
  openConversations: number;
  unassignedOpen: number;
  repliesSent: number;
  csatAvg: number | null;
  csatAnswered: number;
  csatDist: number[];
  csatLow: CsatLowBucket[];
  csatRecent: CsatRecentRating[];
}`;

const LIB_MAP_FROM = `      csatAvg: typeof boardRaw.csat_avg === "number" ? boardRaw.csat_avg : null,
      csatAnswered:
        typeof boardRaw.csat_answered === "number" ? boardRaw.csat_answered : 0,
    },`;

const LIB_MAP_TO = `      csatAvg: typeof boardRaw.csat_avg === "number" ? boardRaw.csat_avg : null,
      csatAnswered:
        typeof boardRaw.csat_answered === "number" ? boardRaw.csat_answered : 0,
      csatDist:
        Array.isArray(boardRaw.csat_dist) && boardRaw.csat_dist.length === 5
          ? boardRaw.csat_dist.map((value) => (typeof value === "number" ? value : 0))
          : [0, 0, 0, 0, 0],
      csatLow: Array.isArray(boardRaw.csat_low)
        ? boardRaw.csat_low
            .map((bucket) => ({
              score: typeof bucket.score === "number" ? bucket.score : 0,
              count: typeof bucket.count === "number" ? bucket.count : 0,
            }))
            .filter((bucket) => bucket.score > 0 && bucket.count > 0)
        : [],
      csatRecent: Array.isArray(boardRaw.csat_recent)
        ? boardRaw.csat_recent
            .map((entry) => ({
              score: typeof entry.score === "number" ? entry.score : 0,
              at: typeof entry.at === "string" ? entry.at : "",
            }))
            .filter((entry) => entry.score > 0 && entry.at)
        : [],
    },`;

// team page

const PAGE_IFACE_FROM = `    csatAvg: number | null;
    csatAnswered: number;
  };
}`;

const PAGE_IFACE_TO = `    csatAvg: number | null;
    csatAnswered: number;
    csatDist: number[];
    csatLow: { score: number; count: number }[];
    csatRecent: { score: number; at: string }[];
  };
}`;

const PAGE_BAR_FROM = `              <p className="mt-0.5 text-lg font-semibold text-white">
                {perf.board.csatAvg !== null ? perf.board.csatAvg.toFixed(1) : "—"}
                <span className="ml-1 text-[10px] font-normal text-slate-600">
                  {perf.board.csatAnswered > 0
                    ? "(" + perf.board.csatAnswered + ")"
                    : ""}
                </span>
              </p>
            </div>
          </div>`;

const PAGE_BAR_TO = `              <p className="mt-0.5 text-lg font-semibold text-white">
                {perf.board.csatAvg !== null ? perf.board.csatAvg.toFixed(1) : "—"}
                <span className="ml-1 text-[10px] font-normal text-slate-600">
                  {perf.board.csatAnswered > 0
                    ? "(" + perf.board.csatAnswered + ")"
                    : ""}
                </span>
              </p>
            </div>
          </div>
          {perf.board.csatAnswered > 0 && (
            <div className="mt-3">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.04]">
                {[0, 1, 2, 3, 4].map((index) => {
                  const share =
                    (perf.board.csatDist[index] / perf.board.csatAnswered) * 100;
                  const colors = [
                    "bg-red-400/70",
                    "bg-orange-400/70",
                    "bg-yellow-400/70",
                    "bg-lime-400/70",
                    "bg-emerald-400/70",
                  ];
                  return share > 0 ? (
                    <div
                      key={"star-" + String(index)}
                      className={colors[index]}
                      style={{ width: share + "%" }}
                    />
                  ) : null;
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-600">
                {[1, 2, 3, 4, 5].map((star) => (
                  <span key={"star-label-" + String(star)}>
                    {star}★ {perf.board.csatDist[star - 1]}
                  </span>
                ))}
              </div>
              {perf.board.csatLow.length > 0 && (
                <p className="mt-2 text-[11px] text-red-300">
                  {perf.board.csatLow
                    .map((bucket) => bucket.count + "× " + bucket.score + "★")
                    .join(", ")}
                  {" "}— worth a personal follow-up.
                </p>
              )}
              {perf.board.csatRecent.length > 0 && (
                <p className="mt-1 text-[10px] text-slate-600">
                  Latest:{" "}
                  {perf.board.csatRecent
                    .map(
                      (entry) =>
                        entry.score + "★ · " + entry.at.slice(0, 10)
                    )
                    .join("  ")}
                </p>
              )}
            </div>
          )}`;

// Driver

const TARGETS = [
  {
    file: CP_TEAM_PATH,
    swaps: [
      { name: "cp-csat-query", from: CP_QUERY_FROM, to: CP_QUERY_TO },
      { name: "cp-compute-response", from: CP_COMPUTE_FROM, to: CP_COMPUTE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-board-interface", from: LIB_BOARD_FROM, to: LIB_BOARD_TO },
      { name: "lib-board-mapping", from: LIB_MAP_FROM, to: LIB_MAP_TO },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-interface", from: PAGE_IFACE_FROM, to: PAGE_IFACE_TO },
      { name: "page-csat-bar", from: PAGE_BAR_FROM, to: PAGE_BAR_TO },
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

  const backup = target.file + ".pre_csd.bak";
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