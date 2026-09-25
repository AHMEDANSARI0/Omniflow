"""Structural tests for the mobile-first portal batch (Phases 146-150)."""
import sys

import test_lib
from test_lib import check, summary, portal_thread_source

base = "/tmp/p13/Omniflow/app/"
bar_src = open(base + "dashboard/components/MobileTabBar.tsx").read()
shell_src = open(base + "dashboard/components/DashShell.tsx").read()
css_src = open(base + "globals.css").read()
thread_src = portal_thread_source()

print("== tab bar ==")
check("four tabs", bar_src.count("href: \"/dashboard") == 4)
check("inbox badge", "unreadCount" in bar_src and "min-w-4 rounded-full bg-rose-500/90" in bar_src)
check("badge caps 99", 'unreadCount > 99 ? "99+"' in bar_src)
check("hidden on threads", 'pathname.startsWith("/dashboard/conversations/")' in bar_src)
check("safe area padding", "env(safe-area-inset-bottom)" in bar_src)
check("phone only", "lg:hidden" in bar_src)
check("active state", 'aria-current={active ? "page" : undefined}' in bar_src)
check("counts poll reused", "useUnreadCount()" in bar_src and "include=counts" not in bar_src)

print("== shell ==")
check("shell renders bar", "<MobileTabBar />" in shell_src)
check("content clears bar", "pb-24" in shell_src and "lg:pb-12" in shell_src)

print("== css ==")
check("ios input fix", "@media (max-width: 640px)" in css_src
      and "font-size: 16px" in css_src)
check("fix targets inputs", "input,\n  textarea,\n  select {" in css_src)

print("== thread ==")
check("back link thumb target", "-ml-2 inline-block rounded-lg px-2 py-1.5 text-sm" in thread_src)
check("back link kept", "← Conversations" in thread_src)

failures = summary("mobile_nav")
sys.exit(1 if failures else 0)
