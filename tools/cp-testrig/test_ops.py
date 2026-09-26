"""Structural tests for the operator finishers batch (Phases 63-66)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

inbox_src = portal_page_source("conversations")
detail_src = portal_thread_source()

print("== phase 63: select all ==")
check("select all button", "setSelectedIds((items ?? []).map((item) => item.id))" in inbox_src)
check("select all label", "Select all\n          </button>" in inbox_src)
check("clear button", "onClick={() => setSelectedIds([])}" in inbox_src)
check("select all disabled busy", 'disabled={bulkBusy}\n            title="Select every conversation in the current view"' in inbox_src)

print("== phase 64: esc back ==")
check("router imported in detail", 'import { useRouter } from "next/navigation";' in detail_src)
check("router declared", "const router = useRouter();" in detail_src)
check("escape handler", 'if (event.key !== "Escape") return;' in detail_src)
check("esc back target", 'void router.push("/dashboard/conversations");' in detail_src)
check("typing guard", "target.isContentEditable" in detail_src)
check("esc effect cleaned up", 'window.removeEventListener("keydown", onKeyDown)' in detail_src)

print("== phase 65: live toggle ==")
check("live state", "const [liveMode, setLiveMode] = useState(true);" in inbox_src)
check("live ref", "const liveModeRef = useRef(true);" in inbox_src)
check("poll respects ref", "if (liveModeRef.current && document.visibilityState === \"visible\")" in inbox_src)
check("live button", '{liveMode ? "Live" : "Paused"}' in inbox_src)
check("toggle writes ref", "liveModeRef.current = next;" in inbox_src)

print("== phase 66: copy link ==")
check("copy link button", "void navigator.clipboard.writeText(window.location.href)" in detail_src)
check("copy link title", 'title="Copy a link to this conversation"' in detail_src)
check("copy link label", "Link\n                  </button>" in detail_src)

failures = summary("ops")
sys.exit(1 if failures else 0)
