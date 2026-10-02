"""Tests for the redesign P1: the centralized light design system.

Tokens live in globals.css (@theme), primitives live in
app/components/ui, the navbar is a floating scroll-reactive surface,
the footer is a light CMS-driven shell pointing at real routes, and
PageShell wraps every marketing page.
"""
import json

import test_lib
from test_lib import check, summary

ROOT = "/tmp/p13/Omniflow/"


def read(path):
    return open(ROOT + path, encoding="utf8").read()


GLOBALS = read("app/globals.css")

print("== design tokens ==")

for token, value in [
    ("--color-canvas", "#f8fafc"),
    ("--color-ink", "#0b1220"),
    ("--color-brand", "#4f46e5"),
    ("--color-ai", "#7c3aed"),
    ("--color-flow", "#06b6d4"),
    ("--color-night", "#080d18"),
    ("--color-ok", "#16a34a"),
]:
    check("token " + token, token + ": " + value in GLOBALS, token)

check("dark foundation gone", "--background: #07111f" not in GLOBALS,
      "flipped")
check("gradient signature", "linear-gradient(\n    135deg,\n    #4f46e5"
      in GLOBALS.replace(" ", " "), "gradient")
check("hero glow helper", ".of-hero-glow" in GLOBALS, "glow")
check("night glow helper", ".of-night-glow" in GLOBALS, "night")
check("cta gradient helper", ".of-cta-gradient" in GLOBALS, "cta")

print("== pinned era utilities survive ==")

for needle in ("@keyframes of-fade-up", ".of-fade-up {",
               "html.of-js .of-reveal:not(.of-reveal-in)",
               "html.of-js .of-reveal.of-reveal-in",
               ".of-reveal.of-lift:hover",
               "-webkit-tap-highlight-color: transparent;",
               "font-size: 16px;"):
    check("kept " + needle[:34], needle in GLOBALS, "pin")

print("== ui primitives ==")

for path, needle in [
    ("app/components/ui/Button.tsx", '"night-outline"'),
    ("app/components/ui/Button.tsx", "shadow-cta hover:bg-brand-2"),
    ("app/components/ui/Badge.tsx", 'tone = "brand"'),
    ("app/components/ui/Card.tsx", "rounded-xl3"),
    ("app/components/ui/Card.tsx", "hoverable"),
    ("app/components/ui/Section.tsx", "export function SectionHead"),
    ("app/components/ui/Section.tsx", 'tone = "white"'),
    ("app/components/ui/Container.tsx", "max-w-6xl"),
    ("app/components/ui/Logo.tsx", "of-gradient"),
]:
    check("primitive " + path.rsplit("/", 1)[-1] + " " + needle[:20],
          needle in read(path), "pin")

print("== navbar (redesign v2) ==")

NAV = read("app/components/Navbar.tsx")
NAVCFG = read("lib/marketing/navigation.ts")
SITE = read("lib/marketing/site.ts")
CSS = read("app/globals.css")
for needle in ("useScrolled(NAVBAR_SCROLL_THRESHOLD)", "NAV_ITEMS.map",
               "NAV_ACTIONS.primary", "aria-expanded={open}",
               "aria-controls={panelId}", '"Escape"', "inert={!open}"):
    check("navbar " + needle[:28], needle in NAV, "pin")
check("navbar no animation lib", "motion/react" not in NAV
      and "AnimatePresence" not in NAV, "css only")
check("navbar threshold constant", "NAVBAR_SCROLL_THRESHOLD = 40" in SITE, "config")
for needle in ('"Platform"', '"Solutions"', '"Integrations"', '"How it works"',
               '"Pricing"', '"Resources"', '"Log in"', '"Start Building"',
               '"/dashboard/login"'):
    check("nav config " + needle, needle in NAVCFG + SITE, "config")
for needle in (".of-nav-bar {", 'data-scrolled="true"', "@keyframes of-nav-enter",
               "backdrop-filter: blur(", ".of-nav-panel[data-open"):
    check("navbar css " + needle[:24], needle in CSS, "css")
check("navbar glassmorphism", "backdrop-filter: blur(20px) saturate(180%);" in CSS
      and "inset 0 1px 0 rgba(255, 255, 255, 0.75)" in CSS, "glass")
check("site clips edge glows", "overflow-x: clip;" in CSS, "mobile overflow")
check("load bounce-up", "@keyframes of-enter" in CSS and "transform: translateY(-8px);" in CSS, "bounce")
check("card scroll rise", "@keyframes of-rise" in CSS and "var(--d, 0ms) backwards" in CSS, "rise")
TPL = read("app/components/home/AutomationTemplates.tsx")
check("templates reveal on scroll", '<Reveal as="li" key={template.id}>' in TPL
      and 'className="of-enter"' not in TPL, "scroll")

