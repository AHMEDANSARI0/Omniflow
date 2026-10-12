"""§267 portals speed: every route in the client and admin portals paints an
instant shell while its data loads.

Checks (structure only, no database):
  * every directory under app/dashboard/(portal) and app/admin/(panel) that has
    a page.tsx is covered by a loading.tsx - either its own or an ancestor's -
    so a click never shows a blank screen while the server resolves;
  * the shells carry the §267 marker or pre-date it (portal root);
  * the shells render a pulse skeleton and mark the region busy;
  * both portals keep their single request-scoped session call (no duplicate
    auth round trip per page).

Run from this folder: python test_portals_speed_267.py
"""
import os

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(HERE, "..", ".."))

ROOTS = ["app/dashboard/(portal)", "app/admin/(panel)"]


def covered(path_dir, root):
    """True when path_dir or one of its ancestors (down to root) has loading.tsx."""
    d = path_dir
    while True:
        if os.path.isfile(os.path.join(ROOT, d, "loading.tsx")):
            return True
        if os.path.normpath(d) == os.path.normpath(root):
            return False
        d = os.path.dirname(d)


print("== every portal route has a loading shell above it ==")
missing = []
count = 0
for root in ROOTS:
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, root)):
        if "page.tsx" not in filenames:
            continue
        count += 1
        rel = os.path.relpath(dirpath, ROOT)
        if not covered(rel, root):
            missing.append(rel)
check("all %d portal routes are covered by a loading shell" % count, not missing, str(missing))

print("== the new shells ==")
new_shells = [
    "app/admin/(panel)/loading.tsx",
    "app/admin/(panel)/analytics/loading.tsx",
    "app/admin/(panel)/customers/loading.tsx",
    "app/admin/(panel)/settings/loading.tsx",
    "app/dashboard/(portal)/sales/loading.tsx",
    "app/dashboard/(portal)/workflows/loading.tsx",
    "app/dashboard/(portal)/approvals/loading.tsx",
]
for rel in new_shells:
    full = os.path.join(ROOT, rel)
    ok = os.path.isfile(full)
    check("shell present: " + rel, ok, "missing")
    if ok:
        text = open(full, encoding="utf8").read()
        check("shell §267 + skeleton + aria-busy: " + rel,
              "§267" in text and "animate-pulse" in text and 'aria-busy="true"' in text, "content")

print("== one session call per request, no waterfalls added ==")
dal = open(os.path.join(ROOT, "lib/omniflow/auth-dal.ts"), encoding="utf8").read()
check("portal session stays request-cached (React.cache)", "export const getOmniFlowSession = cache(" in dal,
      "cache")
admin_page = open(os.path.join(ROOT, "app/admin/(panel)/page.tsx"), encoding="utf8").read()
check("admin dashboard still fetches its five sources in parallel",
      "await Promise.allSettled([" in admin_page, "parallel")

failures = summary("portals_speed_267")
raise SystemExit(1 if failures else 0)
