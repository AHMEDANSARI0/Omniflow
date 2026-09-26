// add_service_metrics.mjs — Phase 26: Service level metrics on Analytics.
//
// Zero AI, no bridge changes -> NO bot restart. Adds the two industry-
// standard service metrics (WATI/Respond.io parity) to the Analytics page:
//
//   - Resolution rate: chats created in the window that are now closed.
//   - First response time: first inbound -> first outbound reply after it,
//     avg + median over conversations whose first inbound (in the window)
//     was actually answered. PERCENTILE_CONT for the true median.
//
// CP: portal_analytics.py gains two window queries + a "service" block in
// the response. lib: AnalyticsService + mapping. AnalyticsClient: new
// "Service level" section (3 tiles) between automation tiles and intents.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_service_metrics.mjs
//
// Requires Phase 25 (add_customer_context_card.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_slvl.bak
// Expected first run: 8 applied, 0 warnings (8 swaps, no new files).
// Expected rerun:     0 applied, 8 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_ANALYTICS_PATH = "OmniFlow-Control-Plane/portal_analytics.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const CLIENT_PATH =
  "Omniflow/app/dashboard/(portal)/analytics/AnalyticsClient.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_analytics.py (queries)
// --------------------------------------------------------------------------

const CP_QUERIES_FROM = `                entry_rows = portal_db.rows(cur)
            conn.commit()`;

const CP_QUERIES_TO = `                entry_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT COUNT(*) AS created,"
                    " COUNT(*) FILTER (WHERE status = 'closed') AS closed"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at > NOW() - make_interval(days => %s)",
                    (client_id, days),
                )
                service_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT AVG(EXTRACT(EPOCH FROM (t.out_ts - t.first_in)))"
                    " AS avg_seconds,"
                    " PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY"
                    " EXTRACT(EPOCH FROM (t.out_ts - t.first_in)))"
                    " AS median_seconds,"
                    " COUNT(*) AS answered"
                    " FROM ("
                    " SELECT i.conversation_id, i.first_in,"
                    " (SELECT MIN(o.created_at) FROM "
                    + portal_db._q(portal_db.MSGS_TABLE) +
                    " o WHERE o.conversation_id = i.conversation_id"
                    " AND o.direction = 'out'"
                    " AND o.created_at > i.first_in) AS out_ts"
                    " FROM (SELECT conversation_id, MIN(created_at) AS first_in"
                    " FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s AND direction = 'in'"
                    " AND created_at > NOW() - make_interval(days => %s)"
                    " GROUP BY conversation_id) i"
                    " ) t"
                    " WHERE t.out_ts IS NOT NULL",
                    (client_id, days),
                )
                frt_rows = portal_db.rows(cur)
            conn.commit()`;

// --------------------------------------------------------------------------
// Control Plane: portal_analytics.py (compute + response)
// --------------------------------------------------------------------------

const CP_COMPUTE_FROM = `    delivered = int((delivered_rows[0].get("c") if delivered_rows else 0) or 0)`;

const CP_COMPUTE_TO = `    delivered = int((delivered_rows[0].get("c") if delivered_rows else 0) or 0)

    service_row = service_rows[0] if service_rows else {}
    window_created = int(service_row.get("created") or 0)
    window_closed = int(service_row.get("closed") or 0)
    resolution_rate = (
        round(window_closed / window_created * 100, 1)
        if window_created > 0 else None
    )
    frt_row = frt_rows[0] if frt_rows else {}
    frt_answered = int(frt_row.get("answered") or 0)

    def _round_seconds(value):
        if value is None:
            return None
        try:
            return round(float(value), 1)
        except (TypeError, ValueError):
            return None

    frt_avg = _round_seconds(frt_row.get("avg_seconds")) if frt_answered else None
    frt_median = _round_seconds(frt_row.get("median_seconds")) if frt_answered else None`;

const CP_RESPONSE_FROM = `            "replies_queued": automation.get("message.enqueued", 0),
        },
        "per_day": per_day,`;

const CP_RESPONSE_TO = `            "replies_queued": automation.get("message.enqueued", 0),
        },
        "service": {
            "resolution_rate": resolution_rate,
            "frt_avg_seconds": frt_avg,
            "frt_median_seconds": frt_median,
            "answered_conversations": frt_answered,
        },
        "per_day": per_day,`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts
// --------------------------------------------------------------------------

const LIB_IFACE_FROM = `  intents: AnalyticsIntent[];
  topEntries: AnalyticsTopEntry[];
}`;

