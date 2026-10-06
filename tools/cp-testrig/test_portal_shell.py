"""§246 customer portal shell: grouped dropdown sidebar, top-level Dashboard +
Settings, search (and alerts) in the top bar, Ask Omni bubble, the global
dashboard and one SVG icon set (lucide-react, already a site dependency). Static pins plus a real run of the
nav helpers (portalNav.ts transpiled with the repo's TypeScript)."""
import json
import os
import re
import shutil
import subprocess
import sys

from test_lib import check, summary

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
COMP = os.path.join(ROOT, "app/dashboard/components")
PORTAL = os.path.join(ROOT, "app/dashboard/(portal)")


def read(path):
    with open(path, encoding="utf8") as handle:
        return handle.read()


NAV = read(os.path.join(COMP, "portalNav.ts"))
ICON = read(os.path.join(COMP, "PortalIcon.tsx"))
SIDE = read(os.path.join(COMP, "DashSidebar.tsx"))
TOP = read(os.path.join(COMP, "DashTopbar.tsx"))
SHELL = read(os.path.join(COMP, "DashShell.tsx"))
BUBBLE = read(os.path.join(COMP, "AskOmniBubble.tsx"))
PALETTE = read(os.path.join(COMP, "CommandPalette.tsx"))
TABS = read(os.path.join(COMP, "MobileTabBar.tsx"))
BELL = read(os.path.join(COMP, "AlertsBell.tsx"))
PAGE = read(os.path.join(PORTAL, "page.tsx"))
WIDGETS = read(os.path.join(PORTAL, "DashboardWidgets.tsx"))
ASSIST = read(os.path.join(PORTAL, "assistant/AssistantClient.tsx"))
LIB = read(os.path.join(ROOT, "lib/omniflow/portal.ts"))

ICON_NAMES = set(re.findall(r"^  ([a-zA-Z]+): [A-Z][A-Za-z0-9]*,$", ICON, re.M))
GROUPS = re.findall(r'id: "([a-z]+)",\n    title: "([^"]+)",\n    icon: "([a-zA-Z]+)"', NAV)
ITEMS = re.findall(r'\{ label: "([^"]+)", href: "([^"]+)", icon: "([a-zA-Z]+)" \}', NAV)

print("== navigation config ==")
group_ids = [g[0] for g in GROUPS]
check("Inbox and Sales are dropdown groups", "inbox" in group_ids and "sales" in group_ids, group_ids)
check("eight groups", len(GROUPS) == 8, len(GROUPS))
check("Dashboard is a top-level link", 'DASHBOARD_LINK: NavItem = { label: "Dashboard", href: "/dashboard", icon: "dashboard" }' in NAV)
check("Settings is a top-level link", 'SETTINGS_LINK: NavItem = { label: "Settings", href: "/dashboard/settings", icon: "settings" }' in NAV)
groups_src = NAV[NAV.index("export const NAV_GROUPS"):NAV.index("export function isNavActive")]
check("Settings is in no group (not under Workspace)", "/dashboard/settings" not in groups_src)
check("Ask Omni is not a sidebar item (it is the bubble)", "/dashboard/assistant" not in groups_src)
hrefs = [i[1] for i in ITEMS]
check("no duplicate nav entries", len(hrefs) == len(set(hrefs)), hrefs)
check("every nav icon exists in the SVG set",
      all(i[2] in ICON_NAMES for i in ITEMS) and all(g[2] in ICON_NAMES for g in GROUPS),
      [i for i in ITEMS if i[2] not in ICON_NAMES])
check("item icons are distinct per page (no reused wrong glyphs)",
      len({i[2] for i in ITEMS}) >= len(ITEMS) - 2, sorted(i[2] for i in ITEMS))

routes = set()
for base, _dirs, files in os.walk(PORTAL):
    if "page.tsx" in files:
        rel = os.path.relpath(base, PORTAL)
        routes.add("/dashboard" if rel == "." else "/dashboard/" + rel)
check("every nav link has a page", all(h in routes for h in hrefs), [h for h in hrefs if h not in routes])
reachable = set(hrefs) | {"/dashboard", "/dashboard/settings", "/dashboard/assistant"}
# Sub-pages open from their parent; ai-brain lives inside Configure AI (b17).
not_in_nav = {"/dashboard/ai-brain", "/dashboard/broadcasts/calendar",
              "/dashboard/conversations/[id]", "/dashboard/customers/profile"}
