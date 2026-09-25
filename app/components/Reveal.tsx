"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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

export default function Reveal({
  as = "div",
  lift = false,
  className,
  children,
}: {
  as?: RevealTag;
  lift?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -60px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const Tag = as as "div";
  const classes =
    "of-reveal" +
    (lift ? " of-lift" : "") +
    (shown ? " of-reveal-in" : "") +
    (className ? " " + className : "");

  return (
    <Tag ref={ref} className={classes}>
      {children}
    </Tag>
  );
}
