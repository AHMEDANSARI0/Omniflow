"""UI/contract tests for the partials batch (311-330) and the fraud,
compliance, assist and telegram additions (331-350): portal clients, BFF
route depths, sidebar fixes and the new surfaces."""
import os
import sys

import test_lib
from test_lib import check, summary

SITE = "/tmp/p13/Omniflow/"


def read(rel):
    return open(SITE + rel, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
SIDEBAR = read("app/dashboard/components/DashSidebar.tsx")
SIDEBAR += "\n" + read("app/dashboard/components/portalNav.ts")  # §246 nav entries live in portalNav.ts
PROFILE = read("app/dashboard/(portal)/customers/profile/ProfileClient.tsx")
ACTIVITY = read("app/dashboard/(portal)/activity/page.tsx")
COMPLIANCE = read("app/dashboard/(portal)/compliance/page.tsx")
ASSIST = read("app/dashboard/(portal)/conversations/[id]/AssistCard.tsx")
THREAD = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
BRIDGE = read("connector-node/telegram_bridge.py")

print("== portal.ts clients (311-330) ==")

for name in ("getWorkspaceLanguage", "saveWorkspaceLanguage",
             "getContactLanguage", "detectLanguage", "linkContacts",
             "createConversationAction", "resolveContactAction",
             "listContactActions", "classifyIntent"):
    check("client " + name, "export async function " + name in PORTAL, name)
for name in ("ReplyLanguage", "ResolveMutation", "ContactAction", "IntentResult"):
    check("type " + name, ("export interface " + name in PORTAL)
          or ("export type " + name in PORTAL), name)

print("== portal.ts clients (331-350) ==")

for name in ("getFraudScore", "listFraudFlags", "listOptOuts", "addOptOut",
             "removeOptOut", "getConversationAssist"):
    check("client " + name, "export async function " + name in PORTAL, name)
for name in ("FraudScore", "FraudFlag", "OptOutRow", "KbSuggestion",
             "AssistResult", "OptOutRemoval"):
    check("type " + name, ("export interface " + name in PORTAL)
          or ("export type " + name in PORTAL), name)
check("fraud endpoint path", "api/v1/portal/fraud/score?contact=" in PORTAL, "url")
check("flags endpoint path", "api/v1/portal/fraud/flags" in PORTAL, "url")
check("optouts endpoint path", "api/v1/portal/compliance/optouts?q=" in PORTAL,
      "url")
check("assist endpoint path", "/assist" in PORTAL, "url")
check("remove uses delete", 'method: "DELETE"' in PORTAL, "delete")

print("== BFF depths (311-330) ==")

DEPTHS = [
    ("app/api/omniflow/portal/workspace/language/route.ts", 6),
    ("app/api/omniflow/portal/contacts/language/route.ts", 6),
    ("app/api/omniflow/portal/contacts/language/detect/route.ts", 7),
    ("app/api/omniflow/portal/contacts/link/route.ts", 6),
    ("app/api/omniflow/portal/insights/intent/route.ts", 6),
    ("app/api/omniflow/portal/conversations/[id]/actions/route.ts", 7),
    ("app/api/omniflow/portal/contacts/actions/route.ts", 6),
    ("app/api/omniflow/portal/contacts/actions/[id]/route.ts", 7),
]
for rel, depth in DEPTHS:
    src = read(rel)
    expected = "../" * depth + 'lib/omniflow/portal'
    check("depth " + rel.split("portal/")[1], expected in src, expected)

print("== BFF depths (331-350) ==")

DEPTHS2 = [
    ("app/api/omniflow/portal/fraud/score/route.ts", 6),
    ("app/api/omniflow/portal/fraud/flags/route.ts", 6),
    ("app/api/omniflow/portal/compliance/optouts/route.ts", 6),
    ("app/api/omniflow/portal/conversations/[id]/assist/route.ts", 7),
]
for rel, depth in DEPTHS2:
    src = read(rel)
    expected = "../" * depth + 'lib/omniflow/portal'
    check("depth " + rel.split("portal/")[1], expected in src, expected)

optouts = read("app/api/omniflow/portal/compliance/optouts/route.ts")
check("optouts methods", "export async function GET" in optouts
      and "export async function POST" in optouts
      and "export async function DELETE" in optouts, "methods")

print("== profile surface ==")

check("language chip", "Language: {profile.language}" in PROFILE, "chip")
check("linked chips", "Linked: {linked}" in PROFILE, "chips")
check("risk chip", "Risk: {risk}" in PROFILE and "risk === \"high\"" in PROFILE,
      "chip")
check("risk fetch", "/api/omniflow/portal/fraud/score?contact=" in PROFILE,
      "fetch")
check("action requests section", "Action requests" in PROFILE, "section")

print("== activity + sidebar ==")

check("escalations chip", 'label: "Escalations"' in ACTIVITY, "chip")
check("compliance nav", '{ label: "Compliance", href: "/dashboard/compliance",'
      ' icon: "compliance" }' in SIDEBAR, "nav")
check("sidebar icons filled (§246 SVG set)", 'icon: "dashboard"' in SIDEBAR
      and 'icon: "automation"' in SIDEBAR and 'icon: "profile"' in SIDEBAR, "icons")
# Icon law (Ph369b): U+2699 is emoji-capable and was retired in the D7
# sidebar; Settings keeps a text-presentation glyph instead.
_settings = SIDEBAR[SIDEBAR.find('label: "Settings"'):][:200]
check("settings icon text-presentation (no U+2699)",
      '\\u2699' not in SIDEBAR and 'icon: "' in _settings, "icon")
# §246: the scroll lives inside NavLinks (Settings pinned below it), and
# NavLinks renders in both containers (desktop rail + phone drawer).
check("nav scrolls both containers",
      '<div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-2">' in SIDEBAR
      and SIDEBAR.count("<NavLinks ") >= 2, SIDEBAR.count("<NavLinks "))

print("== compliance page ==")

check("add form", "Add an opt-out" in COMPLIANCE, "form")
check("list section", "Opt-out list" in COMPLIANCE, "list")
check("remove action", "Remove" in COMPLIANCE, "action")
check("reason picker", "Merchant decision" in COMPLIANCE
      and "Customer asked" in COMPLIANCE, "reasons")
check("search box", "Search number" in COMPLIANCE, "search")
check("stop hint", "they appear here automatically" in COMPLIANCE, "hint")

print("== assist card ==")

check("assist card rendered", "AssistCard conversationId={Number(id)}" in THREAD,
      "render")
check("assist dynamic import", 'const AssistCard = dynamic(() => import("./AssistCard"));'
      in THREAD, "import")
check("assist title", "Agent assist" in ASSIST, "title")
check("intent chip", "Intent: {assist.intent}" in ASSIST, "chip")
check("suggestion list", "suggestions.map(" in ASSIST, "list")
check("matched keywords", "Matched: {suggestion.matched.join" in ASSIST, "matched")
check("empty gate", "assist.intent === \"other\"" in ASSIST, "gate")

print("== telegram bridge ==")

check("bridge ingest path", 'INGEST_PATH = "/api/v1/connector/whatsapp/messages"'
      in BRIDGE, "path")
check("bridge commands filtered", "channel=telegram" in BRIDGE, "filter")
check("tg prefix map", '"tg:" + str(chat_id)' in BRIDGE, "map")
check("channel field", '"channel": "telegram"' in BRIDGE, "channel")
check("extract_out guards", "startswith(\"tg:\")" in BRIDGE, "guard")
check("ack on failure", "ack_command(command.get(\"id\"), False" in BRIDGE, "ack")
check("stdlib only", "import urllib.request" in BRIDGE
      and "import telegram" not in BRIDGE, "imports")
check("bridge readme", os.path.exists(SITE + "connector-node/README.md"), "readme")

sys.exit(1 if summary("partial_completion_ui") else 0)
