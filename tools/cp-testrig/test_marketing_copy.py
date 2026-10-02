"""Tests for batch 218: admin-editable page copy and product mockups.

Eight copy blocks (homepage section copy, mockup sample data, dashboard
preview, inner-page heroes/CTAs, pricing/about/other page copy) are stored
as site_content rows holding only the admin's edits, edited by one editor
whose fields are derived from the defaults' shape, and read by every
consumer through a cached loader that falls back to the code defaults.
Static pins + the functional harness (marketing_copy_harness.cjs).
"""
import glob
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


print("== copy blocks ==")

COPY = read("lib/marketing/copy.ts")
for key in ("home_sections", "home_mockups", "dashboard_preview", "page_heroes", "page_ctas",
            "pricing_page", "about_page", "other_pages"):
    check("block " + key, '  %s: {\n    section: "copy_%s",' % (key, key) in COPY, "schema")
IMPORTS = [line for line in COPY.splitlines() if line.startswith(("import ", "} from"))]
check("copy isomorphic", not any("server" in line or "next/" in line for line in IMPORTS), "no server imports")
check("copy locked keys", 'const LOCKED_KEYS = new Set(["id", "tone"]);' in COPY, "structure stays code")
check("copy one sanitizer", "export function sanitizeCopy<K extends CopyBlockKey>(key: K, raw: unknown): CopyValue<K>" in COPY, "sanitize")
check("copy own-key guard", "Object.prototype.hasOwnProperty.call(COPY_BLOCKS, value)" in COPY, "proto")
check("copy stores only edits", "export function copyOverrides<K extends CopyBlockKey>" in COPY, "overrides")
check("copy hub icons safe glyphs",
      all(g in "◈⑂✶▷◷✓⇄⚑■⁙◉⇉▽" for g in re.findall(r'hubIcon: "(.)"', COPY)) and len(re.findall(r'hubIcon: "', COPY)) == 8,
      "icon law")
FIELDS = read("lib/marketing/fields.ts")
check("fields shared", "export function cleanValue(field: ListField, raw: unknown): unknown" in FIELDS
      and 'from "./fields"' in read("lib/marketing/lists.ts"), "one vocabulary")
check("fields array-aware setPath", "if (Array.isArray(current)) {" in FIELDS, "arrays")

print("== website reads the copy ==")

CMS = read("lib/marketing/cms.ts")
check("getCopy cached", "export const getCopy = cache(" in CMS, "react cache")
check("getCopy validates", "return sanitizeCopy(key, stored);" in CMS, "fallback")

MOVED = ["HERO_SECTION", "TEMPLATES_SECTION", "INTEGRATIONS_SECTION", "STORY_SECTION", "HOW_IT_WORKS_SECTION",
         "LIVE_DEMO_SECTION", "DASHBOARD_SECTION", "MULTI_CHANNEL_DIAGRAM", "WHY_OMNIFLOW_STATES",
         "HERO_VISUAL_CARDS", "STEP_MOCKUP_DATA", "FEATURE_VISUAL_DATA", "CUSTOMER_PROFILE_SAMPLE",
         "DASHBOARD_PREVIEW", "PAGE_HEROES", "PAGE_CTAS", "PRICING_PLANS", "PRICING_FEATURED_LABEL",
         "PRICING_NOTE", "FEATURE_PILLARS", "ABOUT_STORY", "ABOUT_VALUES", "ABOUT_VALUES_HEAD",
         "SECURITY_AREAS", "SECURITY_NOTE", "CONTACT_CARDS", "BLOG_COPY", "USE_CASE_SAMPLES"]
leaks = []
for path in glob.glob(ROOT + "app/**/*.tsx", recursive=True):
    src = open(path, encoding="utf8").read()
    leaks += ["%s:%s" % (path[len(ROOT):], name) for name in MOVED if re.search(r"\b%s\b" % name, src)]
check("no component reads code copy directly", not leaks, ", ".join(leaks[:5]) or "all via getCopy/getMarketingList")

