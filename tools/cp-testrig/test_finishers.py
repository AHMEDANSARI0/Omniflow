"""Structural tests for the consolidated batch (Phases 67-71)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 67: shortcuts help ==")
check("help state", "const [helpOpen, setHelpOpen] = useState(false);" in inbox_src)
check("question key effect", 'event.key !== "?"' in inbox_src and "setHelpOpen((open) => !open)" in inbox_src)
check("typing guard", "target.isContentEditable" in inbox_src)
check("toolbar question button", 'title="Keyboard shortcuts"' in inbox_src)
check("modal backdrop", 'className="fixed inset-0 z-50 flex items-center justify-center bg-soft p-4"' in inbox_src)
check("modal lists shortcuts", ">j / k<" in inbox_src and ">Enter<" in inbox_src and ">Esc<" in inbox_src)
check("modal dismiss", "Got it\n            </button>" in inbox_src)

print("== phase 68: quick status toggle ==")
check("status helper", "async function toggleConversationStatus(id: number, status: string)" in inbox_src)
check("helper posts bulk", 'action: status === "open" ? "close" : "reopen",' in inbox_src)
check("row toggle button", "void toggleConversationStatus(item.id, item.status)" in inbox_src)
check("toggle labels", '{item.status === "open" ? "Close" : "Reopen"}' in inbox_src)

print("== phase 69: emoji bar ==")
check("emoji bar container", 'className="hidden max-w-[176px] flex-wrap items-end gap-0.5 sm:flex"' in detail_src)
check("emoji list present", "\\u{1F44D}" in detail_src and "\\u{1F44B}" in detail_src)
check("emoji appends to draft", "setDraft((current) => current + emoji)" in detail_src)
check("emoji hidden on phones", "hidden " in detail_src and "sm:flex" in detail_src)

print("== phase 70: tab title ==")
check("title effect", 'document.title = title + " \\u00b7 OmniFlow";' in detail_src)
check("title restored", 'document.title = "OmniFlow";' in detail_src)
check("effect keyed on title", "}, [title]);" in detail_src)

print("== phase 71: freshness stamp ==")
check("synced state", "useState<Date | null>(" in inbox_src and "initialItems ? new Date() : null" in inbox_src)
check("stamp set on refresh", "setSyncedAt(new Date());" in inbox_src)
check("stamp rendered", '"Updated " + syncedAt.toLocaleTimeString()' in inbox_src)

failures = summary("finishers")
sys.exit(1 if failures else 0)
