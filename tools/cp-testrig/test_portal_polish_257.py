"""§257 portal polish: the customer portal (and the CMS forms that share its
tokens) is light-theme only, every control reads as clickable, and small text
keeps AA contrast on the surfaces it actually sits on.

Pins are structural: the dark-era utility list is banned, the base cursor and
focus rules must stay, and the shell widgets must keep the behaviour the
browser audit checked (palette geometry, alert dropdown, touch targets).
"""
import glob
import os
import re
import sys

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(HERE, "..", ".."))

PORTAL_FILES = glob.glob(ROOT + "/app/dashboard/**/*.tsx", recursive=True)
ADMIN_FILES = glob.glob(ROOT + "/app/admin/**/*.tsx", recursive=True)
COMP = ROOT + "/app/dashboard/components"


def read(path):
    with open(path, encoding="utf8") as handle:
        return handle.read()


def body(files):
    return "\n".join(read(p) for p in files if os.path.exists(p))


PORTAL = PORTAL_FILES + glob.glob(ROOT + "/app/dashboard/*.tsx") + glob.glob(ROOT + "/app/dashboard/*/page.tsx")
CSS = read(ROOT + "/app/globals.css")
PALETTE = read(COMP + "/CommandPalette.tsx")
BELL = read(COMP + "/AlertsBell.tsx")
TOP = read(COMP + "/DashTopbar.tsx")
SIDE = read(COMP + "/DashSidebar.tsx")
BUBBLE = read(COMP + "/AskOmniBubble.tsx")

print("== no dark-theme leftovers in the portal ==")

# classes that only read on a dark canvas; the portal background is white
BANNED = [
    "text-slate-100", "text-slate-200", "text-amber-200", "text-amber-100",
    "text-sky-200", "text-sky-300", "text-violet-200", "text-violet-100",
    "text-rose-200", "text-red-200", "text-indigo-200", "text-warn",
    "bg-white/5", "bg-white/[0.06]", "bg-white/[0.01]", "border-white/[0.12]",
    "border-white/20", "focus:border-white/20", "bg-cyan-400", "accent-cyan-400",
    "text-[#07111f]", "text-brand/70", "text-brand/80", "text-amber-600",
    "text-emerald-600", "bg-rose-500",
]
allPortal = body(PORTAL)
for cls in BANNED:
    check("banned " + cls, cls not in allPortal, "dark leftover")

check("no cyan brand glow left", "rgba(34,211,238" not in body(PORTAL_FILES), "brand")
check("portal icons go through PortalIcon",
      'from "lucide-react"' not in "\n".join(
          read(f) for f in PORTAL_FILES if not f.endswith("PortalIcon.tsx")), "icon law")

print("== admin CMS forms share the light tokens ==")

admin = body(ADMIN_FILES)
for cls in ("placeholder-slate-400", "bg-cyan-400", "text-[#07111f]",
            "bg-white/[0.06]", "bg-slate-500/15", "border-white/[0.16]"):
    check("admin banned " + cls, cls not in admin, "dark leftover")
check("admin inputs use the theme placeholder",
      "placeholder:text-ink-3" in admin, "readable")
check("admin primary buttons are brand", "bg-brand px-6 py-2.5" in admin or "bg-brand px-4 py-2.5" in admin, "brand")

print("== base layer: cursor and focus ==")

base = CSS[CSS.index("@layer base {"):] if "@layer base {" in CSS else ""
check("buttons get a hand cursor", 'button:not(:disabled),' in base and "cursor: pointer" in base, "cursor")
check("role=button and summary included", '[role="button"]:not([aria-disabled="true"])' in base and "summary," in base, "cursor")
check("pickers included", 'input[type="file"]:not(:disabled)::file-selector-button' in base, "cursor")
check("disabled reads as blocked", "cursor: not-allowed" in base, "cursor")
check("keyboard focus ring", re.search(r"a:focus-visible,\s*button:focus-visible", base) is not None and "outline: 2px solid var(--color-brand)" in base, "a11y")

print("== AA tokens ==")

check("ok green is AA on white", "--color-ok: #15803d;" in CSS, "contrast")
check("danger red is AA on its tint", "--color-danger: #b91c1c;" in CSS, "contrast")
check("alert badge keeps white on rose-600",
      "bg-rose-600 px-1 text-[9px] font-semibold text-white" in BELL, "contrast")

print("== search opens as a palette, not a page takeover ==")

check("translucent scrim", "bg-ink/25" in PALETTE and 'bg-soft px-4 pt-[10vh]' not in PALETTE, "overlay")
check("anchored under the top bar", 'pt-[4.5rem] sm:px-6 sm:pt-20 lg:pt-24' in PALETTE, "position")
check("panel is height-capped", "max-h-[min(70vh,34rem)]" in PALETTE and "min-h-0 flex-1 overflow-y-auto" in PALETTE, "size")
check("scroll lock stays", 'document.body.style.overflow = "hidden"' in PALETTE, "lock")
check("selection follows the keyboard",
      'data-active={index === activeIndex ? "true" : undefined}' in PALETTE
      and 'querySelector(\'[data-active="true"]\')' in PALETTE and "block: " in PALETTE, "scroll")
check("focus returns to the trigger", "triggerRef.current?.focus?.();" in PALETTE, "a11y")
check("still closes on overlay click and Esc",
      "onClick={close}" in PALETTE and 'event.key === "Escape"' in PALETTE, "close")

print("== shell affordances ==")

check("search trigger looks pressable",
      'aria-haspopup="dialog"' in TOP and "hover:bg-brand-soft" in TOP, "hover")
check("alerts dropdown closes on outside click and Esc",
      "window.addEventListener(\"pointerdown\", onPointerDown)" in BELL
      and "rootRef.current?.contains(event.target as Node)" in BELL
      and 'event.key === "Escape"' in BELL, "close")
check("bell and menu buttons declare the dialog",
      TOP.count('aria-haspopup="dialog"') + BELL.count('aria-haspopup="dialog"') >= 2
      and "aria-expanded={open}" in BELL, "a11y")
check("sidebar hover is not soft-on-white",
      "hover:bg-line/50" in SIDE and "hover:bg-soft" not in SIDE, "hover")
check("brand mark follows the brand accent",
      "bg-brand shadow-[0_0_12px_rgba(79,70,229,0.45)]" in SIDE
      and "bg-cyan-400" not in SIDE, "brand")
check("Ask Omni bubble answers the hover", "hover:bg-brand-2" in BUBBLE, "hover")

print("== touch targets ==")

grown = 0
for path in PORTAL_FILES:
    src = read(path)
    for m in re.finditer(r"className=(?:\"|`)([^\"`]*py-1(?:\.5)? text-(?:xs|\[1[01]px\])[^\"`]*)", src):
        cls = m.group(1)
        if "min-h-" in cls or "h-9" in cls or "h-10" in cls or "h-11" in cls:
            grown += 1
check("small chips are padded up for phones", grown >= 90, str(grown))
check("chip growth keeps them centred",
      "inline-flex min-h-9 items-center px-3 py-1.5 text-xs" in body(PORTAL_FILES)
      or "inline-flex min-h-8 items-center" in body(PORTAL_FILES), "centre")
check("no chip lost its display pair",
      re.search(r"inline-(?:block|flex)[^\"`]*inline-flex", allPortal) is None, "display")
check("card header links are tappable",
      "-my-2 flex items-center gap-1 rounded-md px-1 py-2 text-xs" in read(ROOT + "/app/dashboard/(portal)/DashboardWidgets.tsx"),
      "tap")

failures = summary("portal_polish_257")
sys.exit(1 if failures else 0)
