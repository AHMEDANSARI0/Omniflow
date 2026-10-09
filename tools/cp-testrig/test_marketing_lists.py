"""Tests for batches 217-218: admin-editable marketing lists (hybrid CMS).

Eleven lists (templates, integrations, demo, story, nav, footer, pricing
plans, feature pillars, about values, security areas, use case samples) are stored
as site_content rows, edited by one schema-driven admin editor and read
by the website through a cached loader that validates and falls back to
the lib/marketing defaults. Static pins + the functional harness
(marketing_lists_harness.cjs) that runs the real sanitizer.
"""
import os
import re
import shutil
import subprocess

import test_lib
from test_lib import check, summary

ROOT = "/tmp/p13/Omniflow/"
REPO = "/home/user/Omniflow/"
HERE = os.path.dirname(os.path.abspath(__file__))


def read(path):
    return open(ROOT + path, encoding="utf8").read()


print("== list schema ==")

LISTS = read("lib/marketing/lists.ts")
for key, section in [("templates", "marketing_templates"), ("integrations", "marketing_integrations"),
                     ("demo", "marketing_demo"), ("story", "marketing_story"),
                     ("nav", "marketing_nav"), ("footer", "marketing_footer"),
                     ("pricing_plans", "marketing_pricing_plans"), ("feature_pillars", "marketing_feature_pillars"),
                     ("about_values", "marketing_about_values"), ("security_areas", "marketing_security_areas"),
                     ("use_case_samples", "marketing_use_case_samples")]:
    check("list " + key, '  %s: {\n    section: "%s",' % (key, section) in LISTS, "schema")
FIELDS = read("lib/marketing/fields.ts")
IMPORTS = [line for line in (LISTS + FIELDS).splitlines() if line.startswith("import ")]
check("lists isomorphic", not any("server" in line or "next/" in line for line in IMPORTS), "no server imports")
check("lists one sanitizer", "export function sanitizeList<K extends MarketingListKey>" in LISTS, "sanitize")
check("lists safe href", "export const SAFE_HREF = /^(\\/(?!\\/)|#|https?:\\/\\/|mailto:)/i;" in FIELDS, "href")
check("lists own-key guard", "Object.prototype.hasOwnProperty.call(MARKETING_LISTS, value)" in LISTS, "proto")
check("story fixed count", "fixed: true," in LISTS and "spec.fixed && items.length !== spec.defaults.length" in LISTS, "layout")
TYPES = read("lib/marketing/types.ts")
check("icon names runtime list", "export const ICON_NAMES = [" in TYPES
      and "export type IconName = (typeof ICON_NAMES)[number];" in TYPES, "icons")

print("== website reads the lists ==")

CMS = read("lib/marketing/cms.ts")
check("loader cached", "export const getMarketingList = cache(" in CMS, "react cache")
check("loader site_content", "getSectionContent<{ items: unknown }>(spec.section, { items: null })" in CMS, "tagged read")
check("loader falls back", "items.length ? items : (spec.defaults" in CMS, "defaults")
for path, needle in [
    ("app/page.tsx", 'getMarketingList("templates"),'),
    ("app/page.tsx", "<Navbar items={navItems} />"),
    ("app/page.tsx", "<LiveDemo scenarios={demoScenarios} copy={homeCopy.liveDemo} />"),
    ("app/components/PageShell.tsx", '<Navbar items={await getMarketingList("nav")} />'),
    ("app/use-cases/page.tsx", '<AutomationTemplates templates={await getMarketingList("templates")} copy={homeCopy.templates} />'),
    ("app/components/Footer.tsx", 'groupFooterLinks(await getMarketingList("footer"))'),
    ("app/components/AIIntelligence.tsx", 'getMarketingList("story")'),
    ("app/components/Hero.tsx", "statusForChannel(name, integrations)"),
    ("app/components/MultiChannel.tsx", "statusForChannel(name, integrations)"),
    ("app/components/home/StepMockup.tsx", "statusForChannel(row.name, integrations)"),
    ("app/components/home/FeatureVisual.tsx", 'getMarketingList("integrations")'),
    ("app/components/home/Integrations.tsx", 'getMarketingList("integrations")'),
    ("app/integrations/page.tsx", 'getMarketingList("integrations"),'),
]:
    check(path.split("/")[-2] + "/" + path.split("/")[-1] + " " + needle[:28], needle in read(path), "wired")
