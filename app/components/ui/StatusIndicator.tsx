import type { AvailabilityStatus } from "../../../lib/marketing/types";
import { STATUS_META } from "../../../lib/marketing/integrations";

const TONES = {
  success: { pill: "border-ok/20 bg-ok-soft text-ok", dot: "bg-success" },
  brand: { pill: "border-brand/20 bg-brand-soft text-brand-2", dot: "bg-brand" },
  neutral: { pill: "border-line bg-soft text-ink-3", dot: "bg-muted" },
  warn: { pill: "border-warn/25 bg-warn-soft text-amber-700", dot: "bg-warn" },
} as const;

export type IndicatorTone = keyof typeof TONES;

/**
 * Status pill: a dot plus a text label, so meaning never depends on
 * colour alone. `pulse` marks something live right now.
 */
export default function StatusIndicator({
  label,
  tone = "neutral",
  pulse = false,
  size = "sm",
  className = "",
}: {
  label: string;
  tone?: IndicatorTone;
  pulse?: boolean;
  size?: "xs" | "sm";
  className?: string;
}) {
  const t = TONES[tone];
  const sizing =
    size === "xs"
      ? "gap-1 px-1.5 py-0.5 text-[10px]"
      : "gap-1.5 px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border font-semibold ${sizing} ${t.pill} ${className}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${t.dot} ${pulse ? "of-pulse" : ""}`}
      />
      {label}
    </span>
  );
}

/** Availability pill driven by the shared status vocabulary. */
export function AvailabilityBadge({
  status,
  size = "sm",
}: {
  status: AvailabilityStatus;
  size?: "xs" | "sm";
}) {
  const meta = STATUS_META[status];
  return (
    <StatusIndicator
      label={meta.label}
      tone={meta.tone}
      pulse={status === "live"}
      size={size}
    />
  );
}
