"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageCircle, X } from "lucide-react";
import { readableInk } from "../../lib/marketing/color";

interface WidgetConfig {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
}

interface WidgetMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  created_at: string | null;
}

const VISITOR_KEY = "of_widget_visitor";

function resolveVisitorId(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    return "anon" + Date.now().toString(36);
  }
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function WebsiteChatWidget() {
  const [widgetReady, setWidgetReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setWidgetReady(true), 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  if (!widgetReady) return null;
  return <WebsiteChatWidgetSurface />;
}

function WebsiteChatWidgetSurface() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [loadedThread, setLoadedThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [visitorId, setVisitorId] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);

  /* §258: Escape closes the panel and focus returns to the launcher, the
     same keyboard contract the portal's dropdowns follow. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /* §258: opening the chat puts the caret in the composer immediately. */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const hidden =
    pathname === null ||
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/admin");

  useEffect(() => {
    setMounted(true);
    setVisitorId(resolveVisitorId());
    let alive = true;
    async function loadConfig() {
      try {
        const response = await fetch("/api/omniflow/widget/config", {
          cache: "no-store",
        });
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          enabled?: boolean;
          business_name?: string;
          welcome_text?: string;
          accent?: string;
          position?: string;
          launcher_label?: string;
        } | null;
        if (alive && payload?.enabled) {
          setConfig({
            enabled: true,
            businessName: payload.business_name ?? "",
            welcomeText: payload.welcome_text ?? "",
            accent:
              typeof payload.accent === "string" &&
              /^#[0-9a-fA-F]{6}$/.test(payload.accent)
                ? payload.accent
                : "#22d3ee",
            position: payload.position === "left" ? "left" : "right",
            launcherLabel:
              typeof payload.launcher_label === "string"
                ? payload.launcher_label
                : "",
          });
        }
      } catch {
        // The bubble simply stays hidden until the backend answers.
      }
    }
    void loadConfig();
    return () => {
      alive = false;
    };
  }, []);

  const refreshThread = useCallback(
    async (reset: boolean) => {
      if (!visitorId) return;
      try {
        const sinceId =
          !reset && messages.length > 0
            ? String(messages[messages.length - 1].id)
            : "0";
        const response = await fetch(
          "/api/omniflow/widget/chat?visitor_id=" +
            encodeURIComponent(visitorId) +
            "&since=" +
            sinceId,
          { cache: "no-store" }
        );
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as {
          messages?: WidgetMessage[];
        } | null;
        if (payload && Array.isArray(payload.messages)) {
          if (reset) {
            setMessages(payload.messages);
          } else if (payload.messages.length > 0) {
            setMessages((current) => [...current, ...payload.messages!]);
          }
        }
        setLoadedThread(true);
      } catch {
        // Transient network issue — the next poll retries.
      }
    },
    [visitorId, messages]
  );

  useEffect(() => {
    if (!open) return;
    void refreshThread(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshThread(false);
    }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visitorId]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open]);

  async function send() {
    const text = draft.trim();
    if (busy || !text || !visitorId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/widget/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_id: visitorId, text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: { body?: string } | null;
      } | null;
      if (response.ok && payload?.ok) {
        setDraft("");
        await refreshThread(true);
      }
    } catch {
      // The visitor can retry — keep the draft.
    } finally {
      setBusy(false);
    }
  }

  if (!mounted || hidden || !config || !config.enabled) return null;

  return (
    <>
      {open && (
        <div
          className={
            /* §258: on phones the panel is a sheet that clears the navbar
               above and the launcher below (it used to cover the page and
               cut the composer off behind the launcher). */
            "fixed inset-x-3 top-20 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#060f1b] shadow-2xl shadow-black/40 sm:inset-x-auto sm:bottom-20 sm:top-auto sm:h-[540px] sm:w-96 " +
            (config.position === "left" ? "sm:left-5" : "sm:right-5")
          }
          role="dialog"
          aria-label="Chat with us"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{
                  border: "1px solid " + config.accent + "33",
                  backgroundColor: config.accent + "0F",
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: config.accent,
                    boxShadow: "0 0 12px " + config.accent + "B3",
                  }}
                />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {config.businessName || "Chat with us"}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-emerald-300">
                  Typically replies instantly
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                launcherRef.current?.focus();
              }}
              aria-label="Close chat"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 transition-colors duration-200 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto p-4">
            <div className="flex justify-start">
              <p className="max-w-[80%] rounded-2xl rounded-bl-md border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-xs leading-relaxed text-slate-200">
                {config.welcomeText || "Hi! How can we help?"}
              </p>
            </div>
            {loadedThread &&
              messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    "flex " +
                    (message.direction === "in" ? "justify-end" : "justify-start")
                  }
                >
                  <p
                    className={
                      "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed " +
                      (message.direction === "in"
                        ? "rounded-br-md border text-slate-50"
                        : "rounded-bl-md border border-white/[0.06] bg-white/[0.03] text-slate-200")
                    }
                    style={
                      message.direction === "in"
                        ? {
                            borderColor: config.accent + "33",
                            backgroundColor: config.accent + "14",
                          }
                        : undefined
                    }
                  >
                    {message.body}
                    {message.created_at ? (
                      <span className="mt-1 block text-[9px] text-slate-400">
                        {formatWhen(message.created_at)}
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="flex items-center gap-2 border-t border-white/[0.06] bg-white/[0.02] p-3"
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={1000}
              placeholder="Type your message…"
              className="min-h-10 min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors duration-300 hover:border-white/15 focus:border-white/30"
            />
            {/* §258: solid accent with the readable ink - the raw accent as
                text on the dark panel measured 3.6:1. */}
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="min-h-10 shrink-0 rounded-xl border px-4 py-2.5 text-xs font-semibold transition-all duration-300 hover:brightness-110 disabled:opacity-50"
              style={{
                borderColor: config.accent,
                backgroundColor: config.accent,
                color: readableInk(config.accent),
              }}
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}

      {/* §258: lucide glyphs (no text symbols) and the ink is chosen from
          the tenant accent, so a light accent no longer hides the icon. */}
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close chat" : "Open chat"}
        aria-expanded={open}
        className={
          "fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-50 flex items-center justify-center gap-2 border shadow-xl transition-transform duration-200 hover:scale-105 " +
          (config.position === "left" ? "left-5" : "right-5") +
          (!open && config.launcherLabel
            ? " h-12 rounded-full px-4 text-sm font-semibold"
            : " h-12 w-12 rounded-full")
        }
        style={{
          borderColor: config.accent + "4D",
          backgroundColor: config.accent,
          color: readableInk(config.accent),
          boxShadow: "0 10px 30px " + config.accent + "33",
        }}
      >
        {open ? (
          <X className="h-5 w-5" aria-hidden />
        ) : (
          <MessageCircle className="h-5 w-5" aria-hidden />
        )}
        {!open && config.launcherLabel ? (
          <span>{config.launcherLabel}</span>
        ) : null}
      </button>
    </>
  );
}
