// add_batch_131_135.mjs - one-file batch covering Phases 131-135.
//
//   Ph131  app/manifest.ts - installable PWA manifest (standalone display,
//          brand colors, /dashboard start URL, icon entries).
//   Ph132  app/icon.tsx + app/apple-icon.tsx - code-generated brand icons
//          (512 and 180), no binary files needed; also upgrades the tab
//          favicon above the Next.js starter default.
//   Ph133  Root layout viewport export - themeColor + viewportFit cover
//          so the browser chrome and notched phones match the brand.
//   Ph134  FAQPage JSON-LD on the homepage, built from the CMS FAQ fields
//          (q1..q6) - eligible for Google rich results.
//   Ph135  Organization JSON-LD with the admin-managed site_url and the
//          generated logo route.
//
// Website repo only (Omniflow). Everything prerenders static at build.

import fs from "node:fs";
import path from "node:path";

const MANIFEST_FILE = `import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OmniFlow",
    short_name: "OmniFlow",
    description:
      "AI customer conversation automation - WhatsApp inbox, lead qualification and follow-ups.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#07111f",
    theme_color: "#07111f",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/icon", sizes: "192x192", type: "image/png" },
    ],
  };
}
`;

const ICON_FILE = `import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#07111f",
          borderRadius: 110,
          color: "#38bdf8",
          fontSize: 210,
          fontWeight: 700,
          letterSpacing: -8,
        }}
      >
        OF
      </div>
    ),
    size
  );
}
`;

const APPLE_ICON_FILE = `import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#07111f",
          color: "#38bdf8",
          fontSize: 78,
          fontWeight: 700,
          letterSpacing: -3,
        }}
      >
        OF
      </div>
    ),
    size
  );
}
`;

const LAYOUT_TYPE_FROM = `import type { Metadata } from "next";`;
const LAYOUT_TYPE_TO = `import type { Metadata, Viewport } from "next";`;

const LAYOUT_CSS_FROM = `import "./globals.css";`;
const LAYOUT_CSS_TO = `import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#07111f",
  viewportFit: "cover",
};`;

const PAGE_IMPORT_FROM = `import { getSectionContent } from "../lib/content";`;
const PAGE_IMPORT_TO = `import { getSectionContent } from "../lib/content";
import { getSiteSettings } from "../lib/settings";`;

const PAGE_RETURN_FROM = `  return (
    <main className="min-h-screen bg-[#07111f]">
      <Navbar />`;

const PAGE_RETURN_TO = `  const siteSettings = await getSiteSettings();

  const faqEntries = (
    [
      [faqContent.q1, faqContent.a1],
      [faqContent.q2, faqContent.a2],
      [faqContent.q3, faqContent.a3],
      [faqContent.q4, faqContent.a4],
      [faqContent.q5, faqContent.a5],
      [faqContent.q6, faqContent.a6],
    ] as const
  ).filter(([q, a]) => q.trim().length > 0 && a.trim().length > 0);

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqEntries.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  const orgLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "OmniFlow",
    url: siteSettings.site_url,
    logo: siteSettings.site_url.replace(/\\/$/, "") + "/icon",
  };

  return (
    <main className="min-h-screen bg-[#07111f]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <Navbar />`;

const NEW_FILES = [
  { path: "Omniflow/app/manifest.ts", content: MANIFEST_FILE, marker: "MetadataRoute.Manifest", name: "p131-manifest" },
  { path: "Omniflow/app/icon.tsx", content: ICON_FILE, marker: "ImageResponse", name: "p132-icon" },
  { path: "Omniflow/app/apple-icon.tsx", content: APPLE_ICON_FILE, marker: "ImageResponse", name: "p132-apple-icon" },
];

const TARGETS = [
  {
    file: "Omniflow/app/layout.tsx",
    swaps: [
      { name: "p133-viewport-type", from: LAYOUT_TYPE_FROM, to: LAYOUT_TYPE_TO, guard: "export const viewport: Viewport" },
      { name: "p133-viewport-const", from: LAYOUT_CSS_FROM, to: LAYOUT_CSS_TO, guard: 'themeColor: "#07111f"' },
    ],
  },
  {
    file: "Omniflow/app/page.tsx",
    swaps: [
      { name: "p135-settings-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO, guard: 'from "../lib/settings"' },
      { name: "p134-135-jsonld", from: PAGE_RETURN_FROM, to: PAGE_RETURN_TO, guard: "application/ld+json" },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_b131135.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
  fs.writeFileSync(target.file, text, "utf8");

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);