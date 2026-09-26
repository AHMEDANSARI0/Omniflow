// add_overview_command_center.mjs — Phase 19: Overview "Today" Command Center.
//
// Zero AI, zero schema changes, no bridge changes -> NO bot restart. The
// dashboard homepage was still a static welcome screen (Session / Role /
// Architecture chips + marketing cards). This turns it into the live first
// screen the merchant sees after login:
//
//   - Stat strip (last 24 hours + live snapshot): new chats, inbound
//     messages, team replies (queued send_message commands), open now with
//     unassigned count as the sub-label.
//   - "Needs attention" banner when open chats have no assignee (links to
//     the inbox).
//   - Hot leads card: top 5 open conversations flagged hot, each linking to
//     the inbox pre-filtered to that contact (proven ?q= pattern).
//   - Recent activity (kept as-is).
//   - Quick-links grid replacing the static marketing cards.
//
// CP: GET /portal/overview appended to portal_growth.py (same auth/503
// pattern; 2 deterministic queries — scalar-subquery counters + hot leads;
// NO DDL). portal.ts: OverviewData + normalizeOverviewHotLead +
// getOverview (inserted before the Growth banner). BFF passthrough:
// app/api/omniflow/portal/overview/route.ts (depth 5 imports).
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_overview_command_center.mjs
//
// Requires Phase 18 (add_team_performance.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_ovw.bak
// Expected first run: 8 applied, 0 warnings (7 swaps + 1 new file).
// Expected rerun:     0 applied, 8 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_OVERVIEW_PATH = "Omniflow/app/api/omniflow/portal/overview/route.ts";

const CP_GROWTH_PATH = "OmniFlow-Control-Plane/portal_growth.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_growth.py (append at tail)
// --------------------------------------------------------------------------

const CP_TAIL_FROM = `        portal_db.log_action(
            cur,
            client_id,
            "csat.received",
            "customer",
            None,
            conversation_id,
            "CSAT score " + str(score) + "/5.",
        )`;

const CP_OVERVIEW_ROUTE = `        portal_db.log_action(
            cur,
            client_id,
            "csat.received",
            "customer",
            None,
            conversation_id,
            "CSAT score " + str(score) + "/5.",
        )


@bp.get("/portal/overview")
def portal_overview():
    """Live command-center numbers for the portal homepage.

    Deterministic only: 24-hour counters (new chats, inbound messages, team
    replies queued through the command queue), the live open/unassigned
    snapshot, and the top hot leads. No AI cost, no bridge involvement.
    """
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at >= NOW() - INTERVAL '24 hours') AS new_chats,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s AND direction = 'in'"
                    " AND created_at >= NOW() - INTERVAL '24 hours')"
                    " AS inbound_messages,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CMD_TABLE) +
                    " WHERE client_id = %s AND action = 'send_message'"
                    " AND created_at >= NOW() - INTERVAL '24 hours')"
                    " AS team_replies,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open') AS open_now,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open'"
                    " AND assigned_to IS NULL) AS unassigned_open",
                    (client_id, client_id, client_id, client_id, client_id),
                )
                stat_rows = portal_db.rows(cur)
                stats = stat_rows[0] if stat_rows else {}
                cur.execute(
                    "SELECT id, contact_id, contact_name, lead_score,"
                    " last_message_preview, last_message_at"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open' AND hot = TRUE"
                    " ORDER BY lead_score DESC NULLS LAST,"
                    " last_message_at DESC NULLS LAST LIMIT 5",
                    (client_id,),
                )
                lead_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal overview")[0]), 503
    hot_leads = []
    for row in lead_rows:
        preview = row.get("last_message_preview")
        hot_leads.append({
            "id": row.get("id"),
            "contact_id": row.get("contact_id"),
            "contact_name": row.get("contact_name"),
            "lead_score": row.get("lead_score"),
            "preview": preview[:120] if isinstance(preview, str) else None,
            "last_message_at": _iso(row.get("last_message_at")),
        })
    return jsonify({
        "ok": True,
        "stats": {
            "new_chats": int(stats.get("new_chats") or 0),
            "inbound_messages": int(stats.get("inbound_messages") or 0),
            "team_replies": int(stats.get("team_replies") or 0),
            "open_now": int(stats.get("open_now") or 0),
            "unassigned_open": int(stats.get("unassigned_open") or 0),
        },
        "hot_leads": hot_leads,
    }), 200`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts (inserted before the Growth banner)
