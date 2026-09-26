"""Structural tests for the in-thread search box (Phase 38)."""
import sys

import test_lib
from test_lib import check, summary, portal_thread_source

page_src = portal_thread_source()

check("state added", 'const [threadQuery, setThreadQuery] = useState("");' in page_src)
check("filter computed", "message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())" in page_src)
check("search input", 'placeholder="Search in this conversation"' in page_src)
check("input only when thread has rows", "messages.length > 3 && (" in page_src)
check("map uses filtered list", "threadMessages.map((message, index) => (" in page_src)
check("no-match empty state", "No messages match your search." in page_src)
check("regular empty state kept", "No messages in this conversation yet." in page_src)
check("load older untouched", "Load older messages" in page_src)

failures = summary("thread_search")
sys.exit(1 if failures else 0)
