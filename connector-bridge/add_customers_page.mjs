// add_customers_page.mjs — Phase 16: Customers (Contact 360) v0.
//
// Fills the last big CRM gap (zero AI, no bridge changes -> NO bot restart):
// until now the portal only saw conversations. This adds a Customers page —
// every contact aggregated across their chats:
//   name, channels (whatsapp/website), chat + open counts, hottest lead
//   temperature, last message preview, and every label ever attached to
//   their conversations. Tap a customer to open their chats (pre-filtered
//   inbox search), so the merchant sees the full relationship at a glance.
//
// CP: GET /portal/customers (GROUP BY contact_id, HAVING search, channel
// filter, limit 100, tags merged via a contact-keyed join). BFF passthrough.
// UI: new /dashboard/customers page + sidebar entry.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_customers_page.mjs
//
// Requires Phase 15 (add_inbox_power_tools.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_cust.bak
// Expected first run: 5 applied, 0 warnings (3 swaps + 2 new files).
// Expected rerun:     0 applied, 3 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_CUSTOMERS_PATH = "Omniflow/app/api/omniflow/portal/customers/route.ts";
const CUSTOMERS_PAGE_PATH = "Omniflow/app/dashboard/(portal)/customers/page.tsx";

const BFF_CUSTOMERS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listCustomers,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;
  const channelParam = url.searchParams.get("channel");
  const channelFilter =
    channelParam === "whatsapp" || channelParam === "website"
      ? channelParam
      : undefined;

  try {
    const data = await listCustomers(accessToken, searchQuery, channelFilter);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ customers: data }, 200);
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

const CUSTOMERS_PAGE_FILE = `"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

const POLL_MS = 30_000;

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<
    "all" | "whatsapp" | "website"
  >("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchRef.current) params.set("q", searchRef.current);
      if (channelRef.current !== "all") {
        params.set("channel", channelRef.current);
      }
      const qs = params.toString();
      const response = await fetch(
        "/api/omniflow/portal/customers" + (qs ? "?" + qs : ""),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        customers?: CustomerSummary[];
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.customers)) {
        setCustomers(payload.customers);
        setPending(false);
      } else if (payload.error?.code === "portal_pending") {
        setPending(true);
        setCustomers([]);
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }

  if (expired) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-sm text-slate-300">Session expired.</p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-white">Customers</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Every contact across WhatsApp and the website — search, filter, and
        jump straight into their chats.
      </p>

      <div className="mt-4">
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by name or contact…"
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      <div className="mb-4 mt-3 flex flex-wrap items-center gap-2">
        {(["all", "whatsapp", "website"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              channelRef.current = value;
              setChannelFilter(value);
              void refresh();
            }}
            className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
              channelFilter === value
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }\`}
          >
            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>

      {!customers ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">
            {pending
              ? "Connecting to the inbox — customers appear in a minute."
              : search
                ? "No customers match that search."
                : "No customers yet — they appear with the first message."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {customers.map((customer) => (
            <li key={customer.contactId}>
              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="block rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-white/[0.12] hover:bg-white/[0.03]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] text-sm font-semibold text-cyan-200">
                      {(customer.name || customer.contactId || "?")
                        .trim()
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {customer.name || customer.contactId}
                      </p>
                      {customer.name && (
                        <p className="truncate text-[11px] text-slate-500">
                          {customer.contactId}
                        </p>
                      )}
                      {customer.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {customer.tags.slice(0, 3).map((tag) => (
                            <span
                              key={"cust-tag-" + tag}
                              className="inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
                              style={{
                                borderColor:
                                  \`hsl(\${tagHue(tag)} 70% 50% / 0.3)\`,
                                backgroundColor:
                                  \`hsl(\${tagHue(tag)} 70% 50% / 0.10)\`,
                                color: \`hsl(\${tagHue(tag)} 80% 72%)\`,
                              }}
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 sm:text-right">
                    <p className="text-[11px] text-slate-400">
                      {customer.conversationCount}{" "}
                      {customer.conversationCount === 1 ? "chat" : "chats"}
                      {customer.openCount > 0 &&
                        " · " + customer.openCount + " open"}
                      {" · "}
                      {customer.channels.join(", ")}
                    </p>
                    {customer.lastMessagePreview && (
                      <p className="mt-0.5 max-w-xs truncate text-xs text-slate-300 sm:ml-auto">
                        {customer.lastMessagePreview}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-slate-600">
                      {formatWhen(customer.lastMessageAt)}
                    </p>
                  </div>
                </div>
                {customer.leadTemp !== "cold" && (
                  <div className="mt-2 flex">
                    <span
                      className={
                        "inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                        (customer.leadTemp === "hot"
                          ? "border-orange-400/25 bg-orange-400/[0.08] text-orange-300"
                          : "border-amber-400/20 bg-amber-400/[0.05] text-amber-200/80")
                      }
                    >
                      {customer.leadTemp} lead
                    </span>
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`;

