// add_intent_intelligence.mjs — Intent Intelligence v0 (Phase 2 foundation).
// Every inbound customer message is classified into one closed intent set
// (pricing, shipping, order_tracking, refund_return, complaint, appointment,
// human_request, availability, purchase_intent, general) by a deterministic
// keyword classifier (English + Roman Urdu, zero AI cost) inside the backend
// ingest endpoint. portal_messages.intent + portal_conversations.last_intent
// (lazy DDL, self-migrating) power: row badges, click-to-filter chips with
// live counts, and an intents summary endpoint — the base for analytics,
// follow-ups and lead scoring.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_intent_intelligence.mjs
//
// CRLF-tolerant, idempotent, backups: *.pre_intent.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLASSIFIER_PATH = "OmniFlow-Control-Plane/intent_classifier.py";
const MIGRATION_PATH =
  "OmniFlow-Control-Plane/migrations/010_intent_tags.sql";
const BFF_INTENTS_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/intents/route.ts";

const CLASSIFIER_FILE = `"""Lightweight intent classifier for inbound customer messages.

Keyword-based (English + Roman Urdu), zero-cost and deterministic. Every
inbound message gets exactly one intent tag; anything unmatched falls back
to "general". Upgrade path: replace classify_intent with an AI-backed
implementation later without changing any caller.
"""

INTENT_KEYS = (
    "human_request",
    "complaint",
    "refund_return",
    "order_tracking",
    "shipping",
    "appointment",
    "pricing",
    "availability",
    "purchase_intent",
    "general",
)

_KEYWORDS = {
    "human_request": (
        "insaan", "insan", "human", "real person", "agent se baat",
        "bande se", "bandey se", "representative", "manager se", "operator",
    ),
    "complaint": (
        "shikayat", "complaint", "kharab", "masla", "problem",
        "broken", "kaam nahi", "faulty", "damaged",
    ),
    "refund_return": (
        "refund", "paise wapas", "paisay wapas", "wapas pais", "return",
        "exchange", "replace kar", "wapsi",
    ),
    "order_tracking": (
        "mera order", "order kahan", "order ka status", "order status",
        "tracking", "track kar", "kahan pohnch", "kahan pahunch",
        "kahan reach",
    ),
    "shipping": (
        "delivery", "shipping", "kab aayega", "kab milega",
        "kitne din", "courier", "dispatch",
    ),
    "appointment": (
        "appointment", "booking", "book kar", "slot", "milna",
        "visit", "timing available",
    ),
    "pricing": (
        "price", "kitna", "kitne ka", "kitne paise", "qemat", "keemat",
        "rate", "cost", "charges", "fee",
    ),
    "availability": (
        "available", "stock", "mojood", "mawjood", "mil sakta",
    ),
    "purchase_intent": (
        "order karna", "kharidna", "kharid", "buy", "purchase",
        "lena hai", "chahiye",
    ),
}


def classify_intent(body):
    """Return exactly one intent key for a customer message body."""
    text = " " + " ".join(str(body or "").lower().split()) + " "
    if not text.strip():
        return "general"
    for intent in INTENT_KEYS:
        if intent == "general":
            continue
        for keyword in _KEYWORDS[intent]:
            if keyword in text:
                return intent
    return "general"
`;

const MIGRATION_FILE = `-- 010: intent tags for analytics, follow-ups and lead scoring
-- Applied automatically by portal_db.ensure_tables(); kept here as the
-- canonical migration record (001-010).
ALTER TABLE portal_messages
    ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE portal_conversations
    ADD COLUMN IF NOT EXISTS last_intent TEXT;
`;

const BFF_INTENTS_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  fetchIntentSummary,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const summary = await fetchIntentSummary(accessToken);
    if (summary === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ intents: summary }, 200);
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
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "lazy intent columns",
        from: `ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
"""`,
        to: `ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_intent TEXT;
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import classifier",
        from: `from flask import Blueprint, jsonify, request`,
        to: `from flask import Blueprint, jsonify, request