for path, needle in [
    ("app/page.tsx", 'getCopy("home_sections"),'),
    ("app/page.tsx", "<AutomationTemplates templates={templates} copy={homeCopy.templates} />"),
    ("app/components/Hero.tsx", "{home.hero.channelsNote}"),
    ("app/components/hero/HeroVisual.tsx", "const cards = mockups.heroCards;"),
    ("app/components/hero/BotVisualPlaceholder.tsx", 'const hero = (await getCopy("home_sections")).hero;'),
    ("app/components/AIIntelligence.tsx", "const storySection = home.story;"),
    ("app/components/HowItWorks.tsx", 'const section = (await getCopy("home_sections")).howItWorks;'),
    ("app/components/home/StepMockup.tsx", 'const data = (await getCopy("home_mockups")).steps.knowledge;'),
    ("app/components/home/FeatureVisual.tsx", 'const data = (await getCopy("home_mockups")).features.qualification;'),
    ("app/components/home/Integrations.tsx", "const section = home.integrations;"),
    ("app/components/DashboardShowcase.tsx", 'getCopy("dashboard_preview")'),
    ("app/components/CustomerMemory.tsx", 'const profile = (await getCopy("home_mockups")).profile;'),
    ("app/components/MultiChannel.tsx", "const diagram = home.multiChannel;"),
    ("app/components/WhyOmniFlow.tsx", "state: states[index]"),
    ("app/components/UseCases.tsx", 'await getMarketingList("use_case_samples")'),
    ("app/pricing/page.tsx", 'getMarketingList("pricing_plans"),'),
    ("app/features/page.tsx", 'getMarketingList("feature_pillars"),'),
    ("app/about/page.tsx", 'getMarketingList("about_values"),'),
    ("app/security/page.tsx", 'getMarketingList("security_areas"),'),
    ("app/contact/page.tsx", "const cards = pagesCopy.contact;"),
    ("app/blog/page.tsx", "const blogCopy = pagesCopy.blog;"),
    ("app/blog/[slug]/page.tsx", 'getCopy("page_ctas")'),
    ("app/integrations/page.tsx", "const cta = ctas.integrations;"),
    ("app/use-cases/page.tsx", "copy={homeCopy.templates}"),
]:
    check(path.split("/")[-2] + "/" + path.split("/")[-1] + " " + needle[:30], needle in read(path), "wired")
check("live demo copy prop", 'copy: CopyValue<"home_sections">["liveDemo"];' in read("app/components/home/LiveDemo.tsx"), "client prop")
check("layout mappings stay code", "HOW_IT_WORKS_MOCKUPS" in read("app/components/HowItWorks.tsx")
      and "FEATURE_VISUALS" in read("app/components/Features.tsx"), "layout")
check("admin items keyed by index", "<Reveal key={index}" in read("app/pricing/page.tsx")
      and "<Reveal key={index}" in read("app/security/page.tsx"), "duplicate-safe keys")

print("== admin editor ==")

ACT = read("app/admin/(panel)/content/copy/actions.ts")
check("action role gate", "await requireSiteAdmin();" in ACT, "admin only")
check("action key guard", "if (!isCopyBlockKey(key))" in ACT, "key")
check("action stores validated edits", "data = copyOverrides(key, sanitizeCopy(key, raw));" in ACT, "server validation")
check("action reset", 'formData.get("intent") !== "reset"' in ACT, "reset")
check("action revalidates", "await writeSiteContent(supabase, COPY_BLOCKS[key].section, data)" in ACT, "live")
PAGE = read("app/admin/(panel)/content/copy/[block]/page.tsx")
check("page notFound", "if (!isCopyBlockKey(block)) notFound();" in PAGE, "404")
check("page fresh read", '.eq("section", spec.section).maybeSingle()' in PAGE, "fresh")
ED = read("app/admin/(panel)/content/copy/[block]/CopyEditor.tsx")
check("editor derived fields", "copyFields(defaults)" in ED and "<FieldInput" in ED, "fields")
check("editor default placeholder", "placeholder={Array.isArray(fallback)" in ED, "defaults shown")
check("editor no module counters", "useId()" in ED, "hydration")
HUB = read("app/admin/(panel)/content/page.tsx")
check("hub three groups", all(t in HUB for t in ('"Website sections"', '"Lists"', '"Page copy & product mockups"')), "hub")
check("hub copy links", "href: `/admin/content/copy/${key}`," in HUB, "hub")
check("docs updated", "batch 218" in read("docs/MARKETING_SITE.md"), "docs")

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
    out = subprocess.run([node, os.path.join(HERE, "marketing_copy_harness.cjs"), ROOT, ts_mod],
                         capture_output=True, text=True, timeout=120)
    lines = [line for line in out.stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]
    check("harness ran", out.returncode == 0 and len(lines) >= 27, out.stderr[-300:] or "%d cases" % len(lines))
    for line in lines:
        status, _, name = line.partition(" ")
        check("fn " + name[:60], status == "PASS", name)

summary("marketing_copy")
