// add_conversations_search.mjs — Conversations: search + unread badges.
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_conversations_search.mjs
// CRLF-tolerant, idempotent, backups: *.pre_conv.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MIGRATION = `-- 009: conversations read tracking (unread badges)
-- Applied automatically by portal_db.ensure_tables(); kept here as the
-- canonical migration record (001-009).
ALTER TABLE portal_conversations
    ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "docstring: q + unread",
        from: `GET /api/v1/portal/conversations            ?status=all|open|closed&limit=50
    -> {conversations: [{id, channel, contact_id, contact_name, status,
                         last_message_at, last_message_preview, created_at}]}
       newest conversation first.`,
        to: `GET /api/v1/portal/conversations            ?status=all|open|closed&limit=50&q=search
    -> {conversations: [{id, channel, contact_id, contact_name, status,
                         last_message_at, last_message_preview, created_at,
                         unread}]}
       newest conversation first. \`q\` searches contact name, contact id and
       message bodies (case-insensitive). Opening a conversation marks it read.`,
      },
      {
        name: "public payload gains unread",
        from: `        "last_message_preview": row.get("last_message_preview"),
        "created_at": _iso(row.get("created_at")),
    }`,
        to: `        "last_message_preview": row.get("last_message_preview"),
        "created_at": _iso(row.get("created_at")),
        "unread": bool(row.get("unread")),
    }`,
      },
      {
        name: "list SQL: q search + unread flag",
        from: `    sql = (
        "SELECT id, channel, contact_id, contact_name, status,"
        " last_message_at, last_message_preview, created_at FROM "
        + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s"
    )
    params = [principal["client_id"]]
    if status != "all":
        sql += " AND status = %s"
        params.append(status)
    sql += " ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT %s"
    params.append(limit)`,
        to: `    search = (request.args.get("q") or "").strip()
    if len(search) > 100:
        search = search[:100]

    sql = (
        "SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,"
        " c.last_message_at, c.last_message_preview, c.created_at,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m WHERE m.conversation_id = c.id AND m.direction = 'in'"
        " AND m.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))"
        " ) AS unread FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)
    if search:
        like = "%" + search.replace("\\\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_") + "%"
        sql += (
            " AND (c.contact_name ILIKE %s OR c.contact_id ILIKE %s"
            " OR EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " sm WHERE sm.conversation_id = c.id AND sm.body ILIKE %s))"
        )
        params.extend([like, like, like])
    sql += " ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(limit)`,
      },
      {
        name: "detail marks conversation read",
        from: `                msgs = portal_db.rows(cur)
        finally:
            conn.close()`,
        to: `                msgs = portal_db.rows(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
            conn.commit()
        finally:
            conn.close()`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "lazy last_read_at column",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_messages_conv
  ON portal_messages (conversation_id, id);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_messages_conv
  ON portal_messages (conversation_id, id);
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
"""`,
      },
    ],
  },

  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "summary type gains unread",
        from: `  lastMessagePreview: string | null;
  createdAt: string | null;
}`,
        to: `  lastMessagePreview: string | null;
  createdAt: string | null;
  unread: boolean;
}`,
      },
      {
        name: "normalizer parses unread",
        from: `    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}`,
        to: `    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    unread: p.unread === true,
  };
}`,
      },
      {
        name: "listConversations search param",
        from: `export async function listConversations(
  accessToken: string
): Promise<ConversationSummary[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations");`,
        to: `export async function listConversations(
  accessToken: string,
  searchQuery?: string
): Promise<ConversationSummary[] | null> {
  const query =
    searchQuery && searchQuery.trim()
      ? "?q=" + encodeURIComponent(searchQuery.trim().slice(0, 100))
      : "";
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations" + query
    );`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/route.ts",
    swaps: [
      {
        name: "GET accepts request",
        from: `export async function GET() {`,
        to: `export async function GET(request: Request) {`,
      },
      {
        name: "forward q to control plane",
        from: `    const conversations = await listConversations(accessToken);`,
        to: `    const searchQuery =
      new URL(request.url).searchParams.get("q")?.slice(0, 100) || undefined;
    const conversations = await listConversations(accessToken, searchQuery);`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "summary interface gains unread",
        from: `  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}`,
        to: `  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: boolean;
}`,
      },
      {
        name: "search state",
        from: `  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);`,
        to: `  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const mounted = useRef(true);`,
      },
      {
        name: "refresh sends q",
        from: `      const response = await fetch("/api/omniflow/portal/conversations", {
        credentials: "same-origin",
        cache: "no-store",
      });`,
        to: `      const query = searchRef.current;
      const response = await fetch(
        "/api/omniflow/portal/conversations" +
          (query ? "?q=" + encodeURIComponent(query) : ""),
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );`,
      },
      {
        name: "debounced search handler",
        from: `  }, [refresh]);

  if (expired) {`,
        to: `  }, [refresh]);

  function onSearchChange(value: string) {
    setSearch(value);
    searchRef.current = value;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void refresh();
    }, 350);
  }

  if (expired) {`,
      },
      {
        name: "cleanup debounce timer",
        from: `    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };`,
        to: `    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };`,
      },
      {
        name: "search input UI",
        from: `          Refresh
        </button>
      </div>

      {!items ? (`,
        to: `          Refresh
        </button>
      </div>

      <div className="mb-5">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by contact name, number, or message text"
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      {!items ? (`,
      },
      {
        name: "no-match empty state",
        from: `            {pending
              ? "The conversations module is rolling out on the server."
              : "No conversations yet."}
          </p>`,
        to: `            {pending
              ? "The conversations module is rolling out on the server."
              : search
                ? "No conversations match your search."
                : "No conversations yet."}
          </p>`,
      },
      {
        name: "unread dot on rows",
        from: `                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {item.contactName || item.contactId || "Unknown contact"}
                      </p>`,
        to: `                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-medium text-white">
                        <span className="truncate">
                          {item.contactName || item.contactId || "Unknown contact"}
                        </span>
                        {item.unread && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]"
                            title="Unread messages"
                          />
                        )}
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

    if (fromCount === 1) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (fromCount === 0 && toCount > 0) {
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

  const backup = target.file + ".pre_conv.bak";
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

// Migration file (canonical record; the backend also self-migrates).
const MIGRATION_PATH = "OmniFlow-Control-Plane/migrations/009_conversations_read.sql";
if (!fs.existsSync("OmniFlow-Control-Plane")) {
  console.log("SKIP migration (backend repo folder not found)");
} else if (!fs.existsSync(MIGRATION_PATH)) {
  fs.mkdirSync("OmniFlow-Control-Plane/migrations", { recursive: true });
  fs.writeFileSync(MIGRATION_PATH, MIGRATION.replace(/\n/g, "\n"), "utf8");
  console.log("+ " + MIGRATION_PATH);
} else {
  console.log("= " + MIGRATION_PATH + " (already present)");
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