print("== footer ==")

FOOT = read("app/components/Footer.tsx")
check("footer config driven", "FOOTER_COLUMNS.map" in FOOT, "config")
for needle in ('href: "/features"', 'href: "/blog"', 'href: "/about"',
               'href: "/privacy"', 'href: "/terms"', 'href: "/contact"',
               'href: "/security"', 'href: "/integrations"'):
    check("footer " + needle[:24], needle in NAVCFG, "pin")
for title in ("Product", "Solutions", "Integrations", "Resources", "Company", "Legal"):
    check("footer column " + title, 'title: "%s"' % title in NAVCFG, "cols")
for needle in ("content.status_label", "content.description",
               '© {new Date().getFullYear()} OmniFlow'):
    check("footer " + needle[:24], needle in FOOT, "pin")

print("== page shell ==")

SHELL = read("app/components/PageShell.tsx")
check("shell navbar+footer", "<Navbar />" in SHELL
      and "<Footer content={footerContent} />" in SHELL, "compose")
check("shell cms footer", 'getSectionContent("footer", FOOTER_DEFAULTS)'
      in SHELL, "cms")
check("shell skip link", 'href="#main"' in SHELL, "a11y")

import os
print("== homepage (redesign v2) ==")

PAGE = read("app/page.tsx")
order = [PAGE.index(marker) for marker in (
    "<Hero content", "<AIIntelligence content", "<ProblemSolution content",
    "<AutomationTemplates />", "<HowItWorks content", "<Integrations />",
    "<Features content", "<CustomerMemory content", "<LiveDemo />",
    "<DashboardShowcase />", "<Trust content", "<FAQ content",
    "<FinalCTA content")]
check("homepage order", order == sorted(order), order)
check("jsonld before navbar", PAGE.index("application/ld+json")
      < PAGE.index("<Navbar />"), "seo")
check("homepage canonical", 'canonical: "/"' in PAGE, "seo")
check("homepage marketing scope", 'className="of-site' in PAGE, "tokens")
check("old dark shell gone", 'bg-[#07111f]' not in PAGE, "light")

HERO = read("app/components/Hero.tsx")
check("hero has no animation lib", "motion/react" not in HERO, "lcp")
check("hero honest channels", "statusForChannel(name)" in HERO
      and "AvailabilityBadge" in HERO, "honesty")
check("hero visual slot", "<HeroVisual />" in HERO, "slot")
check("hero visual asset config", "heroVisualAsset: AIVisualAsset | null" in SITE, "config")
check("workflow animation retired", not os.path.exists(ROOT + "app/components/WorkflowAnimation.tsx"), "removed")

INTEG = read("lib/marketing/integrations.ts")
check("integration statuses honest", 'id: "whatsapp"' in INTEG
      and 'status: "live"' in INTEG and 'status: "beta"' in INTEG
      and 'status: "soon"' in INTEG, "honesty")

SHOW = read("app/components/DashboardShowcase.tsx")
DASH = read("lib/marketing/dashboard.ts")
check("showcase product ui", "DASHBOARD_PREVIEW" in SHOW
      and '"Live conversations"' in DASH and '"Channel status"' in DASH, "ui")
check("showcase sample-data caption", "sample data" in DASH, "honesty")

CTA = read("app/components/FinalCTA.tsx")
check("final cta light", "of-cta-gradient" not in CTA
      and "night-outline" not in CTA, "light")

DEFAULTS = read("lib/content-defaults.ts")
check("hero defaults copy", '"Turn every customer conversation"' in DEFAULTS
      and '"into action."' in DEFAULTS, "copy")
check("ai defaults meet", '"Meet OmniFlow"' in DEFAULTS, "dark head")
check("cta defaults copy", '"Every conversation can become"' in DEFAULTS
      and '"Start Building Free"' in DEFAULTS, "cta")
check("hexgrid retired", "HEX" not in DEFAULTS, "n/a")

import os
check("hexgrid file gone", not os.path.exists(ROOT + "app/components/HexGrid.tsx"), "removed")

print("== redesign patcher ==")

