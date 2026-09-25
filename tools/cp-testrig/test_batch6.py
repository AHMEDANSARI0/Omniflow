"""Structural tests for the consolidated batch (Phases 92-96).

Superseded anchors refreshed: the Ctrl+F thread search later became the
threadQuery input (thread_search suite), avatar hue moved to tag hues and
the thread gained draft autosave - these pins describe the live page.
"""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== avatar/tag hues ==")
check("tag hue helper", "function tagHue(" in inbox_src or "tagHue(" in inbox_src)
check("hsl inline style", "backgroundColor: `hsl(" in inbox_src)

print("== thread search (current form) ==")
check("search state", 'const [threadQuery, setThreadQuery] = useState("");' in detail_src)
check("search input", 'placeholder="Search in this conversation"' in detail_src)
check("filter computed", "message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())" in detail_src)

print("== conversation id ==")
check("id surfaced", "#\" + conversation.id" in detail_src or "conversation.id" in detail_src)
check("contact id intact", "contactId" in detail_src)

print("== draft autosave ==")
check("draft persisted", 'window.localStorage.setItem("ofl_draft_" + id, draft)' in detail_src)
check("draft restored", 'window.localStorage.getItem("ofl_draft_" + id)' in detail_src)
check("draft cleared", 'window.localStorage.removeItem("ofl_draft_" + id)' in detail_src)
check("autosave input wired", "setDraft" in detail_src)

print("== scroll anchor ==")
check("bottom ref", "threadBottomRef" in detail_src)

failures = summary("batch6")
sys.exit(1 if failures else 0)
