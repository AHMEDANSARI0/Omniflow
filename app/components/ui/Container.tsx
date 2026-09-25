import type { ReactNode } from "react";

/**
 * Page-width wrapper. `wide` opens up to 80rem for product showcases,
 * the default 72rem matches the editorial column rhythm.
 */
export default function Container({
  children,
  wide = false,
  className = "",
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full ${
        wide ? "max-w-7xl" : "max-w-6xl"
      } px-5 sm:px-6 lg:px-8 ${className}`}
    >
      {children}
    </div>
  );
}