check("no orphan portal pages", routes - reachable == not_in_nav, sorted(routes - reachable))

print("== nav helpers (executed) ==")
node = shutil.which("node")
ts = os.path.join(ROOT, "node_modules/typescript")
if node and os.path.isdir(ts):
    script = r"""
const ts = require(process.argv[1]);
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const m = { exports: {} };
new Function("module", "exports", "require", out)(m, m.exports, require);
const nav = m.exports;
const f = (p) => { const r = nav.findNav(p); return [r.group ? r.group.id : null, r.item ? r.item.href : null]; };
console.log(JSON.stringify({
  root: nav.isNavActive("/dashboard", "/dashboard"),
  rootNotChild: nav.isNavActive("/dashboard/sales", "/dashboard"),
  prefixOnly: nav.isNavActive("/dashboard/salesx", "/dashboard/sales"),
  child: nav.isNavActive("/dashboard/conversations/12", "/dashboard/conversations"),
  thread: f("/dashboard/conversations/12"),
  cod: f("/dashboard/cod"),
  settings: f("/dashboard/settings"),
  wa: f("/dashboard/channels/whatsapp"),
  unknown: f("/dashboard/ai-brain"),
}));
"""
    proc = subprocess.run([node, "-e", script, ts, os.path.join(COMP, "portalNav.ts")],
                          capture_output=True, text=True, timeout=60)
    res = json.loads(proc.stdout or "{}") if proc.returncode == 0 else {}
    check("helpers run", proc.returncode == 0, proc.stderr[-300:])
    check("Dashboard active only on /dashboard", res.get("root") is True and res.get("rootNotChild") is False)
    check("no prefix false positive (/salesx is not /sales)", res.get("prefixOnly") is False)
    check("child routes keep their parent active", res.get("child") is True)
    check("thread opens the Inbox group", res.get("thread") == ["inbox", "/dashboard/conversations"], res.get("thread"))
    check("COD opens the Sales group", res.get("cod") == ["sales", "/dashboard/cod"], res.get("cod"))
    check("Settings has no group", res.get("settings") == [None, "/dashboard/settings"], res.get("settings"))
    check("WhatsApp setup sits in Workspace", res.get("wa") == ["workspace", "/dashboard/channels/whatsapp"])
    check("unknown page opens nothing", res.get("unknown") == [None, None], res.get("unknown"))
else:
    print("  SKIP  node/typescript not available")

print("== sidebar ==")
check("groups are buttons with aria-expanded + aria-controls",
      "aria-expanded={open}" in SIDE and "aria-controls={panelId}" in SIDE)
check("group holding the current page opens by itself",
      "openGroups[group.id] ?? group.id === activeGroup" in SIDE)
check("Dashboard first, groups, then Settings",
      SIDE.index("renderLink(DASHBOARD_LINK, false)") < SIDE.index("NAV_GROUPS.map(renderGroup)")
      < SIDE.index("renderLink(SETTINGS_LINK, false)"))
check("Settings is pinned below the scrolling groups (always in view)",
      '<div className="mb-2 border-t border-line pt-2">{renderLink(SETTINGS_LINK, false)}</div>\n    </nav>' in SIDE
      and SIDE.index("{NAV_GROUPS.map(renderGroup)}\n      </div>") < SIDE.index("renderLink(SETTINGS_LINK, false)"))
check("collapsed rail: group icon expands the sidebar into that group",
      "onExpand?.();" in SIDE and "onExpand={collapsed ? onToggle : undefined}" in SIDE)
check("search removed from the sidebar", "openCommandPalette" not in SIDE and "Ctrl K" not in SIDE)
check("no button nested in the website link (old invalid markup)",
      not re.search(r'<a\b[^>]*href="/"[^>]*>\s*<button', SIDE))
check("active link exposes aria-current", 'aria-current={active ? "page" : undefined}' in SIDE)
check("unread badge kept on Conversations and on the closed Inbox group",
      "const unreadCount = useUnreadCount();" in SIDE and "groupUnread" in SIDE)

print("== top bar ==")
check("shell renders the top bar", "<DashTopbar menuOpen={mobileOpen}" in SHELL)
check("search sits in the top bar", "openCommandPalette()" in TOP and "Ctrl K" in TOP)
check("search is the right-hand cluster", TOP.index("justify-between") < TOP.index("openCommandPalette()"))
check("alerts bell in the top bar, once", TOP.count("<AlertsBell />") == 1 and "<AlertsBell />" not in SIDE)
check("bell dropdown opens downward and fits phones",
      "top-11" in BELL and "w-[min(20rem,calc(100vw-2rem))]" in BELL and "bottom-10" not in BELL)
