"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";

/** The CSS intro loops every 12s; taps during the first run are ignored. */
const INTRO_MS = 12000;
/** Eyes lead, head / body / light follow: two easings of one pointer. */
const EASE_EYES = 0.2;
const EASE = 0.08;
/** Cursor distance (in half-widths) where the cursor light fades out. */
const NEAR = 2.4;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * Motion island for OmniFlowBot: the only client code of the robot.
 * - cursor tracking (fine pointer + hover only): pointer position is
 *   eased toward in ONE requestAnimationFrame loop that stops when it
 *   settles, written as --ex / --ey (fast: eyes), --lx / --ly (slow:
 *   head, body, parallax, light; -1..1) and --lp (closeness, 0..1)
 *   custom properties (no React state), so the eyes lead and the head
 *   follows like a person's
 * - data-paused while offscreen, so the CSS animations stop
 * - a short wave on touch, after the intro (tap = false turns it off)
 * Nothing runs with prefers-reduced-motion or data-static.
 */
export default function BotMotion({
  track,
  tap,
  waveClass,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  track: boolean;
  tap: boolean;
  waveClass: string;
  "data-static"?: string;
  "data-nointro"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.hasAttribute("data-static") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const born = el.hasAttribute("data-nointro") ? -INTRO_MS : performance.now();
    let visible = true;
    let raf = 0;
    let waveTimer = 0;
    let pointer: { x: number; y: number; near: boolean } | null = null;
    let x = 0;
    let y = 0;
    let ex = 0;
    let ey = 0;
    let p = 0;

    const tick = () => {
      raf = 0;
      if (!pointer) return;
      const box = el.getBoundingClientRect();
      const dx = (pointer.x - (box.left + box.width * 0.5)) / (box.width * 0.6);
      const dy = (pointer.y - (box.top + box.height * 0.45)) / (box.height * 0.6);
      const tx = clamp(dx);
      const ty = clamp(dy);
      const tp = pointer.near ? Math.max(0, 1 - Math.hypot(dx, dy) / NEAR) : 0;
      ex += (tx - ex) * EASE_EYES;
      ey += (ty - ey) * EASE_EYES;
      x += (tx - x) * EASE;
      y += (ty - y) * EASE;
      p += (tp - p) * EASE;
      el.style.setProperty("--ex", ex.toFixed(3));
      el.style.setProperty("--ey", ey.toFixed(3));
      el.style.setProperty("--lx", x.toFixed(3));
      el.style.setProperty("--ly", y.toFixed(3));
      el.style.setProperty("--lp", p.toFixed(3));
      if (Math.abs(tx - x) + Math.abs(ty - y) + Math.abs(tp - p) > 0.002) raf = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (!raf && visible && pointer) raf = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer = { x: event.clientX, y: event.clientY, near: true };
      schedule();
    };
    const onLeave = () => {
      const box = el.getBoundingClientRect();
      pointer = { x: box.left + box.width * 0.5, y: box.top + box.height * 0.45, near: false };
      schedule();
    };
    const onTap = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || waveTimer || performance.now() - born < INTRO_MS) return;
      el.classList.add(waveClass);
      waveTimer = window.setTimeout(() => {
        el.classList.remove(waveClass);
        waveTimer = 0;
      }, 1600);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      el.toggleAttribute("data-paused", !visible);
      if (visible) schedule();
    });
    observer.observe(el);
    if (tap) el.addEventListener("pointerdown", onTap, { passive: true });

    const tracking = track && matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (tracking) {
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("scroll", schedule, { passive: true });
      document.documentElement.addEventListener("mouseleave", onLeave);
    }

    return () => {
      observer.disconnect();
      el.removeEventListener("pointerdown", onTap);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", schedule);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
      window.clearTimeout(waveTimer);
    };
  }, [track, tap, waveClass]);

  return <div ref={ref} {...rest} />;
}
