"""Structural tests for the operator QoL batch (Phases 51-54)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source, portal_thread_source

detail_src = portal_thread_source()
inbox_src = portal_page_source("conversations")

print("== phase 51: draft memory ==")
check("draft restore effect", 'window.localStorage.getItem("ofl_draft_" + id)' in detail_src)
check("draft persist effect", 'window.localStorage.setItem("ofl_draft_" + id, draft)' in detail_src)
check("draft cleared from storage", 'window.localStorage.removeItem("ofl_draft_" + id)' in detail_src)
check("restore keyed on id", "}, [id]);" in detail_src)
check("persist keyed on draft and id", "}, [draft, id]);" in detail_src)

print("== phase 52: copy message ==")
check("copy button", "void navigator.clipboard.writeText(message.body)" in detail_src)
check("copy title", 'title="Copy this message"' in detail_src)

print("== phase 53: sound alert ==")
check("sound state", "const [soundEnabled, setSoundEnabled] = useState(false);" in inbox_src)
check("sound toggle fn", "function toggleSound()" in inbox_src)
check("sound persisted", 'window.localStorage.setItem("ofl_sound", next ? "1" : "0");' in inbox_src)
check("sound seeded", 'window.localStorage.getItem("ofl_sound") === "1"' in inbox_src)
check("audio context", "window.AudioContext ??" in inbox_src)
check("chime gain ramp", "gain.gain.exponentialRampToValueAtTime(" in inbox_src)
check("sound button", '{soundEnabled ? "Sound on" : "Sound off"}' in inbox_src)
check("effect deps extended", "}, [chipCounts, alertEnabled, soundEnabled]);" in inbox_src)

print("== phase 54: title badge ==")
check("base title ref", 'const baseTitleRef = useRef("");' in inbox_src)
check("title effect", "document.title =" in inbox_src)
check("count prefix", '"(" + total + ") " + baseTitleRef.current' in inbox_src)
check("effect keyed on counts", "}, [chipCounts]);" in inbox_src)

failures = summary("qol")
sys.exit(1 if failures else 0)
