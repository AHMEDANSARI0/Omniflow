// add_batch_181_185.mjs - one-file batch covering Phases 181-185.
//
//   Ph181  Activity page /dashboard/activity: the audit trail becomes a real
//          page - family chips (Sequences, COD, Broadcasts, Webhooks, KB,
//          Customers, Inbox), notes, "Open chat" links (ActivityItem now
//          carries conversationId), Refresh. Reuses the EXISTING
//          /portal/activity endpoint - zero CP changes.
//   Ph182  Command palette (Ctrl/Cmd+K): pages + live conversation and
//          customer search via the existing list BFFs (250ms debounce,
//          stale-response guard), arrow/enter navigation, dialog a11y,
//          scroll lock. Rendered by DashShell; the sidebar footer gains a
//          "Search  Ctrl K" trigger.
//   Ph183  Sidebar "Activity" nav item after Sequences.
//   Ph184  Customers ?q= seed: the customers server page reads ?q= and
//          seeds the search, so palette customer results land pre-filtered.
//   Ph185  Regression coverage (test_site_nav).
//
// Zero AI. Website only. NO restart, NO CP change. Vercel deploys on push.

import fs from "node:fs";
import path from "node:path";

const BACKUP_TAG = ".pre_b181185.bak";

const PALETTE_TSX = `"use client";

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
  { group: "Pages", label: "Team", href: "/dashboard/team" },
  { group: "Pages", label: "Knowledge base", href: "/dashboard/knowledge-base" },
  { group: "Pages", label: "COD confirmations", href: "/dashboard/cod" },
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
      className="fixed inset-0 z-[60] bg-black/60 px-4 pt-[10vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a1626] shadow-2xl"
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
          className="w-full border-b border-white/[0.06] bg-transparent px-4 py-3.5 text-sm text-white placeholder:text-slate-600 outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-500">
              No matches for &ldquo;{query}&rdquo;
            </p>
          ) : (
            results.map((item, index) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.group + "-" + item.href + "-" + item.label}>
                  {showGroup ? (
                    <p className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-slate-600">
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
                        ? "bg-cyan-400/[0.08] text-white"
                        : "text-slate-300")
                    }
                  >
                    <span className="truncate">{item.label}</span>
                    {item.sub ? (
                      <span className="hidden max-w-[45%] truncate text-[11px] text-slate-600 sm:block">
                        {item.sub}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="hidden items-center gap-4 border-t border-white/[0.06] px-4 py-2 text-[10px] text-slate-600 sm:flex">
          <span>&uarr;&darr; navigate</span>
          <span>Enter open</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
`;

const ACTIVITY_PAGE = `"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ActivityRow {
  id: number;
  action: string;
  label: string;
  note: string;
  conversationId: number | null;
  createdAt: string;
  timeAgo: string;
}

const FAMILIES: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sequence", label: "Sequences" },
  { key: "cod", label: "COD" },
  { key: "broadcast", label: "Broadcasts" },
  { key: "webhooks", label: "Webhooks" },
  { key: "kb", label: "Knowledge base" },
  { key: "customers", label: "Customers" },
  { key: "conversation", label: "Inbox" },
];

export default function ActivityPage() {
  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [family, setFamily] = useState("all");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/omniflow/portal/activity", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        setItems([]);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        items?: ActivityRow[];
      } | null;
      setItems(Array.isArray(payload?.items) ? payload.items : []);
    } catch {
      setFailed(true);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (items ?? []).filter(
    (item) => family === "all" || item.action.startsWith(family)
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Activity</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Everything your team and automations did, newest first.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FAMILIES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setFamily(entry.key)}
              className={
                "rounded-lg border px-3 py-1.5 text-xs transition " +
                (family === entry.key
                  ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                  : "border-white/[0.08] text-slate-400 hover:text-white")
              }
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
          >
            Refresh
          </button>
        </div>

        {items === null ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">Loading activity...</p>
          </div>
        ) : failed ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">
              Activity is unavailable right now.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14]"
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">Nothing here yet.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">{item.label}</p>
                  {item.note ? (
                    <p className="mt-0.5 truncate text-xs text-slate-500">{item.note}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {item.conversationId ? (
                    <Link
                      href={
                        "/dashboard/conversations/" + String(item.conversationId)
                      }
                      className="text-xs text-cyan-300 transition hover:text-cyan-200"
                    >
                      Open chat
                    </Link>
                  ) : null}
                  <span className="text-[11px] text-slate-600">{item.timeAgo}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
`;

const CUSTOMERS_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../lib/omniflow/portal";
import CustomersClient from "./CustomersClient";