check("phone menu button toggles the drawer", 'aria-expanded={menuOpen}' in TOP and "lg:hidden" in TOP)
check("one header for all sizes", "fixed inset-x-0 top-0" in TOP and "lg:sticky" in TOP)

print("== Ask Omni bubble ==")
check("shell mounts the bubble", "<AskOmniBubble />" in SHELL)
check("fixed bottom-right", "fixed bottom-[" in BUBBLE and "right-4" in BUBBLE and "lg:bottom-6" in BUBBLE)
check("sits above the phone tab bar (safe area aware)", "env(safe-area-inset-bottom)" in BUBBLE)
check("full-screen sheet on phones, 400px panel from sm",
      "fixed inset-0" in BUBBLE and "sm:w-[400px]" in BUBBLE and "100dvh" in BUBBLE)
check("chat code loads on first open only", 'dynamic(() => import("../(portal)/assistant/AssistantClient")' in BUBBLE
      and "ssr: false" in BUBBLE and "{loaded && (" in BUBBLE)
check("closing keeps the chat mounted", 'open ? "flex" : "hidden"' in BUBBLE)
check("Escape closes", 'event.key === "Escape"' in BUBBLE)
check("hidden where a reply box owns the corner", '"/dashboard/conversations"' in BUBBLE and "ASSISTANT_LINK.href" in BUBBLE)
check("accessible toggle", "aria-expanded={open}" in BUBBLE and 'aria-label={open ? "Close Ask Omni" : "Ask Omni"}' in BUBBLE)
check("full page link kept", "href={ASSISTANT_LINK.href}" in BUBBLE)
check("content clears the bubble", "pb-36" in SHELL and "lg:pb-28" in SHELL)
check("assistant has a panel variant", 'variant = "page"' in ASSIST and 'const panel = variant === "panel";' in ASSIST
      and 'id="ask-omni-thread"' in ASSIST and "lg:grid-cols-[240px_1fr]" in ASSIST)
check("one chat body for both variants", ASSIST.count("{chat}") == 2 and ASSIST.count("<textarea") == 1)

print("== command palette ==")
check("every nav page is searchable", "NAV_GROUPS.flatMap(" in PALETTE and "...DASHBOARD_LINK" in PALETTE
      and "...SETTINGS_LINK" in PALETTE and "...ASSISTANT_LINK" in PALETTE)
check("group names are searchable", '(page.sub ?? "").toLowerCase().includes(needle)' in PALETTE)
check("rows show icons", "<PortalIcon" in PALETTE)

print("== global dashboard ==")
widgets = re.findall(r"<([A-Z][A-Za-z]+) token=\{token\} />", PAGE)
check("eleven streamed widgets", len(widgets) == 11, widgets)
check("un-normalised AI/plan/courier payloads read defensively",
      "Array.isArray(ai?.by_category)" in WIDGETS and "ai?.usage?.totals ?? null" in WIDGETS
      and "plans.usage?.[row.key]" in WIDGETS and "Array.isArray(courier?.bookings)" in WIDGETS
      and "ai.by_category.length" not in WIDGETS and "{num(courier.bookings.length)}" not in WIDGETS)
check("cards shrink inside the grid (no phone overflow from long text)",
      '<section className={"min-w-0 rounded-2xl border border-line bg-white p-5 shadow-card " + className}>' in WIDGETS
      and '<span className="min-w-0 truncate text-ink-2">{row.label}</span>' in WIDGETS)
check("top bar actions never shrink off-screen; badge hidden under 360px",
      '<div className="flex shrink-0 items-center gap-2">' in TOP and "min-[360px]:inline-block" in SIDE)
check("each widget has its own Suspense",
      all(re.search(r"<Suspense fallback=\{[^\n]+\}>\s*<" + w + " token", PAGE) for w in widgets))
check("existing cards kept", all(c in PAGE for c in ("<SetupChecklist />", "<DailyBrief />",
                                                       "<OperationsCard />", "<RecoveryCard />")))
check("page titled Dashboard", ">Dashboard</h1>" in PAGE)
getters = sorted(set(re.findall(r"^  (get[A-Za-z]+|list[A-Za-z]+),$", WIDGETS, re.M)))
check("widgets read existing portal getters only",
      getters and all("export async function " + g + "(" in LIB for g in getters), getters)
