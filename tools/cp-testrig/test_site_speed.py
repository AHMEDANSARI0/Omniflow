"""Tests for the public-site hydration diet + team server split (171-175)."""
import sys

from test_lib import check, summary


COMPONENTS = "/tmp/p13/Omniflow/app/components"
SECTIONS = [
    "ProblemSolution",
    "HowItWorks",
    "WhyOmniFlow",
    "Trust",
    "CustomerMemory",
    "MultiChannel",
    "AIIntelligence",
]

print("== reveal island ==")

reveal_src = open(COMPONENTS + "/Reveal.tsx").read()
check("reveal exists", '"use client"' in reveal_src and "export default function Reveal" in reveal_src, "component")
check("reveal observes", "IntersectionObserver" in reveal_src, "observer")
check("reveal classes", '"of-reveal" +' in reveal_src and '" of-reveal-in"' in reveal_src, "classes")
check("reveal lift prop", "lift" in reveal_src and '" of-lift"' in reveal_src, "lift")
check("reveal dynamic tag", 'const Tag = as as "div";' in reveal_src, "tag")
check("reveal disconnects", "observer.disconnect()" in reveal_src, "cleanup")

print("== sections are server components ==")

for name in SECTIONS:
    src = open(COMPONENTS + "/" + name + ".tsx").read()
    check(name + " no client directive", '"use client"' not in src, name)
    check(name + " no framer motion", "motion/react" not in src and "motion." not in src, name)
    check(name + " uses reveal", 'import Reveal from "./Reveal";' in src and "<Reveal" in src, name)

ps_src = open(COMPONENTS + "/ProblemSolution.tsx").read()
check("card hover lift kept", "<Reveal lift" in ps_src, "lift")
mc_src = open(COMPONENTS + "/MultiChannel.tsx").read()
check("multichannel hover lift kept", "<Reveal lift" in mc_src, "lift")
cm_src = open(COMPONENTS + "/CustomerMemory.tsx").read()
check("semantic headings kept", "<Reveal as=\"h2\"" in cm_src and "<Reveal as=\"p\"" in cm_src, "h2 reveals")

print("== reveal css + js bootstrap ==")

globals_src = open("/tmp/p13/Omniflow/app/globals.css").read()
check("reveal css", "html.of-js .of-reveal:not(.of-reveal-in)" in globals_src, "gate")
check("reveal-in css", "html.of-js .of-reveal.of-reveal-in" in globals_src, "in")
check("lift css", ".of-reveal.of-lift:hover" in globals_src, "hover")

layout_src = open("/tmp/p13/Omniflow/app/layout.tsx").read()
check("of-js bootstrap", "document.documentElement.classList.add('of-js')" in layout_src, "script")
check("bootstrap before children", layout_src.find("dangerouslySetInnerHTML") < layout_src.find("{children}"), "order")

hero_src = open(COMPONENTS + "/Hero.tsx").read()
check("hero intentionally still motion", "motion/react" in hero_src, "hero")

print("== team server split ==")

team_page = open("/tmp/p13/Omniflow/app/dashboard/(portal)/team/page.tsx").read()
check("team server page", '"use client"' not in team_page, "wrapper")
check("team fetches overview", "listTeam(" in team_page, "server fetch")
check("team passes props", "initialMembers={initialMembers}" in team_page and "initialRole={initialRole}" in team_page, "props")
check("team depth", "../../../../lib/omniflow/portal" in team_page, "4 ups")

team_client = open("/tmp/p13/Omniflow/app/dashboard/(portal)/team/TeamClient.tsx").read()
check("team client exists", '"use client"' in team_client, "client")
check("team seeds members", "initialMembers ?? []" in team_client, "members")
check("team seeds role", "initialRole ?? null" in team_client, "role")
check("team loading seeded", "useState(initialMembers === null)" in team_client, "loading")
check("team manage kept", "const canManage = myRole" in team_client, "manage")
check("team perf card kept", "team/performance" in team_client, "perf")

print("== regression: earlier speed work ==")

widget_src = open(COMPONENTS + "/WebsiteChatWidget.tsx").read()
check("widget idle gate intact", "widgetReady" in widget_src, "gate")
thread_page = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx"
).read()
check("thread still server rendered", "getConversation(" in thread_page, "thread")

summary("site_speed")