// --------------------------------------------------------------------------

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_OVERVIEW_BLOCK = `// ---------------------------------------------------------------------------
// Overview: live command center (deterministic, 24h window)
// ---------------------------------------------------------------------------

export interface OverviewHotLead {
  id: number;
  contactId: string;
  contactName: string;
  leadScore: number | null;
  preview: string | null;
  lastMessageAt: string | null;
}

export interface OverviewData {
  newChats: number;
  inboundMessages: number;
  teamReplies: number;
  openNow: number;
  unassignedOpen: number;
  hotLeads: OverviewHotLead[];
}

function normalizeOverviewHotLead(value: unknown): OverviewHotLead | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const contactId = typeof p.contact_id === "string" ? p.contact_id : "";
  if (id === null || !contactId) return null;
  return {
    id,
    contactId,
    contactName: typeof p.contact_name === "string" ? p.contact_name : "",
    leadScore: typeof p.lead_score === "number" ? p.lead_score : null,
    preview: typeof p.preview === "string" ? p.preview : null,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
  };
}

export async function getOverview(
  accessToken: string
): Promise<OverviewData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/overview");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const stats =
    p.stats !== null && typeof p.stats === "object"
      ? (p.stats as Record<string, unknown>)
      : {};
  const rawLeads = p.hot_leads;
  const hotLeads: OverviewHotLead[] = [];
  if (Array.isArray(rawLeads)) {
    for (const raw of rawLeads) {
      const lead = normalizeOverviewHotLead(raw);
      if (lead) hotLeads.push(lead);
    }
  }
  return {
    newChats: typeof stats.new_chats === "number" ? stats.new_chats : 0,
    inboundMessages:
      typeof stats.inbound_messages === "number" ? stats.inbound_messages : 0,
    teamReplies: typeof stats.team_replies === "number" ? stats.team_replies : 0,
    openNow: typeof stats.open_now === "number" ? stats.open_now : 0,
    unassignedOpen:
      typeof stats.unassigned_open === "number" ? stats.unassigned_open : 0,
    hotLeads,
  };
}

` + LIB_GROWTH_BANNER;

// --------------------------------------------------------------------------
// Website: BFF passthrough (new file)
// --------------------------------------------------------------------------

