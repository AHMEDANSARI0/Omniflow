"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type RevealTag =
  | "div"
  | "h2"
  | "h3"
  | "h4"
  | "p"
  | "span"
  | "section"
  | "article"
  | "ul"
  | "li";

/** Gap between cards that scroll into view together, and its cap. */
const STAGGER_MS = 90;
const STAGGER_MAX = 6;

/*
 * One IntersectionObserver for the whole page (not one per element).
 * Elements that enter the viewport in the same frame (a row or grid of
 * cards) are sorted top-to-bottom, left-to-right and get a growing
 * delay, so every grid staggers in without per-component code.
 */
type Show = (autoDelay: number) => void;
let shared: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, Show>();

function observe(node: Element, onShow: Show) {
  if (typeof IntersectionObserver === "undefined") {
    onShow(0);
    return () => {};
  }
  if (!shared) {
    shared = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top ||
              a.boundingClientRect.left - b.boundingClientRect.left
          );
        visible.forEach((entry, index) => {
          callbacks.get(entry.target)?.(Math.min(index, STAGGER_MAX) * STAGGER_MS);
          callbacks.delete(entry.target);
          shared?.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -60px 0px" }
    );
  }
  const observer = shared;
  callbacks.set(node, onShow);
  observer.observe(node);
  return () => {
    callbacks.delete(node);
    observer.unobserve(node);
  };
}

/**
 * Scroll reveal island: the element rises in with a soft bounce the
 * first time it scrolls into view. `delay` (ms) overrides the automatic
 * grid stagger; `lift` adds the hover lift.
 */
export default function Reveal({
  as = "div",
  lift = false,
  delay,
  className,
  id,
  children,
}: {
  as?: RevealTag;
  lift?: boolean;
  delay?: number;
  className?: string;
  id?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shownDelay, setShownDelay] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return observe(node, (autoDelay) => setShownDelay(delay ?? autoDelay));
  }, [delay]);

  const Tag = as as "div";
  const classes =
    "of-reveal" +
    (lift ? " of-lift" : "") +
    (shownDelay !== null ? " of-reveal-in" : "") +
    (className ? " " + className : "");
  const style = shownDelay ? ({ "--d": `${shownDelay}ms` } as CSSProperties) : undefined;

  return (
    <Tag ref={ref} id={id} className={classes} style={style}>
      {children}
    </Tag>
  );
}
