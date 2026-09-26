// add_batch_161_165.mjs - one-file batch covering Phases 161-165.
//
//   Ph161  ONE shared unread poller. DashSidebar and MobileTabBar used to
//          each run their own 10s counts request (and the mobile bar polled
//          even on desktop where CSS hides it). A single module-level
//          useUnreadCount hook now serves both: one request per interval
//          no matter how many consumers are mounted.
//   Ph162  The inbox renders its first paint from the server. page.tsx
//          becomes a server wrapper that fetches the first page (respecting
//          ?q=) through the existing portal client while the HTML streams,
//          and the client component (InboxClient.tsx) starts with real rows
//          instead of a spinner. The 15s poll keeps everything fresh.
//   Ph163  Same treatment for the customers list (CustomersClient.tsx).
//   Ph164  getControlPlanePrincipal caches auth/me for 30s per token, so
//          navigating between tabs stops paying a control-plane round trip
//          every navigation.
//   Ph165  A (portal) loading skeleton for instant navigation feedback +
//          regression coverage.
//
// Zero AI. Website only. Vercel deploys on push. NO restart, no CP change.

import fs from "node:fs";
import path from "node:path";

const BACKUP_TAG = ".pre_b161165.bak";

const USE_UNREAD_COUNT = `"use client";

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
`;

const LOADING_PAGE = `export default function PortalLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-52 animate-pulse rounded-lg bg-white/5" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
        <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
      </div>
      <div className="h-72 animate-pulse rounded-2xl bg-white/5" />
    </div>
  );
}
`;

const CONVERSATIONS_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listConversations,
  requirePortalAccessToken,
  type ConversationChipCounts,
  type ConversationSummary,
} from "../../../../lib/omniflow/portal";
import InboxClient from "./InboxClient";


export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOmniFlowSession();
  const params = await searchParams;
  const rawQuery = params.q;
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";

  let initialItems: ConversationSummary[] | null = null;
  let initialCounts: ConversationChipCounts | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const result = await listConversations(accessToken, query || undefined);
      if (result) {
        initialItems = result.conversations;
        initialCounts = result.counts;
      }
    }
  }

  return <InboxClient initialItems={initialItems} initialCounts={initialCounts} />;
}
`;

const CUSTOMERS_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../lib/omniflow/portal";
import CustomersClient from "./CustomersClient";


export default async function CustomersPage() {
  const session = await getOmniFlowSession();

  let initialCustomers: CustomerSummary[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const customers = await listCustomers(accessToken);
      if (customers) initialCustomers = customers;
    }
  }

  return <CustomersClient initialCustomers={initialCustomers} />;
}
`;

const INBOX_TRANSFORMS = [
  {
    name: "inbox-signature",
    from: "export default function ConversationsPage() {",
    to: `export default function InboxClient({
  initialItems,
  initialCounts,
}: {
  initialItems?: ConversationSummary[] | null;
  initialCounts?:
    | { needsReply: number; overdue: number; unassigned: number; unread: number }
    | null;
}) {`,
  },
  {
    name: "inbox-items",
    from: "const [items, setItems] = useState<ConversationSummary[] | null>(null);",
    to: "const [items, setItems] = useState<ConversationSummary[] | null>(\n    initialItems ?? null\n  );",
  },
  {
    name: "inbox-chips",
    from: `const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
    unread: 0,
  });`,
    to: `const [chipCounts, setChipCounts] = useState(
    initialCounts ?? {
      needsReply: 0,
      overdue: 0,
      unassigned: 0,
      unread: 0,
    }
  );`,
  },
  {
    name: "inbox-synced",
    from: "const [syncedAt, setSyncedAt] = useState<Date | null>(null);",
    to: "const [syncedAt, setSyncedAt] = useState<Date | null>(\n    initialItems ? new Date() : null\n  );",
  },
];

const CUSTOMERS_TRANSFORMS = [
  {
    name: "customers-signature",
    from: "export default function CustomersPage() {",
    to: `export default function CustomersClient({
  initialCustomers,
}: {
  initialCustomers?: CustomerSummary[] | null;
}) {`,
  },
  {
    name: "customers-items",
    from: "const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);",
    to: "const [customers, setCustomers] = useState<CustomerSummary[] | null>(\n    initialCustomers ?? null\n  );",
  },
];

