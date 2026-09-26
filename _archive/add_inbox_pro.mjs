// add_inbox_pro.mjs — Inbox Pro: close/reopen conversations + status filter
// tabs. Backend: PATCH /api/v1/portal/conversations/<id> {status: open|closed}
// (tenant-scoped). Website: Close/Reopen button on the thread page, All/Open/
// Closed tabs on the list page, status forwarded through BFF + portal.ts.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_inbox_pro.mjs
//
// CRLF-tolerant, idempotent, backups: *.pre_inbox.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_STATUS_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/status/route.ts";

const BFF_STATUS_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  updateConversationStatus,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  const status =
    payload && typeof payload.status === "string" ? payload.status : "";
  if (status !== "open" && status !== "closed") {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown status." } },
      400
    );
  }

  try {
    const result = await updateConversationStatus(
      accessToken,
      conversationId,
      status
    );
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    if (result.kind === "ok") {
      return safeJson({ conversation: result.conversation }, 200);
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "PATCH status endpoint",
        from: `    return jsonify({
        "conversation": _conversation_public(found[0]),
        "messages": [_message_public(m) for m in reversed(msgs)],
    }), 200`,
        to: `    return jsonify({
        "conversation": _conversation_public(found[0]),
        "messages": [_message_public(m) for m in reversed(msgs)],
    }), 200


@bp.patch("/conversations/<int:conversation_id>")
def update_conversation(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in ("open", "closed"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be open or closed."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET status = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at",
                    (status, conversation_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation update")[0]), 503

    if not updated:
        # Other tenant's (or unknown) conversation -> plain 404.
        return jsonify({"error": {"code": "not_found",
                                  "message": "Conversation not found."}}), 404
    return jsonify({"conversation": _conversation_public(updated[0])}), 200`,
      },
    ],
  },

  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "listConversations status param",
        from: `export async function listConversations(
  accessToken: string,
  searchQuery?: string
): Promise<ConversationSummary[] | null> {
  const query =
    searchQuery && searchQuery.trim()
      ? "?q=" + encodeURIComponent(searchQuery.trim().slice(0, 100))
      : "";`,
        to: `export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string
): Promise<ConversationSummary[] | null> {
  const searchPart =
    searchQuery && searchQuery.trim()
      ? "q=" + encodeURIComponent(searchQuery.trim().slice(0, 100))
      : "";
  const statusPart =
    statusFilter && statusFilter !== "all"
      ? "status=" + encodeURIComponent(statusFilter)
      : "";
  const parts = [searchPart, statusPart].filter(Boolean);
  const query = parts.length ? "?" + parts.join("&") : "";`,
      },
      {
        name: "updateConversationStatus helper",
        from: `  return { kind: "ok", conversation, messages };
}`,
        to: `  return { kind: "ok", conversation, messages };
}

export type ConversationStatusResult =
  | { kind: "ok"; conversation: ConversationSummary }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function updateConversationStatus(
  accessToken: string,
  conversationId: number,
  status: "open" | "closed"
): Promise<ConversationStatusResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId)),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const conversation = normalizeConversation(
    (payload as Record<string, unknown>).conversation
  );
  if (!conversation) return { kind: "unavailable" };
  return { kind: "ok", conversation };
}`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/route.ts",
    swaps: [
      {
        name: "forward status param",
        from: `    const searchQuery =
      new URL(request.url).searchParams.get("q")?.slice(0, 100) || undefined;
    const conversations = await listConversations(accessToken, searchQuery);`,
        to: `    const url = new URL(request.url);
    const searchQuery = url.searchParams.get("q")?.slice(0, 100) || undefined;
    const statusParam = url.searchParams.get("status");
    const statusFilter =
      statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter
    );`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "status toggle handler",
        from: `  const title = conversation?.contactName || conversation?.contactId || "Conversation";`,
        to: `  const [statusBusy, setStatusBusy] = useState(false);

  async function toggleStatus() {
    if (!conversation || statusBusy) return;
    const next = conversation.status === "open" ? "closed" : "open";
    setStatusBusy(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/status\`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: next }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
      } | null;
      if (mounted.current && payload?.conversation) {
        setConversation(payload.conversation);
      }
    } catch {
      // Transient network issue — the badge updates on the next poll.
    } finally {
      if (mounted.current) setStatusBusy(false);
    }
  }

  const title = conversation?.contactName || conversation?.contactId || "Conversation";`,
      },
      {
        name: "badge gains Close/Reopen button",
        from: `          {conversation && (
            <span
              className={\`shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider \${
                conversation.status === "open"
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-500"
              }\`}
            >
              {conversation.status}
            </span>
          )}`,
        to: `          {conversation && (
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={\`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider \${
                  conversation.status === "open"
                    ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                }\`}
              >
                {conversation.status}
              </span>
              <button
                onClick={() => void toggleStatus()}
                disabled={statusBusy}
                className={\`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 \${
                  conversation.status === "open"
                    ? "border-red-400/25 bg-red-400/[0.06] text-red-300 hover:bg-red-400/[0.12]"
                    : "border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-300 hover:bg-cyan-400/[0.12]"
                }\`}
              >
                {statusBusy
                  ? "Working…"
                  : conversation.status === "open"
                    ? "Close"
                    : "Reopen"}
              </button>
            </div>
          )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "status filter state",
        from: `  const debounceRef = useRef<number | null>(null);
  const mounted = useRef(true);`,
        to: `  const debounceRef = useRef<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const statusRef = useRef<"all" | "open" | "closed">("all");
  const mounted = useRef(true);`,
      },
      {
        name: "refresh sends q + status",
        from: `      const query = searchRef.current;
      const response = await fetch(
        "/api/omniflow/portal/conversations" +
          (query ? "?q=" + encodeURIComponent(query) : ""),
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );`,
        to: `      const listParams = new URLSearchParams();
      if (searchRef.current) listParams.set("q", searchRef.current);
      if (statusRef.current !== "all") listParams.set("status", statusRef.current);
      const listQs = listParams.toString();
      const response = await fetch(
        "/api/omniflow/portal/conversations" + (listQs ? "?" + listQs : ""),
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );`,
      },
      {
        name: "status tabs UI",
        from: `          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      {!items ? (`,
        to: `          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      <div className="mb-4 flex items-center gap-2">
        {(["all", "open", "closed"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              statusRef.current = value;
              setStatusFilter(value);
              void refresh();
            }}
            className={\`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors \${
              statusFilter === value
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }\`}
          >
            {value}
          </button>
        ))}
      </div>

      {!items ? (`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(path) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", path], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
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

  const backup = target.file + ".pre_inbox.bak";
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

// New BFF route file (written only when missing).
if (fs.existsSync(BFF_STATUS_PATH)) {
  console.log("= " + BFF_STATUS_PATH + " (already present)");
} else {
  fs.mkdirSync(path.dirname(BFF_STATUS_PATH), { recursive: true });
  fs.writeFileSync(BFF_STATUS_PATH, BFF_STATUS_FILE.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + BFF_STATUS_PATH);
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