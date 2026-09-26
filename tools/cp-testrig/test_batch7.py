"""Structural tests for the consolidated batch (Phases 97-100)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 97: quote reply ==")
check("double click handler", "onDoubleClick={() =>" in detail_src)
check("quote prefix", '"> " +' in detail_src)
check("multiline quote", 'message.body.replace(/\\n/g, "\\n> ")' in detail_src)
check("tooltip", 'title="Double-click to quote this message in your reply"' in detail_src)

print("== phase 98: density ==")
check("compact state", "const [compactList, setCompactList] = useState(false);" in inbox_src)
check("density persisted", 'window.localStorage.setItem("ofl_density", compactList ? "compact" : "cozy")' in inbox_src)
check("density restored", 'window.localStorage.getItem("ofl_density") === "compact"' in inbox_src)
check("row padding conditional", '{compactList ? "p-2.5" : "p-4"}' in inbox_src)
check("toggle label", '{compactList ? "Compact" : "Cozy"}' in inbox_src)

print("== phase 99: sticky day pills ==")
check("sticky wrapper", 'className="sticky top-[4.25rem] z-10 flex justify-center"' in detail_src)
check("solid pill bg", 'border-line bg-canvas px-3 py-1 text-[10px] font-medium uppercase' in detail_src)
check("day label intact", "{threadDayLabel(index)}" in detail_src)

print("== phase 100: chat csv ==")
check("csv handler", "function exportThreadCsv()" in detail_src)
check("csv filename", '"omniflow-conversation-" + id + ".csv"' in detail_src)
check("csv headers", '"created_at,direction,intent,body"' in detail_src)
check("csv button", "onClick={() => exportThreadCsv()}" in detail_src)
check("transcript kept", "onClick={() => downloadTranscript()}" in detail_src)

failures = summary("batch7")
sys.exit(1 if failures else 0)