from intent_classifier import classify_intent`,
      },
      {
        name: "classify inbound on normalize",
        from: `        normalized.append({
            "from": sender.strip(),
            "body": body,
            "name": name,
            "direction": direction,
        })`,
        to: `        item_intent = (
            classify_intent(body)
            if direction == "in"
            else None
        )
        normalized.append({
            "from": sender.strip(),
            "body": body,
            "name": name,
            "direction": direction,
            "intent": item_intent,
        })`,
      },
      {
        name: "conversation upsert carries last_intent",
        from: `                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                        " (client_id, channel, contact_id, contact_name,"
                        " status, last_message_preview, last_message_at,"
                        " created_at, updated_at) "
                        "VALUES (%s, 'whatsapp', %s, %s, 'open', %s, NOW(), NOW(), NOW()) "
                        "ON CONFLICT (client_id, channel, contact_id) DO UPDATE SET "
                        " contact_name = COALESCE(EXCLUDED.contact_name,"
                        " " + portal_db._q(portal_db.CONV_TABLE) + ".contact_name), "
                        " last_message_preview = EXCLUDED.last_message_preview, "
                        " last_message_at = EXCLUDED.last_message_at, "
                        " updated_at = NOW() "
                        "RETURNING id",
                        (tenant["client_id"], item["from"], item["name"], item["body"]),
                    )`,
        to: `                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                        " (client_id, channel, contact_id, contact_name,"
                        " status, last_message_preview, last_message_at,"
                        " last_intent, created_at, updated_at) "
                        "VALUES (%s, 'whatsapp', %s, %s, 'open', %s, NOW(), %s, NOW(), NOW()) "
                        "ON CONFLICT (client_id, channel, contact_id) DO UPDATE SET "
                        " contact_name = COALESCE(EXCLUDED.contact_name,"
                        " " + portal_db._q(portal_db.CONV_TABLE) + ".contact_name), "
                        " last_message_preview = EXCLUDED.last_message_preview, "
                        " last_message_at = EXCLUDED.last_message_at, "
                        " last_intent = COALESCE(EXCLUDED.last_intent, "
                        " " + portal_db._q(portal_db.CONV_TABLE) + ".last_intent), "
                        " updated_at = NOW() "
                        "RETURNING id",
                        (tenant["client_id"], item["from"], item["name"], item["body"],
                         item["intent"]),
                    )`,
      },
      {
        name: "message insert stores intent",
        from: `                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                        " (conversation_id, client_id, direction, body,"
                        " sender_name, status, created_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s, NOW())",
                        (conversation_id, tenant["client_id"], item["direction"],
                         item["body"], item["name"],
                         "received" if item["direction"] == "in" else "sent"),
                    )`,
        to: `                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                        " (conversation_id, client_id, direction, body,"
                        " sender_name, status, intent, created_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())",
                        (conversation_id, tenant["client_id"], item["direction"],
                         item["body"], item["name"],
                         "received" if item["direction"] == "in" else "sent",
                         item["intent"]),
                    )`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "public payload gains last_intent",
        from: `        "unread": bool(row.get("unread")),
    }`,
        to: `        "unread": bool(row.get("unread")),
        "last_intent": row.get("last_intent"),
    }`,
      },
      {
        name: "message public gains intent",
        from: `        "status": row.get("status") or "received",
        "created_at": _iso(row.get("created_at")),
    }`,
        to: `        "status": row.get("status") or "received",
        "intent": row.get("intent"),
        "created_at": _iso(row.get("created_at")),
    }`,
      },
      {
        name: "list SQL adds last_intent",
        from: `        " c.last_message_at, c.last_message_preview, c.created_at,"`,
        to: `        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"`,
      },
      {
        name: "intent filter param",
        from: `    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)`,
        to: `    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)
    intent_filter = (request.args.get("intent") or "").strip().lower()
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])`,
      },
      {
        name: "detail SELECT adds intent",
        from: `                    "SELECT id, direction, body, status, created_at FROM "`,
        to: `                    "SELECT id, direction, body, status, intent, created_at FROM "`,
      },
      {
        name: "intent summary endpoint",
        from: `@bp.patch("/conversations/<int:conversation_id>")
def update_conversation(conversation_id: int):`,
        to: `@bp.get("/conversations/intents/summary")
def conversation_intent_summary():
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT c.last_intent AS intent, COUNT(*) AS conversations"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " c WHERE c.client_id = %s AND c.last_intent IS NOT NULL"
                    " GROUP BY c.last_intent ORDER BY COUNT(*) DESC",
                    (principal["client_id"],),
                )
                summary = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "intent summary")[0]), 503

    return jsonify({"intents": summary}), 200


@bp.patch("/conversations/<int:conversation_id>")
def update_conversation(conversation_id: int):`,
      },
    ],
  },

  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "summary type gains lastIntent",
        from: `  lastMessagePreview: string | null;
  createdAt: string | null;
  unread: boolean;
}`,
        to: `  lastMessagePreview: string | null;
  createdAt: string | null;
  unread: boolean;
  lastIntent: string | null;
}`,
      },
      {
        name: "normalizer parses lastIntent",
        from: `    unread: p.unread === true,
  };
}`,
        to: `    unread: p.unread === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
  };
}`,
      },
      {
        name: "message type gains intent",
        from: `export interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  createdAt: string | null;
}`,
        to: `export interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}`,
      },
      {
        name: "detail normalizer parses intent",
        from: `      status: typeof m.status === "string" ? m.status : "delivered",
      createdAt: typeof m.created_at === "string" ? m.created_at : null,`,
        to: `      status: typeof m.status === "string" ? m.status : "delivered",
      intent: typeof m.intent === "string" ? m.intent : null,
      createdAt: typeof m.created_at === "string" ? m.created_at : null,`,
      },
      {
        name: "listConversations intent param (signature)",
        from: `  accessToken: string,
  searchQuery?: string,
  statusFilter?: string
): Promise<ConversationSummary[] | null> {`,
        to: `  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string
): Promise<ConversationSummary[] | null> {`,
      },
      {
        name: "listConversations intent param (query)",
        from: `  const parts = [searchPart, statusPart].filter(Boolean);`,
        to: `  const intentPart =
    intentFilter && intentFilter !== "all"
      ? "intent=" + encodeURIComponent(intentFilter)
      : "";
  const parts = [searchPart, statusPart, intentPart].filter(Boolean);`,
      },
      {
        name: "fetchIntentSummary helper",
        from: `export type ConversationStatusResult =`,
        to: `export interface IntentSummaryEntry {
  intent: string;
  conversations: number;
}

export async function fetchIntentSummary(
  accessToken: string
): Promise<IntentSummaryEntry[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/intents/summary"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).intents;
  if (!Array.isArray(rawList)) return null;
  const entries: IntentSummaryEntry[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.intent !== "string") continue;
    entries.push({
      intent: entry.intent,
      conversations:
        typeof entry.conversations === "number" ? entry.conversations : 0,
    });
  }
  return entries;
}

export type ConversationStatusResult =`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/route.ts",
    swaps: [
      {
        name: "forward intent param",
        from: `    const statusFilter =
      statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter
    );`,
        to: `    const statusFilter =
      statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
    const intentParam = url.searchParams.get("intent");
    const intentFilter =
      intentParam && intentParam !== "all"
        ? intentParam.toLowerCase().slice(0, 40)
        : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter
    );`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "summary interface gains lastIntent",
        from: `  lastMessagePreview: string | null;
  unread: boolean;
}`,
        to: `  lastMessagePreview: string | null;
  unread: boolean;
  lastIntent: string | null;
}`,
      },
      {
        name: "intent states",
        from: `  const statusRef = useRef<"all" | "open" | "closed">("all");
  const mounted = useRef(true);`,
        to: `  const statusRef = useRef<"all" | "open" | "closed">("all");
  const [intentFilter, setIntentFilter] = useState("all");
  const intentRef = useRef("all");
  const [intentCounts, setIntentCounts] = useState<
    { intent: string; conversations: number }[]
  >([]);
  const mounted = useRef(true);`,
      },
      {
        name: "refresh sends intent",
        from: `      if (statusRef.current !== "all") listParams.set("status", statusRef.current);`,
        to: `      if (statusRef.current !== "all") listParams.set("status", statusRef.current);
      if (intentRef.current !== "all") listParams.set("intent", intentRef.current);`,
      },
      {
        name: "intent summary loader",
        from: `      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [refresh]);`,
        to: `      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  const loadIntentSummary = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/intents",
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );
      if (response.status !== 200) return;
      const payload = (await response.json().catch(() => null)) as {
        intents?: { intent: string; conversations: number }[];
      } | null;
      if (mounted.current && payload && Array.isArray(payload.intents)) {
        setIntentCounts(payload.intents.slice(0, 6));
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);

  useEffect(() => {
    void loadIntentSummary();
    const summaryTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadIntentSummary();
    }, 30_000);
    return () => window.clearInterval(summaryTimer);
  }, [loadIntentSummary]);`,
      },
      {
        name: "insights chips (click to filter)",
        from: `      <div className="mb-5">
        <input
          type="search"`,
        to: `      {(intentCounts.length > 0 || intentFilter !== "all") && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {intentCounts.map((entry) => (
            <button
              key={entry.intent}
              onClick={() => {
                const next = intentFilter === entry.intent ? "all" : entry.intent;
                intentRef.current = next;
                setIntentFilter(next);
                void refresh();
              }}
              className={\`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors \${
                intentFilter === entry.intent
                  ? "border-cyan-400/40 bg-cyan-400/[0.12] text-cyan-200"
                  : "border-cyan-400/15 bg-cyan-400/[0.04] text-cyan-300/70 hover:bg-cyan-400/[0.09]"
              }\`}
            >
              {entry.intent.replace(/_/g, " ")} · {entry.conversations}
            </button>
          ))}
          {intentFilter !== "all" && (
            <button
              onClick={() => {
                intentRef.current = "all";
                setIntentFilter("all");
                void refresh();
              }}
              className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:text-white"
            >
              Clear ✕
            </button>
          )}
        </div>
      )}

      <div className="mb-5">
        <input
          type="search"`,
      },
      {
        name: "row intent badge",
        from: `                {item.lastMessagePreview && (
                  <p className="mt-3 truncate text-xs text-slate-400">
                    {item.lastMessagePreview}
                  </p>
                )}`,
        to: `                {item.lastMessagePreview && (
                  <p className="mt-3 truncate text-xs text-slate-400">
                    {item.lastMessagePreview}
                  </p>
                )}
                {item.lastIntent && item.lastIntent !== "general" && (
                  <span className="mt-2 inline-block rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-300/70">
                    {item.lastIntent.replace(/_/g, " ")}
                  </span>
                )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "message interface gains intent",
        from: `interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  createdAt: string | null;
}`,
        to: `interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}`,
      },
      {
        name: "bubble meta shows intent",
        from: `                <p className="mt-1 text-[10px] text-slate-500">
                  {message.direction === "out" ? "Bot / you" : "Customer"}
                  {formatTime(message.createdAt) ? \` · \${formatTime(message.createdAt)}\` : ""}
                </p>`,
        to: `                <p className="mt-1 text-[10px] text-slate-500">
                  {message.direction === "out" ? "Bot / you" : "Customer"}
                  {formatTime(message.createdAt) ? \` · \${formatTime(message.createdAt)}\` : ""}
                  {message.direction === "in" &&
                  message.intent &&
                  message.intent !== "general"
                    ? \` · \${message.intent.replace(/_/g, " ")}\`
                    : ""}
                </p>`,
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

  const backup = target.file + ".pre_intent.bak";
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
if (fs.existsSync(CLASSIFIER_PATH)) {
  console.log("= " + CLASSIFIER_PATH + " (already present)");
} else {
  writeFileEnsuringDir(CLASSIFIER_PATH, CLASSIFIER_FILE);
  appliedTotal++;
  console.log("+ " + CLASSIFIER_PATH);
}
if (fs.existsSync(MIGRATION_PATH)) {
  console.log("= " + MIGRATION_PATH + " (already present)");
} else {
  writeFileEnsuringDir(MIGRATION_PATH, MIGRATION_FILE);
  appliedTotal++;
  console.log("+ " + MIGRATION_PATH);
}
if (fs.existsSync(BFF_INTENTS_PATH)) {
  console.log("= " + BFF_INTENTS_PATH + " (already present)");
} else {
  writeFileEnsuringDir(BFF_INTENTS_PATH, BFF_INTENTS_FILE);
  appliedTotal++;
  console.log("+ " + BFF_INTENTS_PATH);
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
