"""§256 CMS overrides: section forms store only what differs from the code
defaults, the list editor stores nothing for a default list, and the admin
"Overrides" page shows Stored vs Default with per-field "Use default", a
block / list reset and "Tidy now" (drops pinned values; the page renders the
same). Static pins + the functional harness (overrides_harness.cjs) that runs
the real lib/marketing/overrides.ts.
"""
import os
import re
import shutil
import subprocess
import sys

from test_lib import check, summary

ROOT = "/tmp/p13/Omniflow/"
REPO = "/home/user/Omniflow/"
HERE = os.path.dirname(os.path.abspath(__file__))
CONTENT = "app/admin/(panel)/content/"
SECTIONS = ("ai-intelligence", "customer-memory", "faq", "features", "final-cta", "footer", "hero",
            "how-it-works", "multi-channel", "problem-solution", "trust", "use-cases", "why-omniflow")


def read(path):
    return open(ROOT + path, encoding="utf8").read()


print("== section forms save only the differences ==")
for section in SECTIONS:
    src = read(CONTENT + section + "/actions.ts")
    const = section.upper().replace("-", "_") + "_DEFAULTS"
    check("form " + section + ": sectionOverrides(values, " + const + ")",
          re.search(r"data: sectionOverrides\(values( as Record<string, unknown>)?, " + const + r"\),", src)
          and 'import { sectionOverrides } from "../../../../../lib/marketing/overrides";' in src
          and "data: values" not in src, section)
    imports = [line for line in src.splitlines() if "lib/content-defaults" in line]
    check("form " + section + ": one content-defaults import", len(imports) == 1, imports)

LISTS = read(CONTENT + "lists/actions.ts")
check("list editor: a default list is stored empty",
      "data = sameContent(items, spec.defaults) ? {} : { items };" in LISTS
      and 'import { sameContent } from "../../../../../lib/marketing/overrides";' in LISTS)

print("== overrides page ==")
LIB = read("lib/marketing/overrides.ts")
check("overrides lib is isomorphic (no server / next imports)",
      not any("server" in line or "next/" in line for line in LIB.splitlines() if line.startswith("import ")))
check("tidy only drops pinned values (documented contract)", "the rendered page never changes" in LIB)
ACTIONS = read(CONTENT + "overrides/actions.ts")
check("actions are server actions guarded by requireSiteAdmin",
      ACTIONS.startswith('"use server";') and ACTIONS.count("await requireSiteAdmin()") == 3)
check("actions never redirect inside try/catch", "try {" not in ACTIONS and "function done(result: string): never" in ACTIONS)
check("field reset goes through resetOverride (unknown section / path refused)",
      'if (!overrideSpecs()[section]) done("unknown");' in ACTIONS and 'if (!next) done("unknown");' in ACTIONS)
check("tidy rewrites only rows that change", "if (JSON.stringify(minimal) !== JSON.stringify(row.data ?? {}))" in ACTIONS)
PAGE = read(CONTENT + "overrides/page.tsx")
check("page lists rows via overrideRow, Stored vs Default, three actions",
      all(s in PAGE for s in ("overrideRow(", "resetOverrideField", "resetOverrideRow", "tidyOverrides",
                              "Use default", "Tidy now", "searchParams: Promise<{ done?: string }>")))
check("page shows stored and default side by side", "field.stored" in PAGE and "field.fallback" in PAGE)
BUTTON = read(CONTENT + "overrides/ConfirmButton.tsx")
check("destructive resets ask first (client confirm)",
      BUTTON.startswith('"use client";') and "window.confirm(prompt)" in BUTTON and "event.preventDefault()" in BUTTON)
HUB = read(CONTENT + "page.tsx")
check("content hub links the overrides page", 'href="/admin/content/overrides"' in HUB)
for rel in (CONTENT + "overrides/page.tsx", CONTENT + "overrides/ConfirmButton.tsx", "lib/marketing/overrides.ts"):
    text = read(rel)
    bad = [ch for ch in text if ord(ch) >= 0x1F000 or 0x2600 <= ord(ch) <= 0x27BF]
    check("icon law: " + rel.split("/")[-1], bad == [], bad[:5])

print("== functional (real overrides lib) ==")
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
    out = subprocess.run([node, os.path.join(HERE, "overrides_harness.cjs"), ROOT, ts_mod],
                         capture_output=True, text=True, timeout=120)
    lines = [line for line in out.stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]
    check("harness ran", out.returncode == 0 and len(lines) >= 17, out.stderr[-300:] or "%d cases" % len(lines))
    for line in lines:
        status, _, name = line.partition(" ")
        check("fn " + name[:60], status == "PASS", name)

sys.exit(1 if summary("cms_overrides") else 0)
