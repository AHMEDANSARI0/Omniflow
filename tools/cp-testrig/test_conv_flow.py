"""Structural tests for the conversation flow batch (Phases 59-62)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

detail_src = portal_thread_source()
inbox_src = portal_page_source("conversations")

print("== phase 59: jump to latest ==")
check("bottom ref state", "const threadBottomRef = useRef<HTMLDivElement | null>(null);" in detail_src)
check("near bottom state", "const [nearBottom, setNearBottom] = useState(true);" in detail_src)
check("scroll listener", 'window.addEventListener("scroll", onScroll, { passive: true })' in detail_src)
check("follow on new messages", "threadBottomRef.current?.scrollIntoView({ block: \"end\" });" in detail_src)
check("sentinel div", '<div ref={threadBottomRef} className="h-px" />' in detail_src)
check("jump button", "Jump to latest" in detail_src)
check("single guard effect", inbox_src.count("warnOnLeave") == 3 or detail_src.count("warnOnLeave") == 3)

print("== phase 60: shareable filter views ==")
check("mount parses status", 'urlFilters.get("status")' in inbox_src)
check("mount parses needs reply", 'urlFilters.get("needs_reply")' in inbox_src)
check("mount parses assigned", 'urlFilters.get("assigned")' in inbox_src)
check("mount parses channel", 'urlFilters.get("channel")' in inbox_src)
check("sync effect writes url", "window.history.replaceState(" in inbox_src)
check("sync keeps sort", 'params.set("sort", "oldest")' in inbox_src)
check("single sync effect", inbox_src.count("window.history.replaceState(") == 1)

print("== phase 61: keyboard navigation ==")
check("router imported", 'import { useRouter } from "next/navigation";' in inbox_src)
check("router instance", "const router = useRouter();" in inbox_src)
check("active row state", "const [activeRowIndex, setActiveRowIndex] = useState(-1);" in inbox_src)
check("j k enter handled", 'event.key !== "j" &&' in inbox_src and 'event.key !== "k" &&' in inbox_src)
check("typing guard", "target.isContentEditable" in inbox_src)
check("enter opens row", 'void router.push("/dashboard/conversations/" + items[activeRowIndex].id)' in inbox_src)
check("row data attr", "data-conv-row={item.id}" in inbox_src)
check("row highlight ring", "ring-1 ring-brand/40" in inbox_src)

print("== phase 62: bulk confirm ==")
check("confirm gate", "!window.confirm(" in inbox_src)
check("confirm names action", '"This will " +' in inbox_src)
check("confirm counts rows", "selectedIds.length +" in inbox_src)

failures = summary("conv_flow")
sys.exit(1 if failures else 0)
