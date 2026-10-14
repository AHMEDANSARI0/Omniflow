/** Display helpers. Pure functions only - trivially testable. */

export function formatPKR(amount: number): string {
  if (!Number.isFinite(amount)) return "PKR —";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-PK", {
    maximumFractionDigits: abs >= 100 ? 0 : 2,
  });
  return `${sign}PKR ${formatted}`;
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim1(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

function trim1(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "just now" / "5m" / "3h" / "2d" / short date - used by inbox rows. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, now - t);
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
