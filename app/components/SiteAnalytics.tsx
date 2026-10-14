"use client";

// §260 website analytics: no cookies, no browser storage, no IP (the server hashes
// it daily and drops it). Sends anonymous events to /api/omniflow/public/track:
// page views, time on page, button and link clicks, form submits. Only the public
// marketing site is measured. Do Not Track is respected.
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const ENDPOINT = "/api/omniflow/public/track";
// Not measured: the admin panel, the client portal, the API, client checkout (/c/...)
// and client storefronts (/store/...). Only OmniFlow's own marketing pages count.
const SKIP = ["/admin", "/dashboard", "/api", "/c", "/store"];
const MAX_SECONDS = 1800;

type Span = { path: string; since: number };

function measured(path: string): boolean {
  return !SKIP.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function send(payload: Record<string, unknown>): void {
  if (navigator.doNotTrack === "1") return;
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function endSpan(span: Span): void {
  const seconds = Math.min(MAX_SECONDS, Math.round((Date.now() - span.since) / 1000));
  if (span.path && span.since > 0 && seconds > 0) {
    send({ event: "page_time", path: span.path, seconds });
  }
}

export default function SiteAnalytics() {
  const pathname = usePathname() || "/";
  const pathRef = useRef(pathname);
  const span = useRef<Span>({ path: "", since: 0 });
  const firstView = useRef(true);

  // A page view on every route change (the root layout stays mounted).
  useEffect(() => {
    pathRef.current = pathname;
    endSpan(span.current);
    span.current = { path: "", since: 0 };
    if (!measured(pathname)) return;

    let referrerHost = "";
    if (firstView.current && document.referrer) {
      try {
        referrerHost = new URL(document.referrer).host;
      } catch {
        referrerHost = "";
      }
    }
    firstView.current = false;

    const params = new URLSearchParams(window.location.search);
    send({
      event: "page_view",
      path: pathname,
      referrer_host: referrerHost,
      utm_source: params.get("utm_source") ?? "",
      utm_medium: params.get("utm_medium") ?? "",
      utm_campaign: params.get("utm_campaign") ?? "",
    });
    span.current = { path: pathname, since: Date.now() };
  }, [pathname]);

  // Time on page (paused while the tab is hidden), button and link clicks, form submits.
  useEffect(() => {
    const leave = () => {
      endSpan(span.current);
      span.current = { path: "", since: 0 };
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        leave();
      } else if (measured(pathRef.current)) {
        span.current = { path: pathRef.current, since: Date.now() };
      }
    };
    const onClick = (event: MouseEvent) => {
      const path = pathRef.current;
      if (!measured(path)) return;
      const el = (event.target as Element | null)?.closest?.("a[href], [data-track]");
      if (!el) return;
      let meta = el.getAttribute("data-track") ?? "";
      if (!meta && el instanceof HTMLAnchorElement) {
        try {
          const url = new URL(el.href);
          if (url.protocol !== "https:" && url.protocol !== "http:") return;
          meta = url.origin === window.location.origin ? url.pathname : `outbound:${url.hostname}`;
        } catch {
          return;
        }
      }
      if (meta) send({ event: "cta_click", path, meta });
    };
    const onSubmit = (event: Event) => {
      const path = pathRef.current;
      const form = event.target;
      if (!measured(path) || !(form instanceof HTMLFormElement)) return;
      const meta = form.getAttribute("data-track") || form.id || form.getAttribute("name") || "form";
      send({ event: "form_submit", path, meta });
    };

    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("pagehide", leave);
    };
  }, []);

  return null;
}
