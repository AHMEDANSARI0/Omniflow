import Link from "next/link";

import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { getOverview, getRecentActivity } from "../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";


interface QuickLink {
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
}

export default async function ClientDashboardPage() {
  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const [activity, overview] = await Promise.all([
    accessToken ? getRecentActivity(accessToken) : Promise.resolve(null),
    accessToken ? getOverview(accessToken) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
          Workspace {principal.clientId}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Welcome{principal.displayName ? `, ${principal.displayName}` : ""}
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Your tenant-isolated OmniFlow workspace is authenticated and ready.
        </p>
      </div>

      {overview && (
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
      )}

      {activity && activity.length > 0 && (
        <div className="mb-8 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
          <h2 className="text-sm font-semibold text-white">Recent activity</h2>
          <p className="mt-1 text-xs text-slate-500">
            Live audit trail of what your assistant and team did across
            conversations.
          </p>
          <ul className="mt-4 space-y-2.5">
            {activity.slice(0, 6).map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-4 text-xs"
              >
                <span className="min-w-0 truncate text-slate-300">
                  {item.label}
                  {item.note ? (
                    <span className="text-slate-600"> — {item.note}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-slate-600">{item.timeAgo}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
      </div>
    </div>
  );
}
