"""Structural tests for the PWA + SEO metadata batch (Phases 131-135)."""
import sys

import test_lib
from test_lib import check, summary

base = "/tmp/p13/Omniflow/app/"
manifest_src = open(base + "manifest.ts").read()
icon_src = open(base + "icon.tsx").read()
apple_src = open(base + "apple-icon.tsx").read()
layout_src = open(base + "layout.tsx").read()
page_src = open(base + "page.tsx").read()

check("manifest standalone", 'display: "standalone"' in manifest_src)
check("manifest start dashboard", 'start_url: "/dashboard"' in manifest_src)
check("manifest brand colors", 'theme_color: "#07111f"' in manifest_src
      and 'background_color: "#07111f"' in manifest_src)
check("manifest icon entries", 'src: "/icon", sizes: "512x512"' in manifest_src)
check("icon code generated", "ImageResponse" in icon_src and '"#38bdf8"' in icon_src)
check("apple icon code generated", "ImageResponse" in apple_src and "180" in apple_src)
check("viewport exported", "export const viewport: Viewport" in layout_src)
check("viewport cover", 'viewportFit: "cover"' in layout_src)
check("theme color", 'themeColor: "#F8FAFC"' in layout_src)
check("faq jsonld built", '"@type": "FAQPage"' in page_src
      and "faqContent.q6" in page_src)
check("org jsonld built", '"@type": "Organization"' in page_src
      and 'site_url.replace(/\\/$/, "") + "/icon"' in page_src)
check("jsonld rendered", 'type="application/ld+json"' in page_src)
check("jsonld before navbar", page_src.index("application/ld+json") < page_src.index("<Navbar />"))

failures = summary("website_pwa")
sys.exit(1 if failures else 0)
