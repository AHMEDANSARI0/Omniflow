"use client";

import { useEffect, useState } from "react";

type UnreadSink = (count: number) => void;

const sinks = new Set<UnreadSink>();
let timer: number | null = null;
let inFlight = false;

async function pollUnread() {
  if (inFlight || sinks.size === 0) return;
  inFlight = true;
  try {
    const response = await fetch(
      "/api/omniflow/portal/conversations?include=counts&limit=1",
      { credentials: "same-origin", cache: "no-store" }
    );
    if (response.status !== 200) return;
    const payload = (await response.json().catch(() => null)) as {
      counts?: { unread?: number };
    } | null;
    if (!payload) return;
    const unread = payload.counts?.unread || 0;
    for (const sink of sinks) sink(unread);
  } catch {
    // Transient network issue — the next poll retries.
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (timer !== null || typeof window === "undefined") return;
  void pollUnread();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void pollUnread();
  }, 10_000);
}

function stopPolling() {
  if (timer === null || sinks.size > 0) return;
  window.clearInterval(timer);
  timer = null;
}

export function useUnreadCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const sink = (count: number) => setUnreadCount(count);
    sinks.add(sink);
    startPolling();
    return () => {
      sinks.delete(sink);
      stopPolling();
    };
  }, []);

  return unreadCount;
}