const CP_CUSTOMERS_APPEND = `


# ---------------------------------------------------------------------------
# Customers (contacts aggregated across all their conversations)
# ---------------------------------------------------------------------------

CUSTOMERS_LIMIT = 100
WARM_LEAD_SCORE = 35


@bp.get("/customers")
def list_customers():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    search = (request.args.get("q") or "").strip()[:100]
    channel_filter = (request.args.get("channel") or "").strip().lower()

    sql = (
        "SELECT c.contact_id,"
        " COALESCE(MAX(c.contact_name), '') AS contact_name,"
        " COUNT(*) AS conversation_count,"
        " COUNT(*) FILTER (WHERE c.status = 'open') AS open_count,"
        " MAX(c.last_message_at) AS last_message_at,"
        " MAX(c.last_message_preview) AS last_message_preview,"
        " STRING_AGG(DISTINCT c.channel, ',') AS channels,"
        " BOOL_OR(c.lead_temp = 'hot') AS has_hot,"
        " MAX(c.lead_score) AS max_lead_score"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    if search:
        like = "%" + search.replace("\\\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_") + "%"
        sql += (
            " GROUP BY c.contact_id"
            " HAVING (COALESCE(MAX(c.contact_name), '') ILIKE %s"
            " OR c.contact_id ILIKE %s)"
        )
        params.extend([like, like])
    else:
        sql += " GROUP BY c.contact_id"
    sql += (
        " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
        " LIMIT %s"
    )
    params.append(CUSTOMERS_LIMIT)

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                contact_ids = [row.get("contact_id") for row in found]
                tags_map = {}
                if contact_ids:
                    cur.execute(
                        "SELECT conv.contact_id, ct.tag FROM "
                        + portal_db._q(portal_db.CONV_TAGS_TABLE) + " ct"
                        " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " conv"
                        " ON conv.id = ct.conversation_id"
                        " WHERE ct.client_id = %s AND conv.client_id = %s"
                        " AND conv.contact_id = ANY(%s) ORDER BY ct.id",
                        (principal["client_id"], principal["client_id"],
                         contact_ids),
                    )
                    for row in portal_db.rows(cur):
                        key = row.get("contact_id")
                        tag = str(row.get("tag") or "")
                        if key is None or not tag:
                            continue
                        bucket = tags_map.setdefault(key, [])
                        if tag not in bucket:
                            bucket.append(tag)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customers read")[0]), 503

    customers = []
    for row in found:
        max_score = int(row.get("max_lead_score") or 0)
        if row.get("has_hot"):
            lead_temp = "hot"
        elif max_score >= WARM_LEAD_SCORE:
            lead_temp = "warm"
        else:
            lead_temp = "cold"
        customers.append({
            "contact_id": row.get("contact_id"),
            "name": str(row.get("contact_name") or ""),
            "channels": [
                part for part in str(row.get("channels") or "").split(",") if part
            ],
            "conversation_count": int(row.get("conversation_count") or 0),
            "open_count": int(row.get("open_count") or 0),
            "last_message_at": _iso(row.get("last_message_at")),
            "last_message_preview": row.get("last_message_preview"),
            "lead_temp": lead_temp,
            "tags": tags_map.get(row.get("contact_id"), []),
        })
    return jsonify({"customers": customers}), 200
`;

const PORTAL_TS_CUSTOMERS_SECTION = `// ---------------------------------------------------------------------------
// Customers (contacts aggregated across conversations)
// ---------------------------------------------------------------------------

export interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

function normalizeCustomer(value: unknown): CustomerSummary | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const contactId =
    typeof p.contact_id === "string" ? p.contact_id : "";
  if (!contactId) return null;
  return {
    contactId,
    name: typeof p.name === "string" ? p.name : "",
    channels: Array.isArray(p.channels)
      ? p.channels.filter((c): c is string => typeof c === "string")
      : [],
    conversationCount:
      typeof p.conversation_count === "number" ? p.conversation_count : 0,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
    lastMessagePreview:
      typeof p.last_message_preview === "string"
        ? p.last_message_preview
        : null,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

export async function listCustomers(
  accessToken: string,
  searchQuery?: string,
  channelFilter?: string
): Promise<CustomerSummary[] | null> {
  const parts: string[] = [];
  if (searchQuery) parts.push("q=" + encodeURIComponent(searchQuery));
  if (channelFilter && channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(channelFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers" + query
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
  const rows = (payload as Record<string, unknown>).customers;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeCustomer(row))
    .filter((row): row is CustomerSummary => row !== null);
}

export type ConversationStatusResult =`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "customers endpoint appended",
        from: `    rows = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        rows.append(item)
    return jsonify({"conversations": rows, "count": len(rows)}), 200`,
        to: `    rows = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        rows.append(item)
    return jsonify({"conversations": rows, "count": len(rows)}), 200
` + CP_CUSTOMERS_APPEND,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "customers client function",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_CUSTOMERS_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "sidebar customers entry",
        from: `  {
    label: "Conversations",
    href: "/dashboard/conversations",
    icon: "◎",
    enabled: true,
  },`,
        to: `  {
    label: "Conversations",
    href: "/dashboard/conversations",
    icon: "◎",
    enabled: true,
  },
  {
    label: "Customers",
    href: "/dashboard/customers",
    icon: "☻",
    enabled: true,
  },`,
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

  const backup = target.file + ".pre_cust.bak";
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
const NEW_FILES = [
  [BFF_CUSTOMERS_PATH, BFF_CUSTOMERS_FILE],
  [CUSTOMERS_PAGE_PATH, CUSTOMERS_PAGE_FILE],
];
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
