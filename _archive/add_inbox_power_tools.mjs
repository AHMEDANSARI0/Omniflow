// add_inbox_power_tools.mjs — Phase 15: Inbox Power Tools v0 (assign + export).
//
// Team inbox deepening (zero AI, no bridge changes -> NO bot restart):
// 1. Quick-assign: every inbox row gets an inline assignee dropdown (active
//    team members, "Unassigned" to clear). Uses the existing Phase-8
//    endpoints — no Control-Plane writes needed for assignment itself.
// 2. Export CSV: a new Control-Plane export endpoint (same filters as the
//    list — status/intent/channel/tag/search — up to 500 rows with labels),
//    a BFF passthrough and an "Export CSV" button that downloads a
//    spreadsheet-ready file (Excel-friendly BOM, quoted cells).
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_inbox_power_tools.mjs
//
// Requires Phase 14 (add_widget_theme.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_pt.bak
// Expected first run: 9 applied, 0 warnings (8 swaps + 1 new file).
// Expected rerun:     0 applied, 8 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_EXPORT_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/export/route.ts";

const BFF_EXPORT_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  exportConversations,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const statusFilter =
    statusParam === "open" || statusParam === "closed" ? statusParam : "all";
  const intentParam = url.searchParams.get("intent");
  const intentFilter =
    intentParam && intentParam !== "all"
      ? intentParam.toLowerCase().slice(0, 40)
      : undefined;
  const channelParam = url.searchParams.get("channel");
  const channelFilter =
    channelParam === "whatsapp" || channelParam === "website"
      ? channelParam
      : undefined;
  const tagParam = url.searchParams.get("tag");
  const tagFilter = tagParam ? tagParam.trim().slice(0, 24) : undefined;
  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;

  try {
    const data = await exportConversations(accessToken, {
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
    });
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ conversations: data, count: data.length }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const CP_EXPORT_APPEND = `


# ---------------------------------------------------------------------------
# Conversation export (CSV download source — same filters as the list)
# ---------------------------------------------------------------------------

EXPORT_LIMIT = 500


@bp.get("/conversations/export")
def export_conversations():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    status = (request.args.get("status") or "all").strip().lower()
    if status not in ALLOWED_STATUS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be all, open, or closed."}}), 400
    search = (request.args.get("q") or "").strip()[:100]
    intent_filter = (request.args.get("intent") or "").strip().lower()
    channel_filter = (request.args.get("channel") or "").strip().lower()
    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]

    sql = (
        "SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,"
        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"
        " c.lead_score, c.lead_temp, c.assigned_to, tm.name AS assignee_name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
        " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if search:
        like = "%" + search.replace("\\\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_") + "%"
        sql += (
            " AND (c.contact_name ILIKE %s OR c.contact_id ILIKE %s"
            " OR EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " sm WHERE sm.conversation_id = c.id AND sm.body ILIKE %s))"
        )
        params.extend([like, like, like])
    sql += " ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(EXPORT_LIMIT)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations export")[0]), 503

    rows = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        rows.append(item)
    return jsonify({"conversations": rows, "count": len(rows)}), 200
`;

