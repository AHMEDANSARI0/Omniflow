// rename_configure_ai.mjs — website (Omniflow repo ROOT me chalao):
//   * Sidebar: "AI agents" -> "Configure AI"
//   * /dashboard/bot page header -> "Configure AI" + clear split copy:
//       Business profile = business ki details, Configure AI = assistant ka behaviour
// Backups: *.pre_rename.bak — idempotent.

import fs from "node:fs";

const SIDEBAR = "app/dashboard/components/DashSidebar.tsx";
const PAGE = "app/dashboard/(portal)/bot/page.tsx";

for (const path of [SIDEBAR, PAGE]) {
  if (!fs.existsSync(path)) {
    console.log("File nahi mili: " + path + " — Omniflow repo ROOT me chalao.");
    process.exit(1);
  }
}

function patch(path, edits, name) {
  let text = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  let changed = false;

  for (const [oldStr, newStr] of edits) {
    const count = text.split(oldStr).length - 1;
    if (count > 0) {
      text = text.split(oldStr).join(newStr);
      changed = true;
      console.log(`  + ${name}: "${oldStr.slice(0, 40).replace(/\n/g, "\\n")}" -> "${newStr.slice(0, 40).replace(/\n/g, "\\n")}" (${count}x)`);
    }
  }

  if (!changed) {
    console.log("  = " + name + " (kuch nahi badla — pehle se theek)");
    return;
  }

  fs.copyFileSync(path, path + ".pre_rename.bak");
  fs.writeFileSync(path, text, "utf8");
  console.log("  LIKHA: " + path);
}

patch(SIDEBAR, [
  ['label: "AI agents"', 'label: "Configure AI"'],
  ['title="AI agents"', 'title="Configure AI"'],
], "DashSidebar.tsx");

patch(PAGE, [
  [
    '>          AI agent\n        </h1>',
    '>          Configure AI\n        </h1>',
  ],
  [
    "          Personality, greeting and handoff rules for the assistant that answers\n          on your connected channels.",
    "          Behaviour of the assistant that answers on your connected channels.\n          Business details (products, prices, policies, FAQs) live in\n          Business profile — this page is only about how the assistant talks\n          and takes decisions.",
  ],
], "bot/page.tsx");

console.log("");
console.log("SUCCESS! Ab yeh chalao:");
console.log('  git add "app/dashboard/components/DashSidebar.tsx" "app/dashboard/(portal)/bot/page.tsx"');
console.log('  git commit -m "feat: rename AI agents tab to Configure AI"');
console.log("  git push");