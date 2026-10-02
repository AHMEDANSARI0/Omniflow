"use client";

import { useEffect, useState } from "react";
import useInView from "../hooks/useInView";
import useReducedMotion from "../hooks/useReducedMotion";

/**
 * Number that counts up once when it scrolls into view (~0.9s, eased).
 * Server HTML and reduced-motion users get the final value directly.
 */
export default function CountUp({
  value,
  suffix = "",
  durationMs = 900,
}: {
  value: number;
  suffix?: string;
  durationMs?: number;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>("0px");
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState<number | null>(null);

  // Off-screen numbers start at 0 so the count is seen, not a jump.
  useEffect(() => {
    if (!reduced && !inView) setDisplay(0);
  }, [reduced, inView]);

  useEffect(() => {
    if (!inView || reduced) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(value * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, reduced, value, durationMs]);

  return (
    <span ref={ref} className="tabular-nums">
      {reduced || display === null ? value : display}
      {suffix}
    </span>
  );
}
