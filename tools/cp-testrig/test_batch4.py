"""Structural tests for the consolidated batch (Phases 82-86)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 82: u shortcut ==")
check("guard has u", 'event.key !== "u"' in inbox_src)
check("u handler", 'const next = unreadRef.current ? "" : "1";' in inbox_src)
check("s branch returns", "setStarredFilter(next);\n        void refresh();\n        return;" in inbox_src)
check("modal lists u", ">Toggle unread-only<" in inbox_src)

print("== phase 83: x select ==")
check("guard has x", 'event.key !== "x"' in inbox_src)
check("x toggles selection", "toggleSelected(items[activeRowIndex].id);" in inbox_src)
check("x guarded on range", "if (activeRowIndex >= 0 && activeRowIndex < items.length) {\n          toggleSelected" in inbox_src)
check("modal lists x", ">Select or deselect the highlighted chat<" in inbox_src)

print("== phase 84: send error feedback ==")
check("error state", "const [sendError, setSendError] = useState<string | null>(null);" in detail_src)
check("cleared on success", "setSendError(null);" in detail_src)
check("set on failure", '"The reply did not go through. Check the connection and try again."' in detail_src)
check("error rendered amber", 'className="mb-2 text-[11px] font-medium text-amber-600"' in detail_src)

print("== phase 85: focus refresh ==")
check("focus listener", 'window.addEventListener("focus", onFocus)' in inbox_src)
check("focus respects live mode", "if (liveModeRef.current) void refresh();" in inbox_src)
check("focus cleanup", 'window.removeEventListener("focus", onFocus)' in inbox_src)

print("== phase 86: empty-state clear ==")
check("clear filters button", "onClick={() => resetFilters()}" in inbox_src and "Clear filters\n            </button>" in inbox_src)
check("gated on any filter", "oldestFirst) && (" in inbox_src)
check("hidden while pending", "{!pending &&" in inbox_src)

failures = summary("batch4")
sys.exit(1 if failures else 0)
