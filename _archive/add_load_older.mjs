// add_load_older.mjs - Phase 34: load older messages in a conversation.
//
// The detail endpoint now reports has_more (it fetches page-size + 1 and
// trims). A new GET /portal/conversations/<id>/messages?before_id=<id> returns
// the previous window, the BFF messages route gains a GET handler and the
// conversation page gets a Load-older button above the thread. Requires
// Phase 33 applied first. No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_DETAIL_PATH = "Omniflow/app/api/omniflow/portal/conversations/[id]/route.ts";
const BFF_MESSAGES_PATH = "Omniflow/app/api/omniflow/portal/conversations/[id]/messages/route.ts";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// portal_conversations.py

const CP_DETAIL_QUERY_FROM = `                    " WHERE conversation_id = %s ORDER BY id DESC LIMIT %s",
                    (conversation_id, MESSAGE_PAGE_SIZE),
                )
                msgs = portal_db.rows(cur)`;

const CP_DETAIL_QUERY_TO = `                    " WHERE conversation_id = %s ORDER BY id DESC LIMIT %s",
                    (conversation_id, MESSAGE_PAGE_SIZE + 1),
                )
                msgs = portal_db.rows(cur)
                has_more = len(msgs) > MESSAGE_PAGE_SIZE
                if has_more:
                    msgs = msgs[:MESSAGE_PAGE_SIZE]`;

const CP_DETAIL_RESPONSE_FROM = `    return jsonify({
        "conversation": conversation_public,
        "messages": [_message_public(m) for m in reversed(msgs)],
    }), 200`;

const CP_DETAIL_RESPONSE_TO = `    return jsonify({
        "conversation": conversation_public,
        "messages": [_message_public(m) for m in reversed(msgs)],
        "has_more": has_more,
    }), 200`;

const CP_MESSAGES_ENDPOINT_FROM = `@bp.get("/conversations/intents/summary")`;

const CP_MESSAGES_ENDPOINT_TO = `@bp.get("/conversations/<int:conversation_id>/messages")
def conversation_messages(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    raw_before = request.args.get("before_id") or ""
    try:
        before_id = int(raw_before) if raw_before else 0
    except (TypeError, ValueError):
        before_id = 0

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                if before_id > 0:
                    cur.execute(
                        "SELECT id, direction, body, status, intent, created_at FROM "
                        + portal_db._q(portal_db.MSGS_TABLE) +
                        " WHERE conversation_id = %s AND id < %s"
                        " ORDER BY id DESC LIMIT %s",
                        (conversation_id, before_id, MESSAGE_PAGE_SIZE + 1),
                    )
                else:
                    cur.execute(
                        "SELECT id, direction, body, status, intent, created_at FROM "
                        + portal_db._q(portal_db.MSGS_TABLE) +
                        " WHERE conversation_id = %s"
                        " ORDER BY id DESC LIMIT %s",
                        (conversation_id, MESSAGE_PAGE_SIZE + 1),
                    )
                msgs = portal_db.rows(cur)
                has_more = len(msgs) > MESSAGE_PAGE_SIZE
                if has_more:
                    msgs = msgs[:MESSAGE_PAGE_SIZE]
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation messages")[0]), 503
    return jsonify({
        "messages": [_message_public(m) for m in reversed(msgs)],
        "has_more": has_more,
    }), 200


@bp.get("/conversations/intents/summary")`;

// lib/omniflow/portal.ts

const LIB_DETAIL_TYPE_FROM = `export type ConversationDetailResult =
  | { kind: "ok"; conversation: ConversationSummary; messages: ConversationMessage[] }
  | { kind: "not_found" }
  | { kind: "unavailable" };`;

const LIB_DETAIL_TYPE_TO = `export type ConversationDetailResult =
  | {
      kind: "ok";
      conversation: ConversationSummary;
      messages: ConversationMessage[];
      hasMore: boolean;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" };`;

const LIB_GETCONV_FROM = `export async function getConversation(
  accessToken: string,
  conversationId: number
): Promise<ConversationDetailResult> {`;

const LIB_GETCONV_TO = `function normalizeConversationMessages(raw: unknown): ConversationMessage[] {
  const rawMessages = Array.isArray(raw) ? raw : [];
  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    messages.push({
      id: typeof m.id === "number" ? m.id : 0,
      direction: m.direction === "out" ? "out" : "in",
      body: typeof m.body === "string" ? m.body : "",
      status: typeof m.status === "string" ? m.status : "delivered",
      intent: typeof m.intent === "string" ? m.intent : null,
      createdAt: typeof m.created_at === "string" ? m.created_at : null,
    });
  }
  return messages;
}

export async function getConversation(
  accessToken: string,
  conversationId: number
): Promise<ConversationDetailResult> {`;

const LIB_DETAIL_BODY_FROM = `  const rawMessages = Array.isArray(p.messages) ? p.messages : [];
  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    messages.push({
      id: typeof m.id === "number" ? m.id : 0,
      direction: m.direction === "out" ? "out" : "in",
      body: typeof m.body === "string" ? m.body : "",
      status: typeof m.status === "string" ? m.status : "delivered",
      intent: typeof m.intent === "string" ? m.intent : null,
      createdAt: typeof m.created_at === "string" ? m.created_at : null,
    });
  }
  return { kind: "ok", conversation, messages };`;

const LIB_DETAIL_BODY_TO = `  return {
    kind: "ok",
    conversation,
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };`;

const LIB_MESSAGES_FN_FROM = `export interface IntentSummaryEntry {`;

