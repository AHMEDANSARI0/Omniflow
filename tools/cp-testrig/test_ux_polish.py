"""Structural tests for the UX polish batch (Phases 47-50)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source

inbox_src = portal_page_source("conversations")
cust_src = portal_page_source("customers")

print("== phase 47: waiting badges ==")
check("waiting helper", "function waitingLabel(value: string): string {" in inbox_src)
check("waiting minutes branch", 'Math.floor(seconds / 60) + "m";' in inbox_src)
check("waiting conditional class", 'item.needsReply && item.status === "open" && item.lastMessageAt' in inbox_src)
check("waiting label rendered", '"waiting " + waitingLabel(item.lastMessageAt)' in inbox_src)
check("plain time kept", "formatTime(item.lastMessageAt)" in inbox_src)

print("== phase 48: customers toolkit ==")
check("copy handler", "function copyContact(contactId: string)" in cust_src)
check("export customers handler", "function exportCustomers()" in cust_src)
check("customers csv filename", 'link.download = "omniflow-customers.csv";' in cust_src)
check("customers csv headers", '"contact_id",' in cust_src and '"lead_temp",' in cust_src)
check("whatsapp chat action", "wa.me/" in cust_src)
check("copy on contact id", "onClick={() => copyContact(customer.contactId)}" in cust_src)
check("export button", "onClick={() => exportCustomers()}" in cust_src)
check("export disabled empty", "disabled={!customers || customers.length === 0}" in cust_src)

print("== phase 49: reset filters ==")
check("reset fn", "function resetFilters()" in inbox_src)
check("reset clears search", 'searchRef.current = "";' in inbox_src)
check("reset clears starred", 'starredRef.current = "";' in inbox_src)
check("reset refreshes", 'void refresh();' in inbox_src)
check("reset button", "onClick={() => resetFilters()}" in inbox_src)

print("== phase 50: search shortcut ==")
check("input ref state", "const searchInputRef = useRef<HTMLInputElement | null>(null);" in inbox_src)
check("keydown effect", 'window.addEventListener("keydown", onKeyDown)' in inbox_src)
check("slash focuses", 'event.key === "/" && !typing' in inbox_src)
check("escape blurs", 'event.key === "Escape" &&' in inbox_src)
check("ref attached", "ref={searchInputRef}" in inbox_src)
check("cleanup present", 'window.removeEventListener("keydown", onKeyDown)' in inbox_src)

failures = summary("ux_polish")
sys.exit(1 if failures else 0)
