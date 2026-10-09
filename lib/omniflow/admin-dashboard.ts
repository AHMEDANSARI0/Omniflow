/**
 * Admin dashboard maths (§259).
 *
 * Pure functions. The dashboard page fetches the sources (Supabase leads,
 * Control Plane overview, providers and client users) and these turn the raw
 * counts into cards and lists. No I/O and no business thresholds: a workspace
 * is listed when one signal is above zero, and ranks by how many kinds of
 * signal it carries. Metadata only: nothing here reads message text.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type ProblemSignal =
  | "failed_calls"
  | "open_escalations"
  | "pending_approvals"
  | "blocked_attempts";

export interface DashboardWorkspace {
  client_id: number;
  name: string;
  email: string;
  failed: number;
  open_escalations: number;
  pending_approvals: number;
  blocked?: number;
}

export interface ProblemSignalCount {
  kind: ProblemSignal;
  count: number;
}

export interface ProblemRow {
  client_id: number;
  name: string;
  signals: ProblemSignalCount[];
  total: number;
}

export interface DashboardLead {
  status: string;
  created_at: string;
}

export interface LeadStats {
  total: number;
  recent: number;
  byStatus: { new: number; contacted: number; closed: number; other: number };
}

export interface AiRates {
  automationRate: number | null;
  failureRate: number | null;
}

const SIGNAL_ORDER: ProblemSignal[] = [
  "failed_calls",
  "open_escalations",
  "pending_approvals",
  "blocked_attempts",
];

const PROVIDER_LABELS: Record<string, string> = {
  llm: "Chat model (LLM)",
  ai: "AI engine",
  router: "Model router",
  assistant: "AI assistant",
  embeddings: "Embeddings (search)",
  vision: "Vision (images)",
  stt: "Speech to text",
  voice: "Voice calls",
  video: "Video",
  email: "Email sending",
  payments: "Payments",
  whatsapp_e2e: "WhatsApp end-to-end",
};

function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Business name, else owner email, else the workspace id. */
export function workspaceName(ws: {
  client_id: number;
  name?: string;
  email?: string;
}): string {
  return ws.name || ws.email || "Workspace #" + ws.client_id;
}

/** Workspaces with at least one open signal: most kinds of problem first, then most events. */
export function problemRows(workspaces: DashboardWorkspace[]): ProblemRow[] {
  const rows: ProblemRow[] = [];
  for (const ws of workspaces) {
    const found: Record<ProblemSignal, number> = {
      failed_calls: countOf(ws.failed),
      open_escalations: countOf(ws.open_escalations),
      pending_approvals: countOf(ws.pending_approvals),
      blocked_attempts: countOf(ws.blocked),
    };
    const signals = SIGNAL_ORDER.filter((kind) => found[kind] > 0).map(
      (kind) => ({ kind, count: found[kind] })
    );
    if (signals.length === 0) continue;
    rows.push({
      client_id: ws.client_id,
      name: workspaceName(ws),
      signals,
      total: signals.reduce((sum, signal) => sum + signal.count, 0),
    });
  }
  return rows.sort(
    (a, b) =>
      b.signals.length - a.signals.length ||
      b.total - a.total ||
      a.name.localeCompare(b.name)
  );
}

export function signalLabel(signal: ProblemSignalCount): string {
  const n = signal.count;
  const s = n === 1 ? "" : "s";
  switch (signal.kind) {
    case "failed_calls":
      return n + " AI call" + s + " failed";
    case "open_escalations":
      return n + " open escalation" + s;
    case "pending_approvals":
      return n + " approval" + s + " waiting";
    case "blocked_attempts":
      return n + " blocked attempt" + s;
  }
}

/** Lead totals: all leads, leads created inside the window, and counts per status. */
export function leadStats(
  leads: DashboardLead[],
  nowMs: number,
  windowDays: number
): LeadStats {
  const since = nowMs - windowDays * DAY_MS;
  const stats: LeadStats = {
    total: leads.length,
    recent: 0,
    byStatus: { new: 0, contacted: 0, closed: 0, other: 0 },
  };
  for (const lead of leads) {
    const created = Date.parse(lead.created_at);
    if (Number.isFinite(created) && created >= since) stats.recent += 1;
    if (
      lead.status === "new" ||
      lead.status === "contacted" ||
      lead.status === "closed"
    ) {
      stats.byStatus[lead.status] += 1;
    } else {
      stats.byStatus.other += 1;
    }
  }
  return stats;
}

/** Share of replies the AI answered itself, and share of AI calls that failed. Null means no data. */
export function aiRates(input: {
  calls: number;
  failed: number;
  answers: number;
  handoffs: number;
}): AiRates {
  const replies = input.answers + input.handoffs;
  return {
    automationRate: replies > 0 ? input.answers / replies : null,
    failureRate: input.calls > 0 ? input.failed / input.calls : null,
  };
}

export function percent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : Math.round(value * 100) + "%";
}

export function usd(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "not priced"
    : "$" + value.toFixed(2);
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". A missing or bad date gives a dash. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const minutes = Math.floor(Math.max(0, nowMs - then) / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " h ago";
  return Math.floor(hours / 24) + " d ago";
}

/** "ai_quality.check" becomes "Ai quality check". Display only. */
export function humanize(value: string): string {
  const spaced = value.replace(/[._-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function providerLabel(group: string): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, group)
    ? PROVIDER_LABELS[group]
    : humanize(group);
}

/** Configured flag per provider group, sorted. `flags` holds on/off switches, not keys, so it is left out. */
export function providerRows(
  groups: Record<string, { configured?: boolean }> | null | undefined
): { group: string; configured: boolean }[] {
  if (!groups) return [];
  return Object.keys(groups)
    .filter((group) => group !== "flags")
    .sort()
    .map((group) => ({ group, configured: groups[group]?.configured === true }));
}
