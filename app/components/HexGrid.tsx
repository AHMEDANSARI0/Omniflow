"use client";

import { useId } from "react";

/**
 * Reusable kinetic hexagon grid background.
 * Pure CSS/SVG — compositor-only animations, zero JS per frame.
 * Drop inside any section that has `relative overflow-hidden`.
 */

const dotColors = [
  "rgba(34,211,238,0.9)",
  "rgba(139,92,246,0.9)",
  "rgba(96,165,250,0.9)",
];

const dots: { x: number; y: number }[] = [
  { x: 140, y: 234 },
  { x: 336, y: 150 },
  { x: 588, y: 366 },
  { x: 784, y: 84 },
  { x: 1092, y: 334 },
  { x: 420, y: 600 },
  { x: 868, y: 234 },
  { x: 1288, y: 516 },
];

export default function HexGrid({
  opacity = 0.4,
  showDots = true,
}: {
  opacity?: number;
  showDots?: boolean;
}) {
  const rawId = useId();
  const patternId = `hex-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <div
      className="of-hex-drift pointer-events-none absolute"
      style={{
        top: -100,
        left: -56,
        right: 0,
        bottom: 0,
        opacity,
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)",
      }}
      aria-hidden="true"
    >
      <svg className="h-full w-full">
        <defs>
          <pattern
            id={patternId}
            width="56"
            height="100"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100"
              fill="none"
              stroke="rgba(148,197,255,0.55)"
              strokeWidth="1"
            />
            <path
              d="M28 0L28 34L0 50L0 84L28 100L56 84L56 50L28 34"
              fill="none"
              stroke="rgba(148,197,255,0.3)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>

      {showDots &&
        dots.map((dot, i) => (
          <span
            key={`${dot.x}-${dot.y}`}
            className="of-dot-blink absolute rounded-full"
            style={{
              left: dot.x - 2,
              top: dot.y - 2,
              width: 4,
              height: 4,
              background: dotColors[i % 3],
              boxShadow: `0 0 8px ${dotColors[i % 3]}`,
              animationDelay: `${(i * 0.55) % 4}s`,
            }}
          />
        ))}
    </div>
  );
}