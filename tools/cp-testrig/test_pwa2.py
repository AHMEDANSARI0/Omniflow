"""Tests for the PWA/mobile polish (971-990 batch): manifest shortcuts +
maskable icons + categories, apple web-app metadata, and the public
self-serve wiring on the order page."""
import os

from test_lib import check, summary

ROOT = "/tmp/p13/Omniflow"

print("== manifest ==")

MANIFEST = open(ROOT + "/app/manifest.ts", encoding="utf8").read()
check("categories", 'categories: ["business", "productivity"]' in MANIFEST,
      "categories")
check("shortcuts list", "shortcuts: [" in MANIFEST
      and 'url: "/dashboard/conversations"' in MANIFEST
      and 'url: "/dashboard/broadcasts"' in MANIFEST
      and 'url: "/dashboard/cod"' in MANIFEST
      and 'url: "/dashboard/customers"' in MANIFEST, "shortcuts")
check("maskable icons", MANIFEST.count('purpose: "maskable"') == 2,
      MANIFEST.count("maskable"))
check("base icons intact", '{ src: "/icon", sizes: "512x512",'
      ' type: "image/png" }' in MANIFEST, "base")

for route in ("/dashboard/conversations", "/dashboard/broadcasts",
              "/dashboard/cod", "/dashboard/customers"):
    target = ROOT + "/app/dashboard/(portal)/" + route.rsplit("/", 1)[1]
    check("shortcut target " + route, os.path.isdir(target), target)

print("== apple web-app metadata ==")

LAYOUT = open(ROOT + "/app/layout.tsx", encoding="utf8").read()
check("appleWebApp", "appleWebApp: {" in LAYOUT
      and 'title: "OmniFlow"' in LAYOUT
      and 'statusBarStyle: "black-translucent"' in LAYOUT, "layout")

print("== public page self-serve ==")

PAGE = open(ROOT + "/app/c/[token]/page.tsx", encoding="utf8").read()
check("selfserve rendered", "<SelfServe" in PAGE
      and 'import SelfServe from "./SelfServe";' in PAGE, "render")
check("coupon row", "view.couponCode" in PAGE, "row")
check("status passed", 'status={view.status}' in PAGE, "status")

SERVE = open(ROOT + "/app/c/[token]/SelfServe.tsx", encoding="utf8").read()
check("client component", '"use client";' in SERVE
      and "useRouter" in SERVE and "router.refresh()" in SERVE, "client")
check("three actions", "Have a coupon code?" in SERVE
      and "Change address" in SERVE and "Cancel order" in SERVE, "actions")
check("public endpoints", "/change-request" in SERVE and "/coupon" in SERVE,
      "endpoints")
check("guards", "Enter a coupon code first." in SERVE
      and "Type the correct delivery address first." in SERVE, "guards")

print("== globals standing rules ==")

GLOBALS = open(ROOT + "/app/globals.css", encoding="utf8").read()
check("tap highlight", "-webkit-tap-highlight-color: transparent;" in GLOBALS,
      "tap")
check("16px inputs on phones", "font-size: 16px;" in GLOBALS
      and "@media (max-width: 640px)" in GLOBALS, "inputs")

summary("pwa2")
