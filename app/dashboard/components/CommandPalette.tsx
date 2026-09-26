"use client";

// b17: the AI Brain page entry moved into Configure AI (/dashboard/bot).
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface PaletteItem {
  group: string;
  label: string;
  href: string;
  sub?: string;
}

const OPEN_EVENT = "omniflow-command-open";

const PAGES: PaletteItem[] = [
  { group: "Pages", label: "Overview", href: "/dashboard" },
  { group: "Pages", label: "Conversations", href: "/dashboard/conversations" },
  { group: "Pages", label: "Customers", href: "/dashboard/customers" },
  { group: "Pages", label: "Broadcasts", href: "/dashboard/broadcasts" },
  { group: "Pages", label: "Automations", href: "/dashboard/automations" },
  { group: "Pages", label: "Analytics", href: "/dashboard/analytics" },
  { group: "Pages", label: "Setup wizard", href: "/dashboard/onboarding" },
  { group: "Pages", label: "Team", href: "/dashboard/team" },
  { group: "Pages", label: "Knowledge base", href: "/dashboard/knowledge-base" },
  { group: "Pages", label: "COD confirmations", href: "/dashboard/cod" },
  { group: "Pages", label: "Courier", href: "/dashboard/courier" },
  { group: "Pages", label: "Media", href: "/dashboard/media" },
  { group: "Pages", label: "Integrations", href: "/dashboard/integrations" },
  { group: "Pages", label: "Sequences", href: "/dashboard/sequences" },
  { group: "Pages", label: "Activity", href: "/dashboard/activity" },
  { group: "Pages", label: "Business profile", href: "/dashboard/profile" },
];

export function openCommandPalette() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OPEN_EVENT));
  }
}

interface ConversationHit {
  id: number;
  contactName: string | null;
  contactId: string | null;
  lastMessagePreview: string | null;
}

interface CustomerHit {
  contactId: string;
  name: string;
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaletteItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.key === "Escape") setOpen(false);
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    const needle = query.trim().toLowerCase();
    const pages = PAGES.filter(
      (page) =>
        !needle ||
        page.label.toLowerCase().includes(needle) ||
        page.href.includes(needle)
    );
    setActiveIndex(0);

    if (needle.length < 2) {
      setResults(pages);
      return;
    }

    const requestId = ++requestRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const [conversationsResponse, customersResponse] = await Promise.all([
          fetch(
            "/api/omniflow/portal/conversations?q=" +
              encodeURIComponent(query.trim()) +
              "&limit=5",
            { credentials: "same-origin", cache: "no-store" }
          ),
          fetch(
            "/api/omniflow/portal/customers?q=" +
              encodeURIComponent(query.trim()),
            { credentials: "same-origin", cache: "no-store" }
          ),
        ]);
        if (requestRef.current !== requestId) return;
        const conversationsPayload = (await conversationsResponse
          .json()
          .catch(() => null)) as { conversations?: ConversationHit[] } | null;
        const customersPayload = (await customersResponse
          .json()
          .catch(() => null)) as { customers?: CustomerHit[] } | null;
        const conversationItems: PaletteItem[] = (
          Array.isArray(conversationsPayload?.conversations)
            ? conversationsPayload.conversations
            : []
        )
          .slice(0, 5)
          .map((hit) => ({
            group: "Conversations",
            label: hit.contactName || hit.contactId || "Conversation " + hit.id,
            href: "/dashboard/conversations/" + String(hit.id),
            sub: hit.lastMessagePreview || undefined,
          }));
        const customerItems: PaletteItem[] = (
          Array.isArray(customersPayload?.customers)
            ? customersPayload.customers
            : []
        )
          .slice(0, 5)
          .map((hit) => ({
            group: "Customers",
            label: hit.name || hit.contactId,
            href:
              "/dashboard/customers?q=" + encodeURIComponent(hit.name || hit.contactId),
            sub: hit.contactId,
          }));
        setResults([...pages, ...conversationItems, ...customerItems]);
      } catch {
        if (requestRef.current === requestId) setResults(pages);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const navigate = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      close();
      router.push(item.href);
    },
    [close, router]
  );

  if (!open) return null;

  const move = (delta: number) => {
    setActiveIndex((current) => {
      if (results.length === 0) return 0;
      return (current + delta + results.length) % results.length;
    });
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[60] bg-soft px-4 pt-[10vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              navigate(results[activeIndex]);
            }
          }}
          placeholder="Search pages, chats, customers..."
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm text-ink placeholder:text-ink-3 outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-3">
              No matches for &ldquo;{query}&rdquo;
            </p>
          ) : (
            results.map((item, index) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.group + "-" + item.href + "-" + item.label}>
                  {showGroup ? (
                    <p className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-ink-3">
                      {item.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => navigate(item)}
                    className={
                      "flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors " +
                      (index === activeIndex
                        ? "bg-brand-soft text-ink"
                        : "text-ink-2")
                    }
                  >
                    <span className="truncate">{item.label}</span>
                    {item.sub ? (
                      <span className="hidden max-w-[45%] truncate text-[11px] text-ink-3 sm:block">
                        {item.sub}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-[10px] text-ink-3 sm:flex">
          <span>&uarr;&darr; navigate</span>
          <span>Enter open</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
