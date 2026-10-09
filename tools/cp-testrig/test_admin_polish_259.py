"""§259 admin polish: every admin icon is a lucide icon from the shared registry
and matches its section; the sidebar and the dashboard read one nav list; the
dashboard shows only what the website database and the Control Plane return
(each source fails on its own); anything not collected yet is said so; message
text is never shown.

Pins are structural (files, names, banned symbol glyphs, routes). The dashboard
helpers run on fixed inputs with node --experimental-strip-types
(admin_dashboard_harness.mjs), and each of its checks is counted here.
"""
import glob
import os
import re
import subprocess
import sys

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(HERE, "..", ".."))


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf8") as handle:
        return handle.read()


ADMIN_FILES = sorted(glob.glob(ROOT + "/app/admin/**/*.tsx", recursive=True))
ADMIN = "\n".join(open(f, encoding="utf8").read() for f in ADMIN_FILES)
# symbol glyphs the admin used as icons before §259 (not lucide icons)
ICON_GLYPHS = "◈◎✦◇◉◍✶⇄⌘↗⏻☰✕✓⚠◆✎"
ICON_RANGES = re.compile("[\U0001F300-\U0001FAFF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF]")
NAV = read("lib/omniflow/admin-nav.ts")
TYPES = read("lib/marketing/types.ts")
ICON_NAMES = TYPES[TYPES.index("ICON_NAMES = ["):].split("]", 1)[0]
ICON = read("app/components/ui/Icon.tsx")
SIDEBAR = read("app/admin/components/AdminSidebar.tsx")
DASH = read("app/admin/(panel)/page.tsx")
DASHLIB = read("lib/omniflow/admin-dashboard.ts")
CONTENT = read("app/admin/(panel)/content/page.tsx")
LEADS = read("app/admin/(panel)/leads/LeadsTable.tsx")
LISTS = read("lib/marketing/lists.ts")
COPY = read("lib/marketing/copy.ts")

print("== icons: one registry, matched to each section ==")
nav_icons = re.findall(r'icon: "([a-z\-]+)"', NAV)
# §260: the nav has ten sections (Website analytics was added).
check("nav lists ten sections", len(nav_icons) == 10, str(len(nav_icons)))
check(
    "nav icons are the planned set",
    sorted(nav_icons) == sorted(["dashboard", "search", "file", "user-plus", "users",
                                 "plug", "brain", "route", "settings", "chart"]),  # §260 Website
    "section to icon map",
)
check("every nav icon is a registry name", all(('"%s"' % n) in ICON_NAMES for n in nav_icons), "registry")
check("registry has the search icon (SEO)",
      '"search"' in ICON_NAMES and "search: Search," in ICON and "  Search," in ICON, "registry")
hub_names = re.findall(r'hubIcon: "([a-z\-]+)"', LISTS + COPY)
check("hub icons in lists and copy are registry names",
      len(hub_names) == 19 and all(('"%s"' % n) in ICON_NAMES for n in hub_names), str(len(hub_names)))
check("no admin screen uses a symbol glyph as an icon",
      not [ch for ch in ICON_GLYPHS if ch in ADMIN], "glyphs")
check("no emoji or symbol code point left in admin screens",
      ICON_RANGES.search(ADMIN) is None, "icon law")

print("== shared nav: sidebar and dashboard read one list ==")
check("sidebar reads ADMIN_NAV",
      'import { ADMIN_NAV } from "../../../lib/omniflow/admin-nav";' in SIDEBAR
      and "const navItems = ADMIN_NAV;" in SIDEBAR, "one list")
check("sidebar renders registry icons", "<Icon name={item.icon}" in SIDEBAR, "icons")
check("sidebar has no string icon type left", "icon: string" not in SIDEBAR, "types")
check("dashboard sections come from ADMIN_NAV", "ADMIN_NAV.filter" in DASH, "one list")
check("every nav item has a description", len(re.findall(r'description: "', NAV)) == 10, "copy")

print("== dashboard: real sources, each fails on its own ==")
check("sources load with allSettled", "Promise.allSettled([" in DASH, "fail soft")
check("leads come from the website database",
      'supabase.from("leads")' in DASH and '.select("status, created_at")' in DASH, "source")
check("AI overview from the Control Plane helper", "getAdminAiOverview(range)" in DASH, "source")
check("provider status from the Control Plane helper", "getAdminProviders()" in DASH, "source")
check("customer accounts from the Control Plane helper", "listAdminUsers()" in DASH, "source")
check("no client-side fetch on the dashboard", "fetch(" not in DASH, "server render")
check("no new Control Plane route called from the dashboard", "/api/v1/" not in DASH, "scope")
check("range choices are fixed to 7 and 30 days", "const RANGES = [7, 30];" in DASH, "ranges")

print("== honesty: no fake status, no invented figures ==")
check("old hardcoded status claim is gone", "Website is live and running" not in DASH, "honesty")
check("'Not tracked yet' section lists the gaps",
      "Not tracked yet" in DASH and "const NOT_TRACKED" in DASH, "honesty")
check("kill switch wording matches the gate",
      "Kill switch is on, so AI calls are blocked." in DASH, "gate")
check("empty sources show a dash, not zero", 'totals ? String(totals.workspaces) : "—"' in DASH, "no fake zero")

print("== privacy: metadata only ==")
EVENT_FIELDS = set(re.findall(r"\bevent\.(\w+)", DASH))
check("AI activity renders only metadata fields (never the note)",
      EVENT_FIELDS <= {"action", "category", "client_id", "created_at", "id"} and bool(EVENT_FIELDS),
      "privacy: " + ", ".join(sorted(EVENT_FIELDS)))
check("the note field is not read by the helpers", "note" not in DASHLIB, "privacy")

print("== helpers: pure, count-based, no thresholds ==")
check("helpers do no I/O",
      not re.search(r"\bfetch\(|require\(|process\.env|from \"fs\"", DASHLIB), "pure")
body = DASHLIB[DASHLIB.index("export function problemRows"):DASHLIB.index("export function signalLabel")]
check("problem rule compares counts with zero only",
      set(re.findall(r"[<>]=?\s*-?\d+", body)) <= {"> 0"}, "no thresholds")

print("== routes kept: content hub and leads ==")
check("content hub keeps the blog link", '"/admin/content/blog"' in CONTENT, "routes")
check("content hub keeps list and copy routes",
      "/admin/content/lists/${key}" in CONTENT and "/admin/content/copy/${key}" in CONTENT, "routes")
check("leads table keeps the delete label",
      "aria-label={`Delete lead ${lead.name}`}" in LEADS, "a11y")

print("== functional: helpers on fixed inputs (node) ==")
HARNESS = os.path.join(ROOT, "tools", "cp-testrig", "admin_dashboard_harness.mjs")
try:
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", HARNESS],
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("PASS "):
            check(line[5:], True, "")
        elif line.startswith("FAIL "):
            check(line[5:], False, "harness")
    check("harness summary reached with no FAIL",
          "SUMMARY[admin_dashboard_harness]" in proc.stdout and proc.returncode == 0,
          (proc.stderr or proc.stdout)[-160:])
except Exception as exc:  # node missing in a minimal env - the check says so
    check("harness ran", False, "node: " + str(exc)[:80])

failures = summary("admin_polish_259")
sys.exit(1 if failures else 0)