const LIB_IFACE_TO = `  intents: AnalyticsIntent[];
  topEntries: AnalyticsTopEntry[];
  service: AnalyticsService;
}

export interface AnalyticsService {
  resolutionRate: number | null;
  frtAvgSeconds: number | null;
  frtMedianSeconds: number | null;
  answeredConversations: number;
}`;

const LIB_SVC_FROM = `  const t = rawTotals as Record<string, unknown>;
  const w = rawWindow as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {`;

const LIB_SVC_TO = `  const t = rawTotals as Record<string, unknown>;
  const w = rawWindow as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const svc =
    p.service !== null && typeof p.service === "object"
      ? (p.service as Record<string, unknown>)
      : {};
  const svcNum = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  return {`;

const LIB_RETURN_FROM = `          .map((raw) => ({
            title: typeof raw.title === "string" ? raw.title : "",
            usageCount: num(raw.usage_count),
          }))
      : [],
  };
}`;

const LIB_RETURN_TO = `          .map((raw) => ({
            title: typeof raw.title === "string" ? raw.title : "",
            usageCount: num(raw.usage_count),
          }))
      : [],
    service: {
      resolutionRate: svcNum(svc.resolution_rate),
      frtAvgSeconds: svcNum(svc.frt_avg_seconds),
      frtMedianSeconds: svcNum(svc.frt_median_seconds),
      answeredConversations: num(svc.answered_conversations),
    },
  };
}`;

// --------------------------------------------------------------------------
// Website: AnalyticsClient.tsx
// --------------------------------------------------------------------------

const UI_HELPER_FROM = `function intentLabel(intent: string): string {
  return intent.charAt(0).toUpperCase() + intent.slice(1).replace(/_/g, " ");
}`;

const UI_HELPER_TO = `function intentLabel(intent: string): string {
  return intent.charAt(0).toUpperCase() + intent.slice(1).replace(/_/g, " ");
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value < 90) return Math.round(value) + "s";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  if (minutes < 60) {
    return seconds ? minutes + "m " + seconds + "s" : minutes + "m";
  }
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}`;

const UI_SECTION_FROM = `            <div className={statClass}>
              <p className={statLabel}>Replies queued</p>
              <p className={statValue}>{window.repliesQueued}</p>
              <p className="text-[10px] text-slate-600">Manual team replies</p>
            </div>
          </div>`;

const UI_SECTION_TO = `            <div className={statClass}>
              <p className={statLabel}>Replies queued</p>
              <p className={statValue}>{window.repliesQueued}</p>
              <p className="text-[10px] text-slate-600">Manual team replies</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
            <h2 className="text-sm font-semibold text-white">Service level</h2>
            <p className="mt-0.5 text-xs text-slate-600">
              How fast the team responds and how many chats get resolved.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className={statClass}>
                <p className={statLabel}>Resolution rate</p>
                <p className={statValue}>
                  {data.service?.resolutionRate != null
                    ? data.service.resolutionRate.toFixed(1) + "%"
                    : "—"}
                </p>
                <p className="text-[10px] text-slate-600">
                  Chats created in this window that are now closed
                </p>
              </div>
              <div className={statClass}>
                <p className={statLabel}>Avg first response</p>
                <p className={statValue}>
                  {formatSeconds(data.service?.frtAvgSeconds)}
                </p>
                <p className="text-[10px] text-slate-600">
                  First inbound message → first reply
                </p>
              </div>
              <div className={statClass}>
                <p className={statLabel}>Median first response</p>
                <p className={statValue}>
                  {formatSeconds(data.service?.frtMedianSeconds)}
                </p>
                <p className="text-[10px] text-slate-600">
                  {data.service?.answeredConversations
                    ? data.service.answeredConversations + " chats answered in this window"
                    : "No replies yet in this window"}
                </p>
              </div>
            </div>
          </div>`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_ANALYTICS_PATH,
    swaps: [
      { name: "cp-queries", from: CP_QUERIES_FROM, to: CP_QUERIES_TO },
      { name: "cp-compute", from: CP_COMPUTE_FROM, to: CP_COMPUTE_TO },
      { name: "cp-response", from: CP_RESPONSE_FROM, to: CP_RESPONSE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-interface", from: LIB_IFACE_FROM, to: LIB_IFACE_TO },
      { name: "lib-svc-vars", from: LIB_SVC_FROM, to: LIB_SVC_TO },
      { name: "lib-return-service", from: LIB_RETURN_FROM, to: LIB_RETURN_TO },
    ],
  },
  {
    file: CLIENT_PATH,
    swaps: [
      { name: "ui-format-helper", from: UI_HELPER_FROM, to: UI_HELPER_TO },
      { name: "ui-service-section", from: UI_SECTION_FROM, to: UI_SECTION_TO },
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

  const backup = target.file + ".pre_slvl.bak";
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