TPL = read("app/components/home/AutomationTemplates.tsx")
check("templates prop", "  templates: readonly AutomationTemplate[];" in TPL
      and "AUTOMATION_TEMPLATES" not in TPL, "prop")
check("templates empty tabs hidden", "templates.some((template) => template.category === item.key)" in TPL, "tabs")
DEMO = read("app/components/home/LiveDemo.tsx")
check("demo index guarded", "scenarios[active] ?? scenarios[0]" in DEMO and "DEMO_SCENARIOS" not in DEMO, "guard")
check("navbar default kept", "{ items = NAV_ITEMS }" in read("app/components/Navbar.tsx"), "fallback")

print("== admin editor ==")

ACT = read("app/admin/(panel)/content/lists/actions.ts")
GUARD = read("lib/supabase/site-admin.ts")
check("action role gate", "await requireSiteAdmin();" in ACT and 'if (profile?.role !== "admin")' in GUARD, "admin only")
check("action key guard", "if (!isMarketingListKey(key))" in ACT, "key")
check("action re-sanitizes", "const items = sanitizeList(key, raw);" in ACT, "server validation")
check("action reset", 'formData.get("intent") !== "reset"' in ACT and "let data: { items?: unknown[] } = {};" in ACT, "reset")
check("action revalidates", "await writeSiteContent(supabase, spec.section, data)" in ACT
      and 'revalidateTag("site-content", "max");' in GUARD, "live")
PAGE = read("app/admin/(panel)/content/lists/[list]/page.tsx")
check("page notFound", "if (!isMarketingListKey(list)) notFound();" in PAGE, "404")
check("page fresh read", '.eq("section", spec.section).maybeSingle()' in PAGE, "fresh")
ED = read("app/admin/(panel)/content/lists/[list]/ListEditor.tsx")
check("editor schema driven", "spec.fields.map((field) =>" in ED, "fields")
check("editor add/remove/move", "const add = () =>" in ED and "const remove = (uid: number)" in ED
      and "const move = (index: number, delta: number)" in ED, "ops")
check("editor reset confirm", "<SaveBar" in ED and "window.confirm(" in read("app/admin/(panel)/content/editor-ui.tsx"), "confirm")
HUB = read("app/admin/(panel)/content/page.tsx")
check("hub config driven", "links: Object.entries(MARKETING_LISTS).map(([key, spec]) => ({" in HUB, "hub")
ICON_NAMES = TYPES[TYPES.index("ICON_NAMES = ["):].split("]", 1)[0]
check("hub icons are registry names (§259)",
      all(('"%s"' % n) in ICON_NAMES for n in re.findall(r'hubIcon: "([a-z\-]+)"', LISTS))
      and len(re.findall(r'hubIcon: "', LISTS)) == 11, "icon law")

print("== functional (real sanitizer) ==")

ts_mod = None
for base in (ROOT, REPO):
    candidate = os.path.join(base, "node_modules", "typescript")
    if os.path.isdir(candidate):
        ts_mod = candidate
        break
node = shutil.which("node")
if not (node and ts_mod):
    check("functional harness", True, "skipped: node/typescript not available")
else:
    out = subprocess.run([node, os.path.join(HERE, "marketing_lists_harness.cjs"), ROOT, ts_mod],
                         capture_output=True, text=True, timeout=120)
    lines = [line for line in out.stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]
    check("harness ran", out.returncode == 0 and len(lines) >= 23, out.stderr[-300:] or "%d cases" % len(lines))
    for line in lines:
        status, _, name = line.partition(" ")
        check("fn " + name[:60], status == "PASS", name)

summary("marketing_lists")