export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOmniFlowSession();
  const params = await searchParams;
  const rawQuery = params.q;
  const initialQuery = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";

  let initialCustomers: CustomerSummary[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const customers = await listCustomers(accessToken, initialQuery || undefined);
      if (customers) initialCustomers = customers;
    }
  }

  return (
    <CustomersClient initialCustomers={initialCustomers} initialQuery={initialQuery} />
  );
}
`;

const TARGETS = [

  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p181-activity-item", from: `export interface ActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  createdAt: string;
  timeAgo: string;
}`, to: `export interface ActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  conversationId: number | null;
  createdAt: string;
  timeAgo: string;
}`, guard: "conversationId: number | null;\n  createdAt: string;\n  timeAgo: string;" },
      { name: "p181-activity-map", from: `        note: typeof raw.note === "string" ? raw.note : "",
        createdAt,
        timeAgo: timeAgoLabel(createdAt),`, to: `        note: typeof raw.note === "string" ? raw.note : "",
        conversationId:
          typeof raw.conversation_id === "number" ? raw.conversation_id : null,
        createdAt,
        timeAgo: timeAgoLabel(createdAt),`, guard: "raw.conversation_id" },
    ],
  },

  {
    file: "Omniflow/app/dashboard/components/DashShell.tsx",
    swaps: [
      { name: "p182-shell-import", from: `import DashSidebar from "./DashSidebar";
import MobileTabBar from "./MobileTabBar";`, to: `import CommandPalette from "./CommandPalette";
import DashSidebar from "./DashSidebar";
import MobileTabBar from "./MobileTabBar";`, guard: "import CommandPalette from \"./CommandPalette\";" },
      { name: "p182-shell-render", from: `      <MobileTabBar />
    </div>`, to: `      <MobileTabBar />
      <CommandPalette />
    </div>`, guard: "<CommandPalette />" },
    ],
  },

  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      { name: "p183-nav-import", from: `import SignOutButton from "./SignOutButton";`, to: `import { openCommandPalette } from "./CommandPalette";
import SignOutButton from "./SignOutButton";`, guard: "import { openCommandPalette } from \"./CommandPalette\";" },
      { name: "p183-nav-item", from: `  { label: "Sequences", href: "/dashboard/sequences", icon: "\\u2192", enabled: true },`, to: `  { label: "Sequences", href: "/dashboard/sequences", icon: "\\u2192", enabled: true },
  { label: "Activity", href: "/dashboard/activity", icon: "\\u2261", enabled: true },`, guard: "\"/dashboard/activity\"" },
      { name: "p182-search-trigger", from: `    <div className="space-y-3 border-t border-white/[0.06] pt-4">
      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
      >`, to: `    <div className="space-y-3 border-t border-white/[0.06] pt-4">
      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
      >
      <button
        type="button"
        onClick={() => openCommandPalette()}
        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs text-slate-500 transition-colors duration-200 hover:bg-white/[0.03] hover:text-slate-300"
      >
        <span className="flex items-center gap-2">
          <span>⌕</span> Search
        </span>
        <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-slate-600">
          Ctrl K
        </span>
      </button>`, guard: "openCommandPalette()" },
    ],
  },

  {
    file: "Omniflow/app/dashboard/(portal)/customers/CustomersClient.tsx",
    swaps: [
      { name: "p184-client-signature", from: `export default function CustomersClient({
  initialCustomers,
}: {
  initialCustomers?: CustomerSummary[] | null;
}) {`, to: `export default function CustomersClient({
  initialCustomers,
  initialQuery,
}: {
  initialCustomers?: CustomerSummary[] | null;
  initialQuery?: string | null;
}) {`, guard: "initialQuery" },
      { name: "p184-client-search", from: `  const [search, setSearch] = useState("");`, to: `  const [search, setSearch] = useState(initialQuery ?? "");`, guard: "useState(initialQuery ?? \"\")" },
      { name: "p184-client-ref", from: `  const searchRef = useRef("");`, to: `  const searchRef = useRef(initialQuery ?? "");`, guard: "useRef(initialQuery ?? \"\")" },
    ],
  },

];


let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const file of [
  { path: "Omniflow/app/dashboard/components/CommandPalette.tsx", content: PALETTE_TSX, marker: "export default function CommandPalette", name: "p182-command-palette" },
  { path: "Omniflow/app/dashboard/(portal)/activity/page.tsx", content: ACTIVITY_PAGE, marker: "ActivityPage", name: "p181-activity-page" },
]) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }
  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
  fs.writeFileSync(target.file, text, "utf8");
  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

const CUSTOMERS_PAGE = "Omniflow/app/dashboard/(portal)/customers/page.tsx";
if (fs.existsSync(CUSTOMERS_PAGE)) {
  const pageText = fs.readFileSync(CUSTOMERS_PAGE, "utf8").replace(/\r\n/g, "\n");
  if (pageText.includes("initialQuery")) {
    alreadyTotal++;
    console.log("= " + CUSTOMERS_PAGE + " (q seed already present)");
  } else if (pageText.includes('"use client"')) {
    warnTotal++;
    console.log("  ? " + CUSTOMERS_PAGE + " :: p184-customers-page unexpected shape — report this");
  } else {
    const backup = CUSTOMERS_PAGE + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(CUSTOMERS_PAGE, backup);
    fs.writeFileSync(CUSTOMERS_PAGE, CUSTOMERS_SERVER_PAGE.replace(/\r\n/g, "\n"), "utf8");
    appliedTotal++;
    console.log("+ " + CUSTOMERS_PAGE + " (rewritten): p184-customers-page");
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + CUSTOMERS_PAGE);
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);