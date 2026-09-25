// fix_ai_agents_link.mjs — enables the "AI agents" sidebar link regardless
// of how the nav item is formatted (single-line or multi-line).
//
// Run from the bot ROOT (folder containing Omniflow/):
//   node fix_ai_agents_link.mjs
//
// Idempotent: exits cleanly when the link is already enabled.

import fs from "node:fs";

const FILE = "Omniflow/app/dashboard/components/DashSidebar.tsx";

if (!fs.existsSync(FILE)) {
  console.log("SKIP (file not found): " + FILE);
  process.exit(0);
}

const original = fs.readFileSync(FILE, "utf8");
const text = original.replace(/\r\n/g, "\n");

const labelIndex = text.indexOf('label: "AI agents"');
if (labelIndex === -1) {
  console.log("? Could not find an 'AI agents' nav item — paste this output back.");
  process.exit(0);
}

// Find the enclosing item: last "{" before the label, first "}," after it.
const openBrace = text.lastIndexOf("{", labelIndex);
const closeBrace = text.indexOf("},", labelIndex);
if (openBrace === -1 || closeBrace === -1) {
  console.log("? Could not read the AI agents item bounds — paste this output back.");
  process.exit(0);
}

const item = text.slice(openBrace, closeBrace + 2);

if (/enabled:\s*true/.test(item) && !/enabled:\s*false/.test(item)) {
  console.log("= AI agents link is already enabled. Nothing to do.");
  process.exit(0);
}

if (!/enabled:\s*false/.test(item)) {
  console.log("? AI agents item has no enabled flag — paste this output back.");
  console.log(item);
  process.exit(0);
}

const fixedItem = item.replace(/enabled:\s*false/, "enabled: true");
const updated = text.slice(0, openBrace) + fixedItem + text.slice(closeBrace + 2);
fs.writeFileSync(FILE, updated, "utf8");
console.log("+ AI agents sidebar link enabled. Item now reads:");
console.log(fixedItem.trim());