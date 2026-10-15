"""Structural tests for the consolidated batch (Phases 72-76)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 72: channel dot ==")
check("dot span", "inline-block h-1.5 w-1.5 rounded-full " in inbox_src)
check("whatsapp green", 'item.channel === "whatsapp"' in inbox_src)
check("channel label", "{item.channel}" in inbox_src)
check("waiting label intact", '"waiting " + waitingLabel(item.lastMessageAt)' in inbox_src)

print("== phase 73: char counter ==")
check("counter div", "{draft.length} / 4096" in detail_src)
check("counter desktop only", "hidden shrink-0 flex-col items-end" in detail_src)

print("== phase 74: r a toggles ==")
check("guard widened", 'event.key !== "r" &&' in inbox_src and 'event.key !== "a"' in inbox_src)
check("r toggle reply", 'const next = replyFilterRef.current ? "" : "1";' in inbox_src)
check("a toggle assigned", 'const next = assignedRef.current === "me" ? "" : "me";' in inbox_src)
check("enter branch returns first", 'void router.push("/dashboard/conversations/" + items[activeRowIndex].id);\n        return;' in inbox_src)
check("modal lists r", ">Toggle the needs-reply view<" in inbox_src)
check("modal lists a", ">Toggle assigned-to-me<" in inbox_src)

print("== phase 75: copy number ==")
check("copy handler on row", "void navigator.clipboard.writeText(item.contactId ?? \"\")" in inbox_src)
check("copy title", 'title="Copy number"' in inbox_src)
check("dash fallback kept", "\u2014" in inbox_src)

print("== phase 76: match count ==")
check("count rendered", "{threadMessages.length}" in detail_src)
check("singular plural", '"match" : "matches"' in detail_src)
check("gated on query", "{threadQuery.trim() && (" in detail_src)

failures = summary("batch2")
sys.exit(1 if failures else 0)