function splitClientPage(pagePath, clientName, transforms, serverPage, label) {
  const clientPath = pagePath.replace("page.tsx", clientName);
  const pageText = fs.readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  if (fs.existsSync(clientPath) && pageText.includes(clientName.replace(".tsx", ""))) {
    alreadyTotal++;
    console.log("= " + pagePath + " (split already done)");
    return;
  }
  if (!pageText.includes('"use client"')) {
    warnTotal++;
    console.log("  ? " + pagePath + " :: " + label + " unexpected page shape — report this");
    return;
  }

  let clientText = pageText;
  for (const swap of transforms) {
    const fromCount = clientText.split(swap.from).length - 1;
    if (fromCount !== 1) {
      warnTotal++;
      console.log("  ? " + pagePath + " :: " + swap.name + " NOT FOUND — report this");
      return;
    }
    clientText = clientText.replace(swap.from, swap.to);
  }

  const backup = pagePath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(pagePath, backup);
  fs.writeFileSync(clientPath, clientText, "utf8");
  fs.writeFileSync(pagePath, serverPage.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal += 2;
  console.log("+ " + clientPath + " (new): " + label);
  console.log("+ " + pagePath + " (server wrapper): " + label);
}

const NEW_FILES = [
  { path: "Omniflow/app/dashboard/components/useUnreadCount.ts", content: USE_UNREAD_COUNT, marker: "export function useUnreadCount", name: "p161-shared-poller" },
  { path: "Omniflow/app/dashboard/(portal)/loading.tsx", content: LOADING_PAGE, marker: "PortalLoading", name: "p165-loading-skeleton" },
];

const TARGETS = [
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      { name: "p161-sidebar-import", from: 'import { useEffect, useState } from "react";', to: 'import { useState } from "react";', guard: 'import { useUnreadCount } from "./useUnreadCount";' },
      { name: "p161-sidebar-hook-import", from: 'import SignOutButton from "./SignOutButton";', to: 'import SignOutButton from "./SignOutButton";\nimport { useUnreadCount } from "./useUnreadCount";', guard: 'import { useUnreadCount } from "./useUnreadCount";' },
      { name: "p161-sidebar-block", from: `  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let alive = true;

    async function loadUnread() {
      try {
        const response = await fetch(
          "/api/omniflow/portal/conversations?include=counts&limit=1",
          {
            credentials: "same-origin",
            cache: "no-store",
          }
        );
        if (response.status !== 200 || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          counts?: { unread?: number };
        } | null;
        if (alive && payload) {
          setUnreadCount(payload.counts?.unread || 0);
        }
      } catch {
        // Transient network issue — the next poll retries.
      }
    }

    void loadUnread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUnread();
    }, 10_000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);`, to: "  const unreadCount = useUnreadCount();", guard: "const unreadCount = useUnreadCount();" },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/MobileTabBar.tsx",
    swaps: [
      { name: "p161-mobile-imports", from: `import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";`, to: `import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUnreadCount } from "./useUnreadCount";`, guard: 'import { useUnreadCount } from "./useUnreadCount";' },
      { name: "p161-mobile-block", from: `  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (pathname.startsWith("/dashboard/conversations/")) return;
    let alive = true;

    async function loadUnread() {
      try {
        const response = await fetch(
          "/api/omniflow/portal/conversations?include=counts&limit=1",
          { credentials: "same-origin", cache: "no-store" }
        );
        if (response.status !== 200 || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          counts?: { unread?: number };
        } | null;
        if (alive && payload) {
          setUnreadCount(payload.counts?.unread || 0);
        }
      } catch {
        /* the next poll retries */
      }
    }

    void loadUnread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUnread();
    }, 10_000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pathname]);`, to: "  const unreadCount = useUnreadCount();", guard: "const unreadCount = useUnreadCount();" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/control-plane.ts",
    swaps: [
      { name: "p164-crypto-import", from: 'import { randomUUID } from "crypto";', to: 'import { createHash, randomUUID } from "crypto";', guard: "createHash" },
      { name: "p164-principal-cache", from: `export async function getControlPlanePrincipal(
  accessToken: string
): Promise<OmniFlowPrincipal> {
  const response = await controlPlaneRequest("api/v1/auth/me", {
    method: "GET",
    headers: { Authorization: \`Bearer \${accessToken}\` },
  });
  return parsePrincipal(await jsonResponse(response));
}`, to: `const PRINCIPAL_CACHE_TTL_MS = 30_000;
const PRINCIPAL_CACHE_MAX = 256;
const principalCache = new Map<
  string,
  { principal: OmniFlowPrincipal; at: number }
>();

export async function getControlPlanePrincipal(
  accessToken: string
): Promise<OmniFlowPrincipal> {
  const cacheKey = createHash("sha256").update(accessToken).digest("hex");
  const now = Date.now();
  const cached = principalCache.get(cacheKey);
  if (cached && now - cached.at < PRINCIPAL_CACHE_TTL_MS) {
    return cached.principal;
  }
  const response = await controlPlaneRequest("api/v1/auth/me", {
    method: "GET",
    headers: { Authorization: \`Bearer \${accessToken}\` },
  });
  const principal = parsePrincipal(await jsonResponse(response));
  if (principalCache.size >= PRINCIPAL_CACHE_MAX) {
    const oldest = principalCache.keys().next();
    if (!oldest.done) principalCache.delete(oldest.value);
  }
  principalCache.set(cacheKey, { principal, at: now });
  return principal;
}`, guard: "PRINCIPAL_CACHE_TTL_MS" },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const file of NEW_FILES) {
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

const INBOX_PAGE = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const CUSTOMERS_PAGE = "Omniflow/app/dashboard/(portal)/customers/page.tsx";

if (fs.existsSync(INBOX_PAGE)) {
  splitClientPage(INBOX_PAGE, "InboxClient.tsx", INBOX_TRANSFORMS, CONVERSATIONS_SERVER_PAGE, "p162-inbox-split");
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + INBOX_PAGE);
}

if (fs.existsSync(CUSTOMERS_PAGE)) {
  splitClientPage(CUSTOMERS_PAGE, "CustomersClient.tsx", CUSTOMERS_TRANSFORMS, CUSTOMERS_SERVER_PAGE, "p163-customers-split");
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