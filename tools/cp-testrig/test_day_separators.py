"""Structural tests for thread day separators (Phase 45)."""
import sys

import test_lib
from test_lib import check, summary, portal_thread_source

page_src = portal_thread_source()

check("fragment imported", "Fragment," in page_src and 'from "react";' in page_src)
check("thread list computed", "const threadMessages: ConversationMessage[] = visibleMessages ?? messages ?? [];" in page_src)
check("day label fn", "const threadDayLabel = (index: number): string | null => {" in page_src)
check("today label", 'return "Today";' in page_src)
check("yesterday label", 'return "Yesterday";' in page_src)
check("date fallback", 'day: "numeric", month: "short"' in page_src)
check("map with index", "threadMessages.map((message, index) => (" in page_src)
check("fragment wraps message", "<Fragment key={message.id}>" in page_src)
check("divider pill rendered", "{threadDayLabel(index) && (" in page_src)
check("fragment closed", "</Fragment>" in page_src)

failures = summary("day_separators")
sys.exit(1 if failures else 0)
