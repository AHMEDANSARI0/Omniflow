import type { ReactNode } from "react";

type Tone =
  | "brand"
  | "ai"
  | "flow"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "night";

const TONES: Record<Tone, string> = {
  brand: "border-brand/20 bg-brand-soft text-brand-2",
  ai: "border-ai/20 bg-ai-soft text-ai",
  flow: "border-flow/25 bg-flow-soft text-cyan-700",
  success: "border-ok/20 bg-ok-soft text-ok",
  warning: "border-warn/25 bg-warn-soft text-amber-600",
  danger: "border-danger/20 bg-danger-soft text-danger",
  neutral: "border-line-2 bg-soft text-ink-2",
  night: "border-white/15 bg-white/10 text-snow",
};

/**
 * Small pill label. Uppercase eyebrows use `eyebrow`; status pills
 * stay sentence-case via `plain`.
 */
export default function Badge({
  children,
  tone = "brand",
  eyebrow = false,
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  eyebrow?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
        eyebrow
          ? "text-[11px] font-semibold uppercase tracking-[0.14em]"
          : "text-xs font-medium"
      } ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
