"""§258 marketing website polish: the public site (homepage, inner pages,
public store + order summary, website chat widget) keeps AA contrast on every
surface, every control shows a hand cursor and real hover feedback, the
navbar marks the current page and its mobile sheet closes on an outside tap,
the chat widget is a proper sheet on phones, and CMS-driven brand fills pick
a readable ink instead of assuming white.

Pins are structural: banned light-on-light utility classes, the deep gradient
for white-on-fill elements, behaviour hooks in the interactive components, and
the readableInk() contract (executed with node --experimental-strip-types).
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
    with open(path, encoding="utf8") as handle:
        return handle.read()


# every public marketing surface: components + inner pages + public flows
MKT_FILES = (
    glob.glob(ROOT + "/app/components/**/*.tsx", recursive=True)
    + glob.glob(ROOT + "/app/components/*.tsx")
    + glob.glob(ROOT + "/app/about/*.tsx")
    + glob.glob(ROOT + "/app/blog/**/*.tsx", recursive=True)
    + glob.glob(ROOT + "/app/blog/*.tsx")
    + glob.glob(ROOT + "/app/contact/*.tsx")
    + glob.glob(ROOT + "/app/faq/*.tsx")
    + glob.glob(ROOT + "/app/features/*.tsx")
    + glob.glob(ROOT + "/app/integrations/*.tsx")
    + glob.glob(ROOT + "/app/pricing/*.tsx")
    + glob.glob(ROOT + "/app/privacy/*.tsx")
    + glob.glob(ROOT + "/app/security/*.tsx")
    + glob.glob(ROOT + "/app/terms/*.tsx")
    + glob.glob(ROOT + "/app/use-cases/*.tsx")
    + glob.glob(ROOT + "/app/store/**/*.tsx", recursive=True)
    + glob.glob(ROOT + "/app/c/**/*.tsx", recursive=True)
    + [ROOT + "/app/page.tsx", ROOT + "/app/layout.tsx"]
)
MKT_FILES = sorted(set(MKT_FILES))
# the chat widget is an intentional dark surface - its leftovers are allowed
# there and checked separately below
LIGHT_FILES = [f for f in MKT_FILES if not f.endswith("WebsiteChatWidget.tsx")]
LIGHT = "\n".join(read(f) for f in LIGHT_FILES if os.path.exists(f))
CSS = read(ROOT + "/app/globals.css")
NAV = read(ROOT + "/app/components/Navbar.tsx")
WIDGET = read(ROOT + "/app/components/WebsiteChatWidget.tsx")
SELFSERVE = read(ROOT + "/app/c/[token]/SelfServe.tsx")
PAYGATE = read(ROOT + "/app/c/[token]/PayGate.tsx")
CHECKOUT = read(ROOT + "/app/c/[token]/page.tsx")
STORE = read(ROOT + "/app/store/[slug]/page.tsx")
STOREORDER = read(ROOT + "/app/store/[slug]/StoreOrder.tsx")
MULTICHANNEL = read(ROOT + "/app/components/MultiChannel.tsx")
CARD = read(ROOT + "/app/components/ui/IntegrationCard.tsx")
FOOTER = read(ROOT + "/app/components/Footer.tsx")
FAQ = read(ROOT + "/app/components/FAQ.tsx")
COLOR = ROOT + "/lib/marketing/color.ts"

print("== no light-on-light or faded text on the marketing site ==")

# light-100..300 text utilities only read on dark canvases; the marketing
# site is light-first, so none of them may appear outside the chat widget
BANNED_TEXT = [
    "text-rose-100", "text-rose-200", "text-rose-300",
    "text-emerald-100", "text-emerald-200", "text-emerald-300",
    "text-cyan-100", "text-cyan-200", "text-cyan-300",
    "text-amber-100", "text-amber-200", "text-amber-300",
    "text-sky-100", "text-sky-200", "text-sky-300",
    "text-violet-100", "text-violet-200", "text-violet-300",
    "text-indigo-100", "text-indigo-200", "text-indigo-300",
    "text-slate-100", "text-slate-200", "text-slate-300",
    "text-gray-100", "text-gray-200", "text-gray-300",
    "text-green-100", "text-green-200", "text-green-300",
]
for cls in BANNED_TEXT:
    check("banned " + cls, cls not in LIGHT, "light-on-light")

# faded brand text on light canvas (eyeбыrows, captions)
for cls in ("text-brand/70", "text-brand/80", "text-brand/60", "text-brand/50"):
    check("banned " + cls, cls not in LIGHT, "faded brand")

# raw tailwind status colours that miss AA on the soft tints
for cls in ("text-amber-600", "bg-cyan-400", "bg-emerald-400", "border-emerald-400",
            "border-rose-400", "bg-rose-400", "text-emerald-100", "text-rose-200",
            "hover:bg-white/[0.06]", "bg-cyan-400/[", "bg-emerald-400/[",
            "border-cyan-400", "border-rose-400/20 bg-rose-400"):
    check("banned " + cls, cls not in LIGHT, "status leftover")

# placeholder must stay readable
check("no placeholder-slate", "placeholder-slate" not in LIGHT, "placeholder")

print("== the deep gradient carries white text ==")

check("of-gradient-deep defined", ".of-site .of-gradient-deep" in CSS, "css")
check("workflow action chips are dark glass", "bg-black/20 px-2.5 py-1" in MULTICHANNEL, "contrast")
check("no white-on-gradient chips left", "bg-white/15 px-2.5 py-1" not in MULTICHANNEL, "contrast")
check("of-gradient-deep stops", "#4f46e5 0%, #4338ca 55%, #5b21b6 100%" in CSS, "css")
# every marketing element that paints white text on a gradient fill uses the
# deep variant - the bright one measured 4.1:1 mean, the deep one clears 4.5:1
# on every stop
WHITE_ON_FILL = [
    (ROOT + "/app/components/HowItWorks.tsx", "of-gradient-deep", "text-white"),
    (ROOT + "/app/components/CustomerMemory.tsx", "of-gradient-deep", "text-white"),
    (ROOT + "/app/components/ProblemSolution.tsx", "of-gradient-deep", "text-white"),
    (ROOT + "/app/components/home/LiveDemo.tsx", "of-gradient-deep", "text-white"),
    (ROOT + "/app/components/ui/WorkflowNode.tsx", "of-gradient-deep", "text-white"),
    (ROOT + "/app/contact/page.tsx", "of-gradient-deep", "text-white"),
    (MKT_FILES and ROOT + "/app/components/MultiChannel.tsx", "of-gradient-deep", "text-white"),
]
for path, deep, white in WHITE_ON_FILL:
    src = read(path)
    check("deep fill in " + path.rsplit("/", 1)[-1], deep in src, "contrast")
    # no bright gradient left next to white text in the same file
    for m in re.finditer(r'className="([^"]*of-gradient[^" ]*[^"]*)"', src):
        cls = m.group(1)
        if "of-gradient-deep" in cls:
            continue
        line_start = src.rfind("\n", 0, m.start())
        window = src[line_start:m.end() + 400]
        check("no bright gradient + white text in " + path.rsplit("/", 1)[-1],
              not ("of-gradient " in cls and "text-white" in window), "contrast")

print("== readable ink for CMS-driven fills ==")

check("readableInk exported", "export function readableInk" in read(COLOR), "helper")
check("relativeLuminance exported", "export function relativeLuminance" in read(COLOR), "helper")
check("logo tile picks ink from accent",
      "readableInk(integration.accent)" in CARD and "text-white" not in CARD.split("IntegrationLogo")[1].split("}")[0],
      "contrast")
check("widget launcher picks ink from accent",
      "color: readableInk(config.accent)" in WIDGET, "contrast")
check("widget send button picks ink from accent",
      "color: readableInk(config.accent)" in WIDGET and "backgroundColor: config.accent" in WIDGET,
      "contrast")

# execute the helper against every shipped integration accent
try:
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e",
         "import(%s).then(m => {" % repr("file://" + COLOR).replace("'", '"', 0) +
         "const cases = %s;" % str([
             ["#25D366", "#0b1220"], ["#E1306C", "#0b1220"], ["#229ED9", "#0b1220"],
             ["#635BFF", "#ffffff"], ["#0084FF", "#0b1220"], ["#0F766E", "#ffffff"],
             ["#B45309", "#ffffff"], ["#111827", "#ffffff"], ["#FF0000", "#0b1220"],
             ["#0A66C2", "#ffffff"], ["#5E8E3E", "#0b1220"], ["#7F54B3", "#ffffff"],
             ["#0F9D58", "#0b1220"], ["#EA4335", "#0b1220"], ["#611F69", "#ffffff"],
             ["#0EA5E9", "#0b1220"], ["#475467", "#ffffff"], ["#101828", "#ffffff"],
             ["#fff", "#0b1220"], ["#000", "#ffffff"],
         ]) +
         "let bad = 0;" +
         "for (const [fill, want] of cases) { if (m.readableInk(fill) !== want) bad++; }" +
         "if (m.readableInk('nope') !== '#ffffff' || m.readableInk('') !== '#ffffff'"
         " || m.readableInk(null) !== '#ffffff') bad++;" +
         "console.log(bad === 0 ? 'OK' : 'BAD:' + bad);" +
         "})"],
        capture_output=True, text=True, timeout=60,
    )
    out = proc.stdout + proc.stderr
    check("readableInk picks the readable side for every accent",
          "OK" in out and "BAD" not in out, "contrast")
except Exception as exc:  # node missing in a minimal env - pin the contract instead
    check("readableInk picks the readable side for every accent", False, "node: " + str(exc)[:60])

print("== hover feedback on every marketing control ==")

# no control may be hover-dead: each interactive element either changes
# itself on :hover or is covered by a group-hover from a .group ancestor
def hover_dead(src, name):
    for m in re.finditer(r"<(a|button|summary)\b[^>]*?className=(?:\"([^\"]*)\"|\{`([^`]*)`\})", src, re.S):
        cls = m.group(2) or m.group(3) or ""
        if "sr-only" in cls:
            continue
        if "hover:" in cls or "group-hover" in cls:
            continue
        line = src[:m.start()].count("\n") + 1
        return f"{name}:{line} <{m.group(1)}> {cls[:60]}"
    return None

for path in LIGHT_FILES:
    if not os.path.exists(path):
        continue
    src = read(path)
    dead = hover_dead(src, path.replace(ROOT + "/", ""))
    check("hover feedback in " + path.replace(ROOT + "/", ""), dead is None,
          "hover-dead: " + (dead or ""))

# the specific behaviours the browser audit measured
check("navbar logo link has hover", "hover:opacity-80" in NAV, "hover")
check("navbar login link has hover", "hover:bg-white/80 hover:text-brand" in NAV, "hover")
check("navbar mobile primary has hover", "hover:bg-brand-2" in NAV, "hover")
check("navbar mobile login has hover", "hover:bg-canvas" in NAV, "hover")
check("FAQ summary has hover", "hover:bg-soft/60" in FAQ, "hover")
check("footer links have hover + underline",
      "hover:text-brand hover:underline hover:underline-offset-4" in FOOTER, "hover")
check("footer socials have hover fill", "hover:bg-brand-soft hover:text-brand" in FOOTER, "hover")
check("widget close button has hover fill", "hover:bg-white/10 hover:text-white" in WIDGET, "hover")
check("widget send button has hover", "hover:brightness-110" in WIDGET, "hover")
check("widget input has hover", "hover:border-white/15" in WIDGET, "hover")
check("SelfServe buttons have hover",
      SELFSERVE.count("hover:bg-brand/15") >= 2 and SELFSERVE.count("hover:bg-line/50") >= 4,
      "hover")
check("StoreOrder cancel has hover", "hover:bg-line/50" in STOREORDER, "hover")
check("checkout powered-by has hover", "hover:text-ink hover:underline" in CHECKOUT, "hover")

# active filter tabs keep feedback (selected state used to be hover-dead)
TPL = read(ROOT + "/app/components/home/AutomationTemplates.tsx")
check("active template tab has hover", "hover:bg-brand-2" in TPL, "hover")
DEMO = read(ROOT + "/app/components/home/LiveDemo.tsx")
check("selected demo tab has hover", "hover:border-brand/50" in DEMO, "hover")
check("active nav link has hover", "hover:bg-soft" in NAV, "hover")
check("active mobile nav link has hover", "hover:bg-brand/15" in NAV, "hover")

# no-op hovers: hover must not repeat the element's own base value
def noop_hovers(src):
    bad = []
    for m in re.finditer(r'className=(?:"([^"]*)"|\{`([^`]*)`\})', src):
        cls = (m.group(1) or m.group(2) or "")
        base_bg = set(re.findall(r"(?<!hover:)\b(bg-[\w\[\]/.0-9-]+)", cls))
        base_text = set(re.findall(r"(?<!hover:)\b(text-[\w\[\]/.0-9-]+)", cls))
        for h in re.findall(r"hover:(bg-[\w\[\]/.0-9-]+)", cls):
            if h in base_bg:
                bad.append(h)
        for h in re.findall(r"hover:(text-[\w\[\]/.0-9-]+)", cls):
            if h in base_text:
                bad.append(h)
    return bad

for path in LIGHT_FILES:
    if not os.path.exists(path):
        continue
    bad = noop_hovers(read(path))
    check("no no-op hover in " + path.replace(ROOT + "/", ""), not bad,
          "noop: " + ",".join(bad[:3]))

print("== navbar behaviour ==")

check("navbar marks current page", NAV.count("aria-current={active ? \"page\" : undefined}") == 2, "a11y")
check("navbar active pill styled (desktop + mobile)",
      "bg-white text-ink shadow-[0_1px_2px_rgba(16,24,40,0.06)] hover:bg-soft" in NAV
      and "bg-brand-soft text-brand-2 hover:bg-brand/15" in NAV, "a11y")
check("navbar matches href not label", "pathname.startsWith(href + \"/\")" in NAV, "a11y")
check("navbar sheet closes on outside pointerdown",
      'window.addEventListener("pointerdown", onPointerDown, true);' in NAV
      and "rootRef.current && !rootRef.current.contains" in NAV, "behaviour")
check("navbar keeps Escape close", '"Escape"' in NAV, "behaviour")
check("navbar toggle is a 44px target", "h-11 w-11" in NAV, "touch")

print("== chat widget is a proper sheet ==")

check("mobile panel clears navbar and launcher",
      "top-20 bottom-[calc(6rem+env(safe-area-inset-bottom))]" in WIDGET, "layout")
check("desktop panel keeps fixed size", "sm:h-[540px] sm:w-96" in WIDGET, "layout")
check("launcher honours safe area",
      "bottom-[calc(1.25rem+env(safe-area-inset-bottom))]" in WIDGET, "layout")
check("launcher exposes expanded state", "aria-expanded={open}" in WIDGET, "a11y")
check("Escape closes the panel", 'event.key === "Escape"' in WIDGET, "behaviour")
check("focus moves to composer on open", "inputRef.current?.focus()" in WIDGET, "behaviour")
check("close returns focus to launcher", "launcherRef.current?.focus()" in WIDGET, "behaviour")
check("timestamps readable on dark", "text-slate-400" in WIDGET and "text-slate-500" not in WIDGET,
      "contrast")
check("placeholder readable on dark", "placeholder-slate-500" in WIDGET
      and "placeholder-slate-600" not in WIDGET, "contrast")
check("widget uses lucide icons", 'from "lucide-react"' in WIDGET
      and "MessageCircle" in WIDGET, "icon law")
check("widget launcher is a lucide bubble", '<MessageCircle className="h-5 w-5" aria-hidden />' in WIDGET, "icon law")
check("widget send button ink follows the accent", WIDGET.count("color: readableInk(config.accent)") == 2, "contrast")

print("== icon law: no dingbat glyphs on the marketing site ==")

GLYPHS = re.compile(r"[\u2600-\u27BF\u2B50\uFE0F\u25C6\u25C7]")
for path in MKT_FILES:
    if not os.path.exists(path):
        continue
    src = read(path)
    own = []
    for m in re.finditer(r">([^<{}]*)<", src):
        if GLYPHS.search(m.group(1)):
            own.append(m.group(1).strip()[:20])
    check("no glyph text in " + path.replace(ROOT + "/", ""), not own,
          "glyphs: " + ",".join(own[:3]))

print("== public store + checkout pages ==")

check("store eyebrow full brand", 'tracking-[0.2em] text-brand">' in STORE, "contrast")
check("store placeholder is a lucide icon", "ImageIcon" in STORE, "icon law")
check("store order button is brand primary",
      STOREORDER.count("min-h-11 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-white") == 2,
      "consistency")
check("store success note uses ok tokens", "border-ok/20 bg-ok-soft" in STOREORDER, "contrast")
check("store inputs are 44px", STOREORDER.count("min-h-11 w-full") == 2, "touch")

check("checkout eyebrow full brand", 'tracking-[0.2em] text-brand">' in CHECKOUT, "contrast")
check("checkout step pills use ok tokens", "border-ok/20 bg-ok-soft text-ok" in CHECKOUT, "contrast")
check("checkout discount uses danger tokens", "border-danger/20 bg-danger-soft" in CHECKOUT
      and "text-danger" in CHECKOUT, "contrast")
check("checkout due label readable", "text-ok\">\n              Due on delivery" in CHECKOUT, "contrast")
check("checkout coupon uses brand tokens", "border-brand/15 bg-brand-soft" in CHECKOUT, "consistency")
check("checkout paid banner uses ok tokens", "border-ok/20 bg-ok-soft px-4 py-2.5" in CHECKOUT, "contrast")
check("self-serve hides on settled orders", "if (!open) return null" in SELFSERVE, "bugfix")
check("self-serve cancel uses danger tokens", "border-danger/20 bg-danger-soft" in SELFSERVE, "contrast")
check("self-serve close is a lucide icon", '<X className="h-3.5 w-3.5" aria-hidden />' in SELFSERVE, "icon law")
check("self-serve buttons are 40px", SELFSERVE.count("min-h-10") >= 10, "touch")
check("paygate pay button is brand primary",
      "min-h-12 rounded-xl bg-brand px-4 py-3" in PAYGATE, "consistency")
check("paygate verify buttons have hover", PAYGATE.count("hover:bg-brand/15") == 2, "hover")

print("== touch targets (24px WCAG minimum on phones) ==")

check("footer links padded to 24px", "-my-1 inline-block rounded py-1" in FOOTER, "touch")
check("navbar logo padded to 40px", "-my-1 shrink-0 rounded-lg py-1" in NAV, "touch")
check("filter tabs are 44px", "h-11 rounded-full border px-4" in TPL, "touch")
check("demo tabs are 44px", "h-11 items-center gap-2 rounded-full" in DEMO, "touch")
check("widget close is 40px", "h-10 w-10 shrink-0" in WIDGET, "touch")
check("widget send is 40px", "min-h-10 shrink-0 rounded-xl border" in WIDGET, "touch")

print("== dead dark-section code removed ==")

LOGO_SRC = read(ROOT + "/app/components/ui/Logo.tsx")
check("Logo dark prop removed",
      "dark?: boolean" not in LOGO_SRC and "dark = false" not in LOGO_SRC
      and "text-indigo-300" not in LOGO_SRC and "text-snow" not in LOGO_SRC, "dead code")
SECTION_SRC = read(ROOT + "/app/components/ui/Section.tsx")
TONES_BLOCK = SECTION_SRC.split("const TONES")[1].split("};")[0]
check("Section dark prop + night/gradient tones removed",
      "dark?: boolean" not in SECTION_SRC and "dark = false" not in SECTION_SRC
      and '"night"' not in TONES_BLOCK and '"gradient"' not in TONES_BLOCK
      and "text-indigo-200" not in SECTION_SRC and "text-snow" not in SECTION_SRC
      and "text-night-muted" not in SECTION_SRC, "dead code")
check("Button dark variants removed",
      '"night-outline"' not in read(ROOT + "/app/components/ui/Button.tsx")
      and '"dark"' not in read(ROOT + "/app/components/ui/Button.tsx"), "dead code")
check("Badge night tone removed",
      '"night"' not in read(ROOT + "/app/components/ui/Badge.tsx"), "dead code")

print("== focus and motion ==")

check("base layer rings form fields",
      "input:focus-visible" in CSS and "textarea:focus-visible" in CSS
      and "select:focus-visible" in CSS, "a11y")
check("site focus rule keeps the element radius",
      ".of-site :focus-visible {\n  outline: 2px solid var(--color-primary);\n  outline-offset: 2px;\n}" in CSS,
      "a11y")
check("reduced motion stops every loop",
      ".of-float," in CSS and ".of-orb-c {" in CSS and "animation: none;" in CSS,
      "motion")
check("reduced motion shows reveals instantly",
      "html.of-js .of-reveal:not(.of-reveal-in) {\n    opacity: 1;\n    transform: none;\n    transition: none;\n  }" in CSS,
      "motion")

print("== cursor (base layer, §257) still covers marketing controls ==")

check("button cursor rule present", "button:not(:disabled)," in CSS, "cursor")
check("summary cursor rule present", "summary," in CSS, "cursor")

failures = summary("marketing_polish_258")
sys.exit(1 if failures else 0)
