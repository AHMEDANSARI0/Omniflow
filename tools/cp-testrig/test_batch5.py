"""Structural tests for the consolidated batch (Phases 87-91)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()
card_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/CustomerCard.tsx").read()

print("== phase 87: unread background ==")
check("unread bg class", '(item.unread ? "bg-cyan-400/[0.03] " : "")' in inbox_src)
check("amber border intact", 'border-l-2 border-l-amber-400/60 ' in inbox_src)
check("ring intact", "ring-1 ring-brand/40" in inbox_src)

print("== phase 88: customer card wa link ==")
check("wa.me link", "https://wa.me/${contactId.replace(/[^0-9]/g, \"\")}" in card_src)
check("link label", "WhatsApp \u2192" in card_src)
check("safe attrs", 'target="_blank"' in card_src and 'rel="noreferrer"' in card_src)
check("all chats kept", "All chats \u2192" in card_src)

print("== phase 89: wide thread ==")
check("2xl width", "mx-auto max-w-3xl 2xl:max-w-5xl" in detail_src)

print("== phase 90: placeholder + tooltip ==")
check("short placeholder", 'placeholder="Reply as a human agent"' in detail_src)
check("long placeholder gone", "Enter to send, Shift+Enter" not in detail_src.split("title=\"Enter sends")[0].split("placeholder")[1] if "placeholder=\"Reply as a human agent\"" in detail_src else False)
check("tooltip present", 'title="Enter sends the reply, Shift+Enter inserts a new line"' in detail_src)

print("== phase 91: esc hint ==")
check("hint rendered", "Press Esc to return to the inbox" in detail_src)
check("hint styled", 'className="mt-0.5 text-[10px] text-ink-3"' in detail_src)

failures = summary("batch5")
sys.exit(1 if failures else 0)
