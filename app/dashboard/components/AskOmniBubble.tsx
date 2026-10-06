"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import PortalIcon from "./PortalIcon";
import { ASSISTANT_LINK } from "./portalNav";

// §246: Ask Omni lives in a floating bubble (bottom right) on every portal
// page. The chat code loads only on the first open and stays mounted, so a
// closed bubble keeps the conversation. Phones get a full-screen sheet.

const AssistantClient = dynamic(() => import("../(portal)/assistant/AssistantClient"), {
  ssr: false,
  loading: () => <p className="p-5 text-sm text-ink-3">Loading...</p>,
});

// Pages that already show the assistant, or keep a reply box in the corner.
const HIDDEN_ON = [ASSISTANT_LINK.href, "/dashboard/conversations"];

export default function AskOmniBubble() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hidden = HIDDEN_ON.some((href) => pathname === href || pathname.startsWith(href + "/"));

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (hidden) return null;

  return (
    <>
      {loaded && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Ask Omni"
          className={`fixed inset-0 z-[55] flex-col bg-white sm:inset-auto sm:bottom-40 sm:right-6 sm:h-[min(640px,calc(100dvh-12rem))] sm:w-[400px] sm:overflow-hidden sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl lg:bottom-24 lg:h-[min(640px,calc(100dvh-8rem))] ${
            open ? "flex" : "hidden"
          }`}
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white">
              <PortalIcon name="sparkles" className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Ask Omni</p>
              <p className="truncate text-[11px] text-ink-3">Answers from your workspace data</p>
            </div>
            <Link
              href={ASSISTANT_LINK.href}
              onClick={() => setOpen(false)}
              title="Open full page"
              aria-label="Open full page"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-soft hover:text-ink"
            >
              <PortalIcon name="expand" />
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Ask Omni"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-soft hover:text-ink"
            >
              <PortalIcon name="close" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AssistantClient variant="panel" />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          setLoaded(true);
          setOpen((value) => !value);
        }}
        aria-label={open ? "Close Ask Omni" : "Ask Omni"}
        aria-expanded={open}
        className={`fixed bottom-[max(5.25rem,calc(4.5rem_+_env(safe-area-inset-bottom)))] right-4 z-[56] h-14 w-14 items-center justify-center gap-2 rounded-full bg-brand text-white shadow-[0_10px_30px_rgba(79,70,229,0.35)] transition-transform duration-200 hover:scale-105 active:scale-95 sm:right-6 lg:bottom-6 lg:w-auto lg:px-5 ${
          open ? "hidden sm:flex" : "flex"
        }`}
      >
        <PortalIcon name={open ? "close" : "sparkles"} className="h-5 w-5" />
        <span className="hidden text-sm font-semibold lg:inline">{open ? "Close" : "Ask Omni"}</span>
      </button>
    </>
  );
}
