"""Structural tests for the conversation tools batch (Phases 55-58)."""
import sys

import test_lib
from test_lib import check, summary, portal_thread_source

detail_src = portal_thread_source()
notes_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/NotesCard.tsx").read()

print("== phase 55: internal notes ==")
check("notes card component", "export default function NotesCard(" in notes_src)
check("notes fetch", '"/api/omniflow/portal/conversations/" + conversationId + "/notes"' in notes_src)
check("notes post", 'method: "POST"' in notes_src)
check("notes add disabled", "disabled={busy || !draft.trim()}" in notes_src)
check("notes imported", 'const NotesCard = dynamic(() => import("./NotesCard"));' in detail_src)
check("notes rendered", "<NotesCard conversationId={Number(id)} />" in detail_src)
check("no em dash in new code", "\u2014" not in notes_src)

print("== phase 56: smart bubble ==")
check("reactnode imported", "type ReactNode" in detail_src)
check("url pattern", "MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;" in detail_src)
check("linkify helper", "function linkifyText(text: string, keyPrefix: string): ReactNode[] {" in detail_src)
check("render body helper", "function renderMessageBody(body: string, query: string): ReactNode {" in detail_src)
check("safe link attrs", 'target="_blank"' in detail_src and 'rel="noreferrer"' in detail_src)
check("highlight mark", 'className="rounded bg-amber-300/25 px-0.5 text-amber-100"' in detail_src)
check("bubble uses helper", "{renderMessageBody(message.body, threadQuery)}" in detail_src)

print("== phase 57: sticky composer ==")
check("sticky form", "sticky bottom-0 z-10 -mx-2 mt-6 flex items-end gap-3" in detail_src)
check("composer backdrop", ("bg-white/95" in detail_src or "bg-white/90" in detail_src or "bg-canvas/95" in detail_src) and "backdrop-blur" in detail_src)

print("== phase 58: draft guard ==")
check("guard effect", "function warnOnLeave(event: BeforeUnloadEvent)" in detail_src)
check("guard listener", 'window.addEventListener("beforeunload", warnOnLeave)' in detail_src)
check("guard cleanup", 'window.removeEventListener("beforeunload", warnOnLeave)' in detail_src)
check("guard keyed on draft", "}, [draft]);" in detail_src)

failures = summary("conv_tools")
sys.exit(1 if failures else 0)
