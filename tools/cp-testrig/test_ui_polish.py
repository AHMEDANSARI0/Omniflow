"""D7 UI polish: design-token contrast, elevated cards (no soft-on-soft),
page hierarchy, icon law (text-presentation only), shell/sidebar readability."""
import os
import re
import sys

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def read(rel):
    path = os.path.join(ROOT, rel)
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


print("== design tokens ==")
CSS = read("app/globals.css")
check("ink-2 darkened for secondary body text",
      "--color-ink-2: #3f4f63;" in CSS, CSS[CSS.find("ink-2"):CSS.find("ink-2") + 40] if "ink-2" in CSS else "-")
check("ink-3 darkened for muted labels",
      "--color-ink-3: #5c6b7c;" in CSS, "-")
check("line borders slightly stronger",
      "--color-line: #d7e0ea;" in CSS and "--color-line-2: #c5d0dc;" in CSS, "-")
check("of-card / of-page helpers present",
      ".of-card {" in CSS and ".of-page-title" in CSS and ".of-section-label" in CSS, "-")
check("card shadow tokens kept",
      "--shadow-card:" in CSS and "--color-surface: #ffffff;" in CSS, "-")


print("== elevated cards ==")
# Spot-check high-traffic surfaces: outer cards are white+shadow, inputs stay soft
AUTO = read("app/dashboard/(portal)/automations/page.tsx")
check("automations empty/section cards elevated",
      "bg-white shadow-card" in AUTO and AUTO.count("bg-white shadow-card") >= 4, "-")
check("automations form inputs stay soft (not elevated)",
      "outline-none" in AUTO and "bg-soft px-3.5" in AUTO
      and "placeholder:text-ink-3" in AUTO or "placeholder-slate" not in AUTO
      or "bg-soft" in AUTO, "-")
OVER = read("app/dashboard/(portal)/page.tsx")
check("overview tiles elevated white",
      "bg-white" in OVER and "shadow-card" in OVER, "-")
check("overview lead uses ink-2 (not washed ink-3)",
      "text-sm text-ink-2" in OVER, "-")
FEAT = read("app/components/Features.tsx")
check("marketing feature mini-cards elevated",
      "bg-white shadow-card" in FEAT, "-")
PS = read("app/components/ProblemSolution.tsx")
check("problem/solution callout elevated + readable",
      "bg-white shadow-card" in PS and "text-ink-2" in PS, "-")

# Count: elevated cards should dominate outer soft containers
elev = soft_outer = 0
pat_elev = re.compile(r"border border-line bg-white shadow-card")
pat_soft = re.compile(r"rounded-(?:2xl|xl2|xl|3xl) border border-line bg-soft")
for root, _ds, files in os.walk(os.path.join(ROOT, "app", "dashboard")):
    for name in files:
        if not name.endswith(".tsx"):
            continue
        text = open(os.path.join(root, name), encoding="utf8").read()
        elev += len(pat_elev.findall(text))
        # ignore form-ish soft
        for m in pat_soft.finditer(text):
            snippet = text[max(0, m.start() - 20):m.end() + 60]
            if any(s in snippet for s in ("outline-none", "placeholder", "w-full", "flex-1")):
                continue
            soft_outer += 1
check("elevated white cards outnumber remaining soft outer blocks",
      elev >= 200 and elev > soft_outer, {"elev": elev, "soft_outer": soft_outer})


print("== icon law ==")
BANNED = (
    "\u25b6", "\u261d", "\u2714", "\u26a1", "\u2699", "\u2709",
    "\u260e", "\u2733", "\u263a", "\u25fc", "\u27a1", "\u270e", "\u2606",
)
hits = []
for rel in (
    "app/dashboard/(portal)/page.tsx",
    "app/dashboard/components/DashSidebar.tsx",
    "app/dashboard/components/MobileTabBar.tsx",
    "app/dashboard/(portal)/conversations/InboxClient.tsx",
    "app/dashboard/(portal)/conversations/[id]/SavedRepliesPicker.tsx",
    "app/dashboard/(portal)/rules/page.tsx",
):
    text = read(rel)
    for ch in BANNED:
        if ch in text:
            hits.append((rel, hex(ord(ch))))
check("dashboard icon law: no emoji-capable glyphs in shell/overview/inbox",
      hits == [], hits)


print("== shell hierarchy ==")
SIDE = read("app/dashboard/components/DashSidebar.tsx")
check("sidebar group labels ink-2 + readable size",
      "text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2" in SIDE, "-")
check("sidebar Portal badge on white",
      "bg-white px-1.5 py-0.5 text-[9px]" in SIDE and "text-ink-2" in SIDE, "-")
MOB = read("app/dashboard/components/MobileTabBar.tsx")
check("mobile tab inactive ink-2; badge white on rose",
      "text-ink-2 active:text-ink" in MOB and "text-white" in MOB and "bg-rose-500" in MOB, "-")
SHELL = read("app/dashboard/components/DashShell.tsx")
check("shell main padding widened on large screens",
      "lg:px-10" in SHELL, "-")


print("== page headers ==")
# sample a few portal pages for ink-2 lead
samples = 0
ok = 0
for root, _ds, files in os.walk(os.path.join(ROOT, "app", "dashboard", "(portal)")):
    for name in files:
        if name != "page.tsx":
            continue
        text = open(os.path.join(root, name), encoding="utf8").read()
        if "text-2xl font-semibold" in text or "text-3xl font-semibold" in text:
            samples += 1
            if "text-sm text-ink-2" in text or "text-ink-2" in text:
                ok += 1
check("most portal page leads use ink-2",
      samples >= 5 and ok >= max(3, samples // 2), {"samples": samples, "ok": ok})


print("== marketing primitives kept ==")
CARD = read("app/components/ui/Card.tsx")
check("ui/Card still white + shadow-card (source of truth)",
      "bg-white shadow-card" in CARD and "of-ring-gradient" in CARD, "-")
BTN = read("app/components/ui/Button.tsx")
check("ui/Button variants intact (primary/secondary/ghost)",
      '"primary"' in BTN and "bg-brand" in BTN and "border-line-2 bg-white" in BTN, "-")


raise SystemExit(1 if summary("ui_polish") else 0)
