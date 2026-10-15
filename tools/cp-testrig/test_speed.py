"""Structural tests for the speed + away-visibility batch (Phases 106-110)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()
cust_src = portal_page_source("customers")
config_src = open("/tmp/p13/Omniflow/next.config.ts").read()

print("== phase 106: row prefetch off ==")
check("inbox rows no prefetch", 'prefetch={false}\n                className={`block min-w-0 flex-1' in inbox_src)
check("row link intact", "href={`/dashboard/conversations/${item.id}`}" in inbox_src)

print("== phase 107: summary timer ==")
check("60s timer", "}, 60_000);" in inbox_src)
check("30s gone", "}, 30_000);" not in inbox_src)

print("== phase 108: next config ==")
check("poweredByHeader off", "poweredByHeader: false," in config_src)
check("compress on", "compress: true," in config_src)

print("== phase 109: customer prefetch off ==")
check("customer rows no prefetch", "prefetch={false}" in cust_src)
check("row href intact", '"/dashboard/conversations?q=" +' in cust_src)

print("== phase 110: away banner ==")
check("away state", "const [awayActive, setAwayActive] = useState(false);" in detail_src)
check("away fetch", 'fetch("/api/omniflow/portal/business-hours"' in detail_src)
check("away computes closed", "const openNow =\n          day && day.enabled && now >= day.start && now <= day.end;" in detail_src)
check("away banner render", "Away message is active. Customers get an automatic reply until" in detail_src)
check("banner amber", 'className="mt-0.5 text-[10px] font-medium text-amber-600"' in detail_src)
check("cancel guard", "let cancelled = false;" in detail_src and "cancelled = true;" in detail_src)

failures = summary("speed")
sys.exit(1 if failures else 0)