const PORTAL_TS_EXPORT_SECTION = `// ---------------------------------------------------------------------------
// Conversation export (CSV download source)
// ---------------------------------------------------------------------------

export interface ConversationExportFilters {
  searchQuery?: string;
  statusFilter?: string;
  intentFilter?: string;
  channelFilter?: string;
  tagFilter?: string;
}

export async function exportConversations(
  accessToken: string,
  filters: ConversationExportFilters = {}
): Promise<ConversationSummary[] | null> {
  const parts: string[] = [];
  if (filters.searchQuery) {
    parts.push("q=" + encodeURIComponent(filters.searchQuery));
  }
  if (filters.statusFilter && filters.statusFilter !== "all") {
    parts.push("status=" + encodeURIComponent(filters.statusFilter));
  }
  if (filters.intentFilter && filters.intentFilter !== "all") {
    parts.push("intent=" + encodeURIComponent(filters.intentFilter));
  }
  if (filters.channelFilter && filters.channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(filters.channelFilter));
  }
  if (filters.tagFilter && filters.tagFilter !== "all") {
    parts.push("tag=" + encodeURIComponent(filters.tagFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/export" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).conversations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeConversation(row))
    .filter((row): row is ConversationSummary => row !== null);
}

export type ConversationStatusResult =`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "export endpoint appended",
        from: `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply delete")[0]), 503
    return jsonify({"ok": True}), 200`,
        to: `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply delete")[0]), 503
    return jsonify({"ok": True}), 200
` + CP_EXPORT_APPEND,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "export client function",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_EXPORT_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "local interface lead score + assignedTo",
        from: `  leadTemp: string;
  assigneeName: string | null;
  tags: string[];
}`,
        to: `  leadTemp: string;
  leadScore: number;
  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
}`,
      },
      {
        name: "team + export state",
        from: `  const [tagOptions, setTagOptions] = useState<{ tag: string; count: number }[]>([]);`,
        to: `  const [tagOptions, setTagOptions] = useState<{ tag: string; count: number }[]>([]);
  const [teamMembers, setTeamMembers] = useState<{ email: string; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);`,
      },
      {
        name: "team list load effect",
        from: `      } catch {
        // Transient network issue — the next visit retries.
      }
    })();
  }, []);`,
        to: `      } catch {
        // Transient network issue — the next visit retries.
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: { email?: string; name?: string; status?: string }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.members)) {
          setTeamMembers(
            payload.members
              .filter(
                (member): member is { email: string; name?: string; status?: string } =>
                  member !== null &&
                  typeof member === "object" &&
                  typeof member.email === "string" &&
                  member.status === "active"
              )
              .map((member) => ({
                email: member.email,
                name: typeof member.name === "string" ? member.name : "",
              }))
          );
        }
      } catch {
        // The team list is optional here — the thread page still manages assignment.
      }
    })();
  }, []);`,
      },
      {
        name: "quick-assign + export handlers",
        from: `  const loadIntentSummary = useCallback(async () => {`,
        to: `  async function quickAssign(conversationId: number, assigneeEmail: string) {
    const previous = items;
    setItems((current) =>
      current
        ? current.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  assignedTo: assigneeEmail || null,
                  assigneeName:
                    teamMembers.find((member) => member.email === assigneeEmail)
                      ?.name || (assigneeEmail || null),
                }
              : item
          )
        : current
    );
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/assign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ assigneeEmail: assigneeEmail || null }),
        }
      );
      if (!response.ok) setItems(previous);
    } catch {
      setItems(previous);
    }
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (searchRef.current) params.set("q", searchRef.current);
      if (statusRef.current !== "all") params.set("status", statusRef.current);
      if (intentRef.current !== "all") params.set("intent", intentRef.current);
      if (channelRef.current !== "all") params.set("channel", channelRef.current);
      if (tagRef.current !== "all") params.set("tag", tagRef.current);
      const qs = params.toString();
      const response = await fetch(
        "/api/omniflow/portal/conversations/export" + (qs ? "?" + qs : ""),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
      } | null;
      const rows = Array.isArray(payload?.conversations)
        ? payload.conversations
        : [];
      const headers = [
        "id",
        "channel",
        "contact_name",
        "contact_id",
        "status",
        "last_intent",
        "lead_temp",
        "lead_score",
        "assignee",
        "labels",
        "last_message_at",
        "last_message_preview",
      ];
      const csvCell = (value: unknown): string => {
        const text = value === null || value === undefined ? "" : String(value);
        return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      };
      const lines = [headers.join(",")];
      for (const row of rows) {
        lines.push(
          [
            row.id,
            row.channel,
            row.contactName,
            row.contactId,
            row.status,
            row.lastIntent,
            row.leadTemp,
            row.leadScore,
            row.assigneeName,
            row.tags.join(" | "),
            row.lastMessageAt,
            row.lastMessagePreview,
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
      link.download = "omniflow-conversations.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Export is best-effort — the merchant can retry.
    } finally {
      setExporting(false);
    }
  }

  const loadIntentSummary = useCallback(async () => {`,
      },
      {
        name: "export button in filter row",
        from: `            {value}
          </button>
        ))}
      </div>

      {!items ? (`,
        to: `            {value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || !items || items.length === 0}
          className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          {exporting ? "Preparing…" : "Export CSV"}
        </button>
      </div>

      {!items ? (`,
      },
      {
        name: "quick-assign select in row",
        from: `                    {item.tags.length > 2 && (
                      <span className="inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-slate-400">
                        +{item.tags.length - 2}
                      </span>
                    )}
                  </div>
                )}`,
        to: `                    {item.tags.length > 2 && (
                      <span className="inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-slate-400">
                        +{item.tags.length - 2}
                      </span>
                    )}
                    {teamMembers.length > 0 && (
                      <span
                        className="inline-flex"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <select
                          value={item.assignedTo ?? ""}
                          onChange={(event) =>
                            void quickAssign(item.id, event.target.value)
                          }
                          aria-label="Assign conversation"
                          className="max-w-[130px] rounded-md border border-violet-400/25 bg-violet-400/[0.06] px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300 outline-none"
                        >
                          <option value="">Unassigned</option>
                          {teamMembers.map((member) => (
                            <option key={member.email} value={member.email}>
                              {member.name || member.email}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                  </div>
                )}`,
      },
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

  const backup = target.file + ".pre_pt.bak";
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

// New files (written only when missing).
const NEW_FILES = [[BFF_EXPORT_PATH, BFF_EXPORT_FILE]];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
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