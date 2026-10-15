// add_batch_117_120.mjs - one-file batch covering Phases 117-120.
//
//   Ph117  sitemap.xml + robots.txt as Next metadata routes, driven by the
//          admin-managed site_url. Dashboard and admin stay out of robots.
//   Ph118  The homepage awaited THIRTEEN CMS section reads one by one;
//          on a cold cache that is 13 serial round trips before first
//          paint. Now one Promise.all - same values, one round-trip time.
//   Ph119  next.config.ts was the empty template: poweredByHeader off,
//          strict mode on, compression on, AVIF/WebP image formats.
//   Ph120  app/opengraph-image.tsx - code-generated 1200x630 brand card so
//          shared links stop rendering without a social preview image.
//
// Website repo only (Omniflow). Vercel deploys on push. No restart.

import fs from "node:fs";
import path from "node:path";

const HOME_PATH = "Omniflow/app/page.tsx";
const CONFIG_PATH = "Omniflow/next.config.ts";

const SITEMAP_FILE = `import type { MetadataRoute } from "next";
import { getSiteSettings } from "../lib/settings";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const settings = await getSiteSettings();
  const base = settings.site_url.replace(/\\/$/, "");
  return [
    {
      url: base + "/",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
`;

const ROBOTS_FILE = `import type { MetadataRoute } from "next";
import { getSiteSettings } from "../lib/settings";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await getSiteSettings();
  const base = settings.site_url.replace(/\\/$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/admin"],
    },
    sitemap: base + "/sitemap.xml",
  };
}
`;

const OG_FILE = `import { ImageResponse } from "next/og";

export const alt = "OmniFlow - AI Customer Conversation Automation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#07111f",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", fontSize: 32, color: "#38bdf8" }}>
          OmniFlow
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 64,
            fontWeight: 700,
            marginTop: 24,
            lineHeight: 1.15,
          }}
        >
          Every customer conversation, on autopilot
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 30,
            color: "#94a3b8",
            marginTop: 28,
          }}
        >
          WhatsApp inbox, lead qualification and follow-ups in one layer
        </div>
      </div>
    ),
    size
  );
}
`;

const SECTIONS_FROM = `  const heroContent = await getSectionContent("hero", HERO_DEFAULTS);
  const aiIntelligenceContent = await getSectionContent("ai_intelligence", AI_INTELLIGENCE_DEFAULTS);
  const howItWorksContent = await getSectionContent("how_it_works", HOW_IT_WORKS_DEFAULTS);
  const finalCtaContent = await getSectionContent("final_cta", FINAL_CTA_DEFAULTS);
  const useCasesContent = await getSectionContent("use_cases", USE_CASES_DEFAULTS);
  const featuresContent = await getSectionContent("features", FEATURES_DEFAULTS);
  const trustContent = await getSectionContent("trust", TRUST_DEFAULTS);
  const whyOmniFlowContent = await getSectionContent("why_omniflow", WHY_OMNIFLOW_DEFAULTS);
  const multiChannelContent = await getSectionContent("multi_channel", MULTI_CHANNEL_DEFAULTS);
  const problemSolutionContent = await getSectionContent("problem_solution", PROBLEM_SOLUTION_DEFAULTS);
  const customerMemoryContent = await getSectionContent("customer_memory", CUSTOMER_MEMORY_DEFAULTS);
  const faqContent = await getSectionContent("faq", FAQ_DEFAULTS);
  const footerContent = await getSectionContent("footer", FOOTER_DEFAULTS);`;

const SECTIONS_TO = `  const [
    heroContent,
    aiIntelligenceContent,
    howItWorksContent,
    finalCtaContent,
    useCasesContent,
    featuresContent,
    trustContent,
    whyOmniFlowContent,
    multiChannelContent,
    problemSolutionContent,
    customerMemoryContent,
    faqContent,
    footerContent,
  ] = await Promise.all([
    getSectionContent("hero", HERO_DEFAULTS),
    getSectionContent("ai_intelligence", AI_INTELLIGENCE_DEFAULTS),
    getSectionContent("how_it_works", HOW_IT_WORKS_DEFAULTS),
    getSectionContent("final_cta", FINAL_CTA_DEFAULTS),
    getSectionContent("use_cases", USE_CASES_DEFAULTS),
    getSectionContent("features", FEATURES_DEFAULTS),
    getSectionContent("trust", TRUST_DEFAULTS),
    getSectionContent("why_omniflow", WHY_OMNIFLOW_DEFAULTS),
    getSectionContent("multi_channel", MULTI_CHANNEL_DEFAULTS),
    getSectionContent("problem_solution", PROBLEM_SOLUTION_DEFAULTS),
    getSectionContent("customer_memory", CUSTOMER_MEMORY_DEFAULTS),
    getSectionContent("faq", FAQ_DEFAULTS),
    getSectionContent("footer", FOOTER_DEFAULTS),
  ]);`;

const CONFIG_FROM = `const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
};`;

const CONFIG_TO = `const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  images: {
    formats: ["image/avif", "image/webp"],
  },
};`;

const NEW_FILES = [
  { path: "Omniflow/app/sitemap.ts", content: SITEMAP_FILE, marker: "MetadataRoute.Sitemap", name: "p117-sitemap" },
  { path: "Omniflow/app/robots.ts", content: ROBOTS_FILE, marker: "MetadataRoute.Robots", name: "p117-robots" },
  { path: "Omniflow/app/opengraph-image.tsx", content: OG_FILE, marker: "ImageResponse", name: "p120-og-image" },
];

const TARGETS = [
  {
    file: HOME_PATH,
    swaps: [{ name: "p118-parallel-sections", from: SECTIONS_FROM, to: SECTIONS_TO }],
  },
  {
    file: CONFIG_PATH,
    swaps: [{ name: "p119-next-config", from: CONFIG_FROM, to: CONFIG_TO, guard: "image/avif" }],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  writeFileEnsuringDir(file.path, file.content);
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

  const backup = target.file + ".pre_b117120.bak";
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