import os
PATCHER = "tools/patchers/add_batch_1271_1300_redesign.mjs"
check("redesign patcher shipped", os.path.exists(ROOT + PATCHER), "patcher")
if os.path.exists(ROOT + PATCHER):
    P_SRC = read(PATCHER)
    check("patcher covers globals", '"app/globals.css"' in P_SRC, "ops")
    check("patcher covers blog", '"lib/blog.ts"' in P_SRC
          and '"app/blog/page.tsx"' in P_SRC, "ops")
    check("patcher covers portal flip", P_SRC.count("writeNewRepair(") >= 150,
          "ops")
    check("patcher backup tag", ".pre_redesign.bak" in P_SRC, "safety")
    check("patcher lucide marker", "lucide-react" in P_SRC, "deps")

HOTFIX = "tools/patchers/add_batch_1271_1300_redesign_hotfix1.mjs"
check("redesign hotfix shipped", os.path.exists(ROOT + HOTFIX), "patcher")
if os.path.exists(ROOT + HOTFIX):
    H_SRC = read(HOTFIX)
    check("hotfix restores session glue", "lib/omniflow/session-cookies.ts" in H_SRC
          and "lib/omniflow/session-constants.ts" in H_SRC, "ops")
    check("hotfix glue closure", H_SRC.count("writeNewRepair(") >= 33, "ops")

FULL = "tools/patchers/add_batch_1301_1310_full_restore.mjs"
check("full restore shipped", os.path.exists(ROOT + FULL), "patcher")
if os.path.exists(ROOT + FULL):
    F_SRC = read(FULL)
    check("full restore covers tree", F_SRC.count("writeNewRepair(") >= 790, "ops")
    check("full restore glue", '"lib/omniflow/request-security.ts"' in F_SRC
          and '"postcss.config.mjs"' in F_SRC
          and '"lib/omniflow/session-cookies.ts"' in F_SRC, "ops")
    check("full restore binary op", "writeBinary(" in F_SRC
          and '"app/favicon.ico"' in F_SRC, "binary")
    check("postcss config at root",
          "@tailwindcss/postcss" in read("postcss.config.mjs"), "tailwind")

print("== inner pages (P3) ==")

import os

PAGES = [
    "app/about/page.tsx", "app/features/page.tsx", "app/use-cases/page.tsx",
    "app/integrations/page.tsx", "app/security/page.tsx",
    "app/pricing/page.tsx", "app/contact/page.tsx", "app/faq/page.tsx",
    "app/privacy/page.tsx", "app/terms/page.tsx", "app/blog/page.tsx",
]
for rel in PAGES:
    check("page " + rel.split("/")[1], os.path.exists(ROOT + rel)
          and "PageShell" in read(rel), "shell")

ARTICLE = read("app/blog/[slug]/page.tsx")
check("article metadata", "generateMetadata" in ARTICLE
      and "notFound()" in ARTICLE, "meta")
check("article jsonld", '"@type": "Article"' in ARTICLE, "schema")
check("article body render", "ArticleBody" in ARTICLE, "body")

BLOG_LIB = read("lib/blog.ts")
check("blog seed fallback", "SEED_POSTS" in BLOG_LIB
      and "blog_posts" in BLOG_LIB, "cms")
check("blog three seeds", BLOG_LIB.count("slug: \"") >= 3, "seeds")

SITEMAP = read("app/sitemap.ts")
check("sitemap routes", '"/about"' in SITEMAP and '"/blog"' in SITEMAP
      and "listPosts" in SITEMAP, "routes")

check("blog sql shipped", os.path.exists(ROOT + "db/blog_posts.sql"), "sql")
ADMIN = read("app/admin/(panel)/content/blog/BlogAdmin.tsx")
check("blog admin editor", "saveBlogPost" in ADMIN
      and "deleteBlogPost" in ADMIN, "cms")
CONTENT_INDEX = read("app/admin/(panel)/content/page.tsx")
check("content index links blog", "/admin/content/blog" in CONTENT_INDEX,
      "link")

PAGEHERO = read("app/components/ui/PageHero.tsx")
check("page hero shared", "of-hero-glow" in PAGEHERO, "hero")

print("== layout ==")

LAYOUT = read("app/layout.tsx")
check("light theme color", 'themeColor: "#F8FAFC"' in LAYOUT, "viewport")
check("fonts kept", 'variable: "--font-inter"' in LAYOUT
      and 'variable: "--font-sora"' in LAYOUT, "fonts")

print("== deps ==")

PKG = json.loads(read("package.json"))
check("lucide installed", "lucide-react" in PKG.get("dependencies", {}),
      "icons")
check("motion kept", "motion" in PKG.get("dependencies", {}), "anim")

summary("design_system")
