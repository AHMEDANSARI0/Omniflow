"""Structural tests for the consolidated batch (Phases 77-81)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 77: s shortcut ==")
check("guard has s", 'event.key !== "s"' in inbox_src)
check("s handler", 'const next = starredRef.current ? "" : "1";' in inbox_src)
check("a branch returns", "setAssignedFilter(next);\n        void refresh();\n        return;" in inbox_src)
check("modal lists s", ">Toggle the starred view<" in inbox_src)

print("== phase 78: esc closes help ==")
check("escape branch", 'if (event.key === "Escape") {' in inbox_src)
check("closes panel", "setHelpOpen(false);\n        return;" in inbox_src)
check("question key intact", 'if (event.key !== "?") return;' in inbox_src)

print("== phase 79: auto composer ==")
check("composer ref", "const composerRef = useRef<HTMLTextAreaElement | null>(null);" in detail_src)
check("height effect", 'composer.style.height = "auto";' in detail_src)
check("capped height", "Math.min(composer.scrollHeight, 160) + \"px\";" in detail_src)
check("ref attached", "ref={composerRef}" in detail_src)
check("effect keyed on draft", "}, [draft]);" in detail_src)

print("== phase 80: refresh button ==")
check("refresh calls refresh", "onClick={() => void refresh()}" in inbox_src)
check("refresh pending label", '{pending ? "Refreshing" : "Refresh"}' in inbox_src)
check("stamp still rendered", '{syncedAt ? "Updated " + syncedAt.toLocaleTimeString() : ""}' in inbox_src)

print("== phase 81: reply accent ==")
check("amber border", 'border-l-2 border-l-amber-400/60 ' in inbox_src)
check("accent gated", 'item.needsReply && item.status === "open"' in inbox_src)
check("ring intact", "ring-1 ring-brand/40" in inbox_src)

failures = summary("batch3")
sys.exit(1 if failures else 0)
