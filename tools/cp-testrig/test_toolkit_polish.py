"""Structural tests for the conversation toolkit (Phase 40) and relative times (Phase 41)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

detail_src = portal_thread_source()
check("whatsapp link", "wa.me/" in detail_src)
check("copy handler", "function copyNumber()" in detail_src and "navigator.clipboard.writeText" in detail_src)
check("transcript handler", "function downloadTranscript()" in detail_src)
check("transcript blob", 'type: "text/plain;charset=utf-8"' in detail_src)
check("transcript filename", 'link.download = "conversation-" + conversation.id + ".txt"' in detail_src)
check("buttons in header", "onClick={() => downloadTranscript()}" in detail_src and "onClick={() => copyNumber()}" in detail_src and "wa.me/" in detail_src)

inbox_src = portal_page_source("conversations")
check("relative minutes", '"m ago"' in inbox_src)
check("relative hours", '"h ago"' in inbox_src)
check("just now", 'return "just now";' in inbox_src)
check("absolute kept for older", 'day: "numeric",' in inbox_src)

failures = summary("toolkit_polish")
sys.exit(1 if failures else 0)
