"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Becomes true the first time the element enters the viewport, then
 * stops observing. Falls back to true where IntersectionObserver is
 * unavailable so content is never stuck hidden.
 */
export default function useInView<T extends Element>(rootMargin = "0px 0px -15% 0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}
