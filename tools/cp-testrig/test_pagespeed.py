"""Tests for the second speed pass (Phases 166-170)."""
import sys

from test_lib import check, portal_page_source, portal_thread_source, summary


print("== server-rendered thread ==")

thread_page = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx"
).read()
check("thread server page", '"use client"' not in thread_page, "wrapper")
check("thread awaits params", "await params" in thread_page, "params")
check("thread fetches detail", "getConversation(" in thread_page, "server fetch")
check("thread auth session", "getOmniFlowSession" in thread_page, "session")
check("thread depth", "../../../../../lib/omniflow/portal" in thread_page, "5 ups")
check("thread passes props", "initialConversation={initialConversation}" in thread_page
      and "initialMessages={initialMessages}" in thread_page, "props")

thread_client = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx"
).read()
check("thread client exists", '"use client"' in thread_client, "client")
check("thread id prop", "const id = conversationId;" in thread_client, "id prop")
check("thread seeds conversation", "initialConversation ?? null" in thread_client, "seed")
check("thread seeds messages", "initialMessages ?? null" in thread_client, "seed")
check("thread still polls", "POLL_MS = 10_000" in thread_client, "poll")
check("thread keeps router back", 'void router.push("/dashboard/conversations");' in thread_client, "router")
check("useParams gone", "useParams" not in thread_client, "no stale hook")

print("== thread drops framer-motion ==")

check("motion import gone", 'from "motion/react"' not in thread_client, "import")
check("motion tags gone", "motion.div" not in thread_client, "tags")
check("css fade class", 'className="of-fade-up space-y-3"' in thread_client, "class")

globals_src = open("/tmp/p13/Omniflow/app/globals.css").read()
check("fade keyframes", "@keyframes of-fade-up" in globals_src, "keyframes")
check("fade class css", ".of-fade-up {" in globals_src, "css class")

print("== server-rendered broadcasts ==")

broadcasts_page = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/broadcasts/page.tsx"
).read()
check("broadcasts server page", '"use client"' not in broadcasts_page, "wrapper")
check("broadcasts fetches list", "listBroadcasts(" in broadcasts_page, "server fetch")
check("broadcasts passes history", "initialHistory={initialHistory}" in broadcasts_page, "props")
check("broadcasts depth", "../../../../lib/omniflow/portal" in broadcasts_page, "4 ups")

broadcasts_client = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/broadcasts/BroadcastsClient.tsx"
).read()
check("broadcasts client exists", '"use client"' in broadcasts_client, "client")
check("broadcasts seeds history", "initialHistory ?? []" in broadcasts_client, "seed")
check("broadcasts seeds loaded", "useState(initialHistory !== null)" in broadcasts_client, "loaded")
check("broadcasts keeps composer", "async function sendBroadcast(" in broadcasts_client, "composer")

print("== chat widget idle mount ==")

widget_src = open("/tmp/p13/Omniflow/app/components/WebsiteChatWidget.tsx").read()
check("widget gate state", "widgetReady" in widget_src, "state")
check("widget gate timer", "setTimeout(() => setWidgetReady(true), 1_500)" in widget_src, "timer")
check("widget gate early return", "if (!widgetReady) return null;" in widget_src, "return")
check("widget surface split", "function WebsiteChatWidgetSurface()" in widget_src, "surface")
check("widget hooks intact", "const [mounted, setMounted] = useState(false);" in widget_src, "hooks")

print("== gitignore keeps backups out ==")

site_ignore = open("/tmp/p13/Omniflow/.gitignore").read()
check("website ignores backups", "*.pre_*.bak" in site_ignore, "website")
cp_ignore = open("/tmp/p13/OmniFlow-Control-Plane/.gitignore").read()
check("cp ignores backups", "*.pre_*.bak" in cp_ignore, "cp")

print("== regression: earlier speed work intact ==")

sidebar_src = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx").read()
check("sidebar shared poller", "useUnreadCount()" in sidebar_src, "hook")
inbox_page = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/page.tsx"
).read()
check("inbox still server rendered", "listConversations(" in inbox_page, "inbox ssr")

combined = portal_thread_source()
check("thread search kept", "Search in this conversation" in combined, "search")
check("load older kept", "before_id=" in combined, "older")
check("transcript kept", "downloadTranscript" in combined, "transcript")
combined_broadcasts = portal_page_source("broadcasts", ("BroadcastsClient.tsx",))
check("schedule card kept", "<ScheduleCard />" in combined_broadcasts, "card")

summary("pagespeed")
