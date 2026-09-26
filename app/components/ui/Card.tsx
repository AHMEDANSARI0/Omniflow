import type { ReactNode } from "react";

/**
 * The OmniFlow card: white surface, hairline border, quiet shadow.
 * `hoverable` adds the small lift used across feature grids.
 */
export default function Card({
  children,
  className = "",
  hoverable = false,
  gradientRing = false,
}: {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  gradientRing?: boolean;
}) {
  const base = gradientRing
    ? "of-ring-gradient"
    : "border border-line bg-white shadow-card";
  const hover = hoverable
    ? "transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover hover:border-line-2"
    : "";
  return (
    <div className={`rounded-xl3 ${base} ${hover} ${className}`}>
      {children}
    </div>
  );
}