const LIB_MESSAGES_FN_TO = `export type ConversationMessagesResult =
  | { kind: "ok"; messages: ConversationMessage[]; hasMore: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function getConversationMessages(
  accessToken: string,
  conversationId: number,
  beforeId: number
): Promise<ConversationMessagesResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages?before_id=" +
        encodeURIComponent(String(beforeId))
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
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };
}

export interface IntentSummaryEntry {`;

// BFF detail route

const BFF_DETAIL_FROM = `    return safeJson(
      { conversation: result.conversation, messages: result.messages },
      200
    );`;

const BFF_DETAIL_TO = `    return safeJson(
      {
        conversation: result.conversation,
        messages: result.messages,
        has_more: result.hasMore,
      },
      200
    );`;

// BFF messages route

const BFF_MESSAGES_IMPORT_FROM = `import {
  requirePortalAccessToken,
  sendConversationMessage,
} from "../../../../../../../lib/omniflow/portal";`;

const BFF_MESSAGES_IMPORT_TO = `import {
  getConversationMessages,
  requirePortalAccessToken,
  sendConversationMessage,
} from "../../../../../../../lib/omniflow/portal";`;

const BFF_MESSAGES_GET_FROM = `export async function POST(request: Request, context: RouteContext) {`;

const BFF_MESSAGES_GET_TO = `export async function GET(request: Request, context: RouteContext) {
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

  const beforeRaw = new URL(request.url).searchParams.get("before_id") || "";
  const beforeId = Number(beforeRaw);
  if (beforeRaw && (!Number.isInteger(beforeId) || beforeId <= 0)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid before_id." } },
      400
    );
  }

  try {
    const result = await getConversationMessages(accessToken, conversationId, beforeId);
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    if (result.kind === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ messages: result.messages, has_more: result.hasMore }, 200);
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

export async function POST(request: Request, context: RouteContext) {`;

// conversation detail page

const PAGE_STATE_FROM = `  const [draft, setDraft] = useState("");`;

const PAGE_STATE_TO = `  const [draft, setDraft] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);`;

const PAGE_PAYLOAD_FROM = `      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
        messages?: ConversationMessage[];
      } | null;
      if (mounted.current && payload?.conversation && Array.isArray(payload.messages)) {
        setConversation(payload.conversation);
        setMessages(payload.messages);
      }`;

const PAGE_PAYLOAD_TO = `      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (mounted.current && payload?.conversation && Array.isArray(payload.messages)) {
        setConversation(payload.conversation);
        setMessages(payload.messages);
        setHasMore(payload.has_more === true);
      }`;

const PAGE_LOADOLDER_FROM = `    } catch {
      // Transient network issue — next poll retries.
    }
  }, [id]);`;

const PAGE_LOADOLDER_TO = `    } catch {
      // Transient network issue — next poll retries.
    }
  }, [id]);

  async function loadOlder() {
    if (loadingOlder || !messages || messages.length === 0) return;
    const oldestId = messages[0].id;
    if (!oldestId) return;
    setLoadingOlder(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/messages?before_id=\${oldestId}\`,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (!mounted.current || !payload || !Array.isArray(payload.messages)) return;
      const older = payload.messages;
      setMessages((current) => (current ? [...older, ...current] : current));
      setHasMore(payload.has_more === true);
    } catch {
      // Transient network issue, the next click retries.
    } finally {
      setLoadingOlder(false);
    }
  }`;

const PAGE_BUTTON_FROM = `          className="space-y-3"
        >
          {messages.map((message) => (`;

const PAGE_BUTTON_TO = `          className="space-y-3"
        >
          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
              >
                {loadingOlder ? "Loading..." : "Load older messages"}
              </button>
            </div>
          )}
          {messages.map((message) => (`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-detail-query", from: CP_DETAIL_QUERY_FROM, to: CP_DETAIL_QUERY_TO },
      { name: "cp-detail-response", from: CP_DETAIL_RESPONSE_FROM, to: CP_DETAIL_RESPONSE_TO },
      { name: "cp-messages-endpoint", from: CP_MESSAGES_ENDPOINT_FROM, to: CP_MESSAGES_ENDPOINT_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-detail-type", from: LIB_DETAIL_TYPE_FROM, to: LIB_DETAIL_TYPE_TO },
      { name: "lib-getconv-helper", from: LIB_GETCONV_FROM, to: LIB_GETCONV_TO },
      { name: "lib-detail-body", from: LIB_DETAIL_BODY_FROM, to: LIB_DETAIL_BODY_TO },
      { name: "lib-messages-fn", from: LIB_MESSAGES_FN_FROM, to: LIB_MESSAGES_FN_TO },
    ],
  },
  {
    file: BFF_DETAIL_PATH,
    swaps: [
      { name: "bff-detail-hasmore", from: BFF_DETAIL_FROM, to: BFF_DETAIL_TO },
    ],
  },
  {
    file: BFF_MESSAGES_PATH,
    swaps: [
      { name: "bff-messages-import", from: BFF_MESSAGES_IMPORT_FROM, to: BFF_MESSAGES_IMPORT_TO },
      { name: "bff-messages-get", from: BFF_MESSAGES_GET_FROM, to: BFF_MESSAGES_GET_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-payload", from: PAGE_PAYLOAD_FROM, to: PAGE_PAYLOAD_TO },
      { name: "page-loadolder", from: PAGE_LOADOLDER_FROM, to: PAGE_LOADOLDER_TO },
      { name: "page-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_older.bak";
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