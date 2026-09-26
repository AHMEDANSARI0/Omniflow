"""Tests for the activity page + command palette + customers seed (181-185)."""
import sys

from test_lib import check, summary


COMPONENTS = "/tmp/p13/Omniflow/app/dashboard/components"
PORTAL = "/tmp/p13/Omniflow/app/dashboard/(portal)"

print("== activity page ==")

page_src = open(PORTAL + "/activity/page.tsx").read()
check("activity page exists", '"use client"' in page_src and "ActivityPage" in page_src, "page")
check("activity fetch", '"/api/omniflow/portal/activity"' in page_src, "bff")
check("family chips", '"sequence"' in page_src and '"cod"' in page_src
      and '"broadcast"' in page_src and '"webhooks"' in page_src, "chips")
check("prefix filter", "item.action.startsWith(family)" in page_src, "filter")
check("conversation links", '"/dashboard/conversations/" + String(item.conversationId)' in page_src, "links")
check("refresh button", 'onClick={() => void load()}' in page_src, "refresh")
check("empty + failed states", "Nothing here yet." in page_src and "unavailable right now" in page_src, "states")
check("mobile responsive", "max-w-3xl" in page_src and "sm:px-6" in page_src, "responsive")

print("== activity item carries conversation ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("interface conversationId", "conversationId: number | null;" in lib_src, "type")
check("mapper conversation_id", 'raw.conversation_id === "number"' in lib_src, "map")

print("== command palette ==")

palette_src = open(COMPONENTS + "/CommandPalette.tsx").read()
check("palette client", '"use client"' in palette_src, "client")
check("ctrl+k handler", "event.metaKey || event.ctrlKey" in palette_src
      and '"k"' in palette_src, "hotkey")
check("esc closes", 'event.key === "Escape"' in palette_src, "esc")
check("debounced search", "setTimeout" in palette_src and "250" in palette_src, "debounce")
check("min query length", "needle.length < 2" in palette_src, "gate")
check("conversations search", "/api/omniflow/portal/conversations?q=" in palette_src, "conv")
check("customers search", "/api/omniflow/portal/customers?q=" in palette_src, "cust")
check("customer deep link", '"/dashboard/customers?q=" + encodeURIComponent(' in palette_src, "deep")
check("stale response guard", "requestRef.current !== requestId" in palette_src, "guard")
check("keyboard nav", '"ArrowDown"' in palette_src and '"ArrowUp"' in palette_src, "arrows")
check("enter navigates", "navigate(results[activeIndex])" in palette_src, "enter")
check("router push", "router.push(item.href)" in palette_src, "push")
check("dialog a11y", 'role="dialog"' in palette_src and 'aria-modal="true"' in palette_src, "a11y")
check("scroll lock", 'document.body.style.overflow = "hidden"' in palette_src, "lock")
check("palette lists activity page", '"/dashboard/activity"' in palette_src, "activity item")
check("overlay click closes", "onClick={close}" in palette_src, "overlay")

print("== wired into the shell ==")

shell_src = open(COMPONENTS + "/DashShell.tsx").read()
check("shell renders palette", "<CommandPalette />" in shell_src, "render")
check("shell imports palette", 'import CommandPalette from "./CommandPalette";' in shell_src, "import")

sidebar_src = open(COMPONENTS + "/DashSidebar.tsx").read()
check("activity nav item", '{ label: "Activity", href: "/dashboard/activity", icon: "\\u2261", enabled: true }' in sidebar_src, "nav")
check("nav after sequences", sidebar_src.index('"/dashboard/sequences"') < sidebar_src.index('"/dashboard/activity"'), "order")
check("search trigger", "openCommandPalette()" in sidebar_src, "trigger")
check("ctrl k hint", "Ctrl K" in sidebar_src, "hint")
check("palette import", 'import { openCommandPalette } from "./CommandPalette";' in sidebar_src, "import")

print("== customers ?q= seed ==")

cust_page = open(PORTAL + "/customers/page.tsx").read()
check("server reads q", "params.q" in cust_page and "await searchParams" in cust_page, "searchParams")
check("server filters list", "listCustomers(accessToken, initialQuery || undefined)" in cust_page, "filtered fetch")
check("passes initialQuery", "initialQuery={initialQuery}" in cust_page, "prop")

cust_client = open(PORTAL + "/customers/CustomersClient.tsx").read()
check("client accepts query", "initialQuery?: string | null;" in cust_client, "prop")
check("search state seeded", 'useState(initialQuery ?? "")' in cust_client, "state")
check("search ref seeded", 'useRef(initialQuery ?? "")' in cust_client, "ref")

print("== regression ==")

check("portal lib intact", "export async function listCustomers(" in lib_src, "clients")
check("activity bff untouched", "export async function GET()" in open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/activity/route.ts").read(), "bff get")

summary("site_nav")