const BFF_OVERVIEW_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getOverview,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getOverview(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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

// --------------------------------------------------------------------------
// Website: Overview page (5 swaps)
// --------------------------------------------------------------------------

const PAGE_IMPORTS_FROM = `import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { getRecentActivity } from "../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";`;

const PAGE_IMPORTS_TO = `import Link from "next/link";

import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { getOverview, getRecentActivity } from "../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";`;

const PAGE_MODULECARDS_FROM = `interface ModuleCard {
  icon: string;
  title: string;
  description: string;
  status: "active" | "next" | "soon";
}

const modules: ModuleCard[] = [
  {
    icon: "◉",
    title: "Managed WhatsApp",
    description:
      "Authorize once from mobile, then OmniFlow-managed infrastructure keeps the session available.",
    status: "active",
  },
  {
    icon: "✦",
    title: "AI agents",
    description:
      "Tone, greetings, fallbacks, working hours and handoff policies — live from the Control Plane.",
    status: "active",
  },
  {
    icon: "◎",
    title: "Conversations",
    description:
      "Tenant-isolated customer conversations, AI outcomes and human handoffs across channels.",
    status: "active",
  },
  {
    icon: "◇",
    title: "Business profile",
    description:
      "Products, services, prices, policies, FAQs, operating hours and language preferences.",
    status: "active",
  },
];

const statusStyle = {
  active: "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300",
  next: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
  soon: "border-white/[0.06] bg-white/[0.02] text-slate-500",
};`;

const PAGE_MODULECARDS_TO = `interface QuickLink {
  icon: string;
  title: string;
  href: string;
}

const QUICK_LINKS: QuickLink[] = [
  { icon: "◎", title: "Conversations", href: "/dashboard/conversations" },
  { icon: "☻", title: "Customers", href: "/dashboard/customers" },
  { icon: "⚡", title: "Automations", href: "/dashboard/automations" },
  { icon: "➤", title: "Broadcasts", href: "/dashboard/broadcasts" },
  { icon: "◢", title: "Analytics", href: "/dashboard/analytics" },
  { icon: "⚑", title: "Team", href: "/dashboard/team" },
  { icon: "▣", title: "Knowledge base", href: "/dashboard/knowledge-base" },
  { icon: "◇", title: "Business profile", href: "/dashboard/profile" },
];

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-4 py-3.5">
      <p className="text-[10px] uppercase tracking-wider text-slate-600">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}`;

const PAGE_FETCH_FROM = `  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const activity = accessToken ? await getRecentActivity(accessToken) : null;

  return (`;

const PAGE_FETCH_TO = `  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const [activity, overview] = await Promise.all([
    accessToken ? getRecentActivity(accessToken) : Promise.resolve(null),
    accessToken ? getOverview(accessToken) : Promise.resolve(null),
  ]);

  return (`;

const PAGE_STRIP_FROM = `      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.035] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-emerald-300/70">Session</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-medium text-white">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> Secure
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Role</p>
          <p className="mt-1 text-sm font-medium capitalize text-white">{principal.role}</p>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Architecture</p>
          <p className="mt-1 text-sm font-medium text-white">Managed connector</p>
        </div>
      </div>

      <div className="mb-8 flex items-start gap-3 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.025] px-5 py-4">
        <span className="relative mt-1 flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
        </span>
        <div>
          <p className="text-sm text-slate-300">Secure portal authentication is active.</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            All portal modules are live on the versioned Control Plane API. Link your WhatsApp connector and every message, AI reply and conversation lands here automatically.
          </p>
        </div>
      </div>`;

const PAGE_STRIP_TO = `      {overview && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="New chats · 24h" value={overview.newChats} />
            <StatTile label="Inbound · 24h" value={overview.inboundMessages} />
            <StatTile label="Team replies · 24h" value={overview.teamReplies} />
            <StatTile
              label="Open now"
              value={overview.openNow}
              sub={
                overview.unassignedOpen > 0
                  ? overview.unassignedOpen + " unassigned"
                  : "all assigned"
              }
            />
          </div>
          {overview.unassignedOpen > 0 && (
            <Link
              href="/dashboard/conversations"
              className="mb-8 flex items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] px-5 py-4 transition-colors duration-300 hover:bg-amber-400/[0.09]"
            >
              <span className="text-sm text-amber-200">
                {overview.unassignedOpen} open{" "}
                {overview.unassignedOpen === 1 ? "chat has" : "chats have"} no
                assignee — pick it up before it waits any longer.
              </span>
              <span className="shrink-0 text-xs font-medium text-amber-300">
                Open inbox →
              </span>
            </Link>
          )}
          {overview.hotLeads.length > 0 && (
            <div className="mb-8 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
              <h2 className="text-sm font-semibold text-white">Hot leads</h2>
              <p className="mt-1 text-xs text-slate-500">
                Open chats flagged hot — reply before they cool down.
              </p>
              <ul className="mt-4 space-y-2">
                {overview.hotLeads.map((lead) => (
                  <li key={"hot-lead-" + String(lead.id)}>
                    <Link
                      href={
                        "/dashboard/conversations?q=" +
                        encodeURIComponent(lead.contactId)
                      }
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.01] px-3.5 py-2.5 transition-colors duration-300 hover:border-amber-400/25"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-400/25 bg-amber-400/[0.08] text-sm">
                          🔥
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-white">
                            {lead.contactName || lead.contactId}
                          </span>
                          {lead.preview && (
                            <span className="block truncate text-[10px] text-slate-500">
                              {lead.preview}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                          {lead.leadScore !== null
                            ? "score " + lead.leadScore
                            : "hot"}
                        </span>
                        <span className="block text-[10px] text-slate-600">
                          {whenLabel(lead.lastMessageAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}`;

const PAGE_GRID_FROM = `      <div className="grid gap-4 sm:grid-cols-2">
        {modules.map((module) => (
          <div
            key={module.title}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
                {module.icon}
              </div>
              <span className={\`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider \${statusStyle[module.status]}\`}>
                {module.status === "active" ? "Active" : module.status === "next" ? "Next" : "Coming soon"}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-white">{module.title}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              {module.description}
            </p>
          </div>
        ))}
      </div>`;

const PAGE_GRID_TO = `      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.title}
            href={link.href}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/25 hover:bg-cyan-400/[0.04]"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
              {link.icon}
            </div>
            <p className="mt-3 text-xs font-medium text-white">{link.title}</p>
          </Link>
        ))}
      </div>`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_GROWTH_PATH,
    swaps: [
      { name: "cp-overview-route", from: CP_TAIL_FROM, to: CP_OVERVIEW_ROUTE },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-overview-block", from: LIB_GROWTH_BANNER, to: LIB_OVERVIEW_BLOCK },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-imports", from: PAGE_IMPORTS_FROM, to: PAGE_IMPORTS_TO },
      { name: "page-quicklinks-helpers", from: PAGE_MODULECARDS_FROM, to: PAGE_MODULECARDS_TO },
      { name: "page-parallel-fetch", from: PAGE_FETCH_FROM, to: PAGE_FETCH_TO },
      { name: "page-live-strip", from: PAGE_STRIP_FROM, to: PAGE_STRIP_TO },
      { name: "page-links-grid", from: PAGE_GRID_FROM, to: PAGE_GRID_TO },
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

  const backup = target.file + ".pre_ovw.bak";
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
const NEW_FILES = [[BFF_OVERVIEW_PATH, BFF_OVERVIEW_FILE]];
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