check("every getter call is fail-soft",
      len(re.findall(r"safe\(\(\) => (?:get|list)", WIDGETS)) == len(re.findall(r"\b(?:get|list)[A-Z][A-Za-z]+\(token", WIDGETS)))
check("overview fetched once per render", "cache((token: string) => safe(() => getOverview(token)))" in WIDGETS
      and WIDGETS.count("getOverview(") == 1)
check("service results unwrap only ok", 'result && result.kind === "ok" ? result.data : null' in WIDGETS)
check("no client fetches on the dashboard widgets", "fetch(" not in WIDGETS and '"use client"' not in WIDGETS)
check("courier label is honest (last shipments)", "Status of your last" in WIDGETS)
check("trend chart is plain SVG with a text alternative", 'role="img"' in WIDGETS and "aria-label={`Messages per day" in WIDGETS)
check("shortcuts built from the nav config", "NAV_GROUPS.map((group)" in PAGE)

print("== icons ==")
check("icon set is a name map, at least 60 icons", len(ICON_NAMES) >= 60, len(ICON_NAMES))
check("decorative icons hidden from screen readers", 'aria-hidden="true"' in ICON and 'focusable="false"' in ICON)
pkg = read(os.path.join(ROOT, "package.json"))
check("icons come from lucide-react, already a dependency (no new lib, D6)",
      '"lucide-react"' in pkg and 'from "lucide-react";' in ICON
      and not any(lib in pkg for lib in ("heroicons", "react-icons", "fontawesome", "@tabler")))
imported = set(re.findall(r"^  ([A-Z][A-Za-z0-9]*),$", ICON[:ICON.index('} from "lucide-react";')], re.M))
mapped = set(re.findall(r"^  [a-zA-Z]+: ([A-Z][A-Za-z0-9]*),$", ICON, re.M))
check("every imported icon is mapped and vice versa", imported == mapped, sorted(imported ^ mapped))
check("only the icon set imports lucide inside the portal",
      not any('from "lucide-react"' in read(os.path.join(b, f))
              for b, _d, fs in os.walk(os.path.join(ROOT, "app/dashboard")) for f in fs
              if f.endswith((".ts", ".tsx")) and f != "PortalIcon.tsx"))
used = set()
for base, _dirs, files in os.walk(os.path.join(ROOT, "app/dashboard")):
    for name in files:
        if name.endswith((".tsx", ".ts")):
            text = read(os.path.join(base, name))
            used |= set(re.findall(r'<PortalIcon\s+name="([a-zA-Z]+)"', text))
            if "IconName" in text:
                used |= set(re.findall(r':\s*"([a-zA-Z]+)",?\s*$', text, re.M)) & (ICON_NAMES | {"__"})
check("every literal icon name exists", used <= ICON_NAMES, sorted(used - ICON_NAMES))
emoji = re.compile("[\u2600-\u27bf\U0001f000-\U0001faff]")
fresh = (NAV, ICON, SIDE, TOP, SHELL, BUBBLE, PALETTE, TABS, PAGE, WIDGETS)
check("no emoji-capable code points in the shell", not any(emoji.search(t) for t in fresh))
check("no escaped glyph icons left in the shell",
      not any(re.search(r'icon: "\\u2', t) for t in fresh))
check("mobile tabs use SVG icons", '<PortalIcon name={tab.icon} className="h-5 w-5" />' in TABS)
for rel, needle in (("rules/page.tsx", "<PortalIcon name={RULE_SET_ICONS[family.ruleSet]"),
                    ("workflows/WorkflowCanvas.tsx", "<PortalIcon name={KIND_ICON[step.kind]} />"),
                    ("insights/InsightsClient.tsx", "<PortalIcon name={trendIcon(topic.trend)}"),
                    ("analytics/AskData.tsx", '<PortalIcon name="pin"'),
                    ("broadcasts/ABTests.tsx", '<PortalIcon name="split"'),
                    ("customers/DuplicatesPanel.tsx", '<PortalIcon name="chevronDown"')):
    check("SVG icon in " + rel, needle in read(os.path.join(PORTAL, rel)))
check("bell and sign-out are SVG", '<PortalIcon name="bell"' in BELL
      and '<PortalIcon name="logout" />' in read(os.path.join(COMP, "SignOutButton.tsx")))

failures = summary("portal_shell")
sys.exit(1 if failures else 0)
