// add_custom_instructions_web.mjs — website (Omniflow repo ROOT me chalao):
//   * lib/omniflow/portal.ts        — BotConfig + normalize + body
//   * bot/route.ts                  — PUT whitelist
//   * BotForm.tsx                   — Custom instructions textarea
// Backups: *.pre_ci.bak — idempotent (marker: customInstructions).

import fs from "node:fs";

const FILES = {
  portal: "lib/omniflow/portal.ts",
  route: "app/api/omniflow/portal/bot/route.ts",
  form: "app/dashboard/(portal)/bot/BotForm.tsx",
};

const MARKER = "customInstructions";

for (const path of Object.values(FILES)) {
  if (!fs.existsSync(path)) {
    console.log("File nahi mili: " + path + " — Omniflow repo ROOT me chalao.");
    process.exit(1);
  }
}

function patch(path, edits, name) {
  let text = fs.readFileSync(path, "utf8");
  if (text.includes(MARKER)) {
    console.log("  = " + name + " (pehle se patched)");
    return;
  }
  for (const [oldStr, newStr] of edits) {
    const count = text.split(oldStr).length - 1;
    if (count !== 1) {
      console.log(`FAIL — [${name}] anchor ${count} dafa mila (1 chahiye):\n${oldStr.slice(0, 120)}`);
      process.exit(1);
    }
    text = text.replace(oldStr, newStr);
  }
  fs.copyFileSync(path, path + ".pre_ci.bak");
  fs.writeFileSync(path, text, "utf8");
  console.log("  + " + name);
}

patch(FILES.portal, [
  [
    "  humanHandoffEnabled: boolean;\n  updatedAt: string | null;\n}",
    "  humanHandoffEnabled: boolean;\n  customInstructions: string;\n  updatedAt: string | null;\n}",
  ],
  [
    "  humanHandoffEnabled: false,\n  updatedAt: null,\n};",
    "  humanHandoffEnabled: false,\n  customInstructions: \"\",\n  updatedAt: null,\n};",
  ],
  [
    "    humanHandoffEnabled: p.human_handoff_enabled === true,\n    updatedAt:",
    "    humanHandoffEnabled: p.human_handoff_enabled === true,\n    customInstructions: typeof p.custom_instructions === \"string\" ? p.custom_instructions : \"\",\n    updatedAt:",
  ],
  [
    "    human_handoff_enabled: config.humanHandoffEnabled,\n  };",
    "    human_handoff_enabled: config.humanHandoffEnabled,\n    custom_instructions: config.customInstructions,\n  };",
  ],
], "lib/omniflow/portal.ts");

patch(FILES.route, [
  [
    "    humanHandoffEnabled: payload.humanHandoffEnabled === true,\n    updatedAt: null,",
    "    humanHandoffEnabled: payload.humanHandoffEnabled === true,\n    customInstructions:\n      typeof payload.customInstructions === \"string\"\n        ? payload.customInstructions.slice(0, 2000)\n        : \"\",\n    updatedAt: null,",
  ],
], "app/api/omniflow/portal/bot/route.ts");

patch(FILES.form, [
  [
    "  humanHandoffEnabled: boolean;\n}",
    "  humanHandoffEnabled: boolean;\n  customInstructions: string;\n}",
  ],
  [
    "  humanHandoffEnabled: false,\n};",
    "  humanHandoffEnabled: false,\n  customInstructions: \"\",\n};",
  ],
  [
    '            placeholder="I\'m not sure about that — connecting you to a human colleague."\n          />\n        </div>\n      </div>',
    '            placeholder="I\'m not sure about that — connecting you to a human colleague."\n          />\n        </div>\n\n        <div className="mt-4">\n          <label htmlFor="customInstructions" className={labelClass}>\n            Custom instructions\n          </label>\n          <textarea\n            id="customInstructions"\n            className={`${inputClass} min-h-[96px] resize-y`}\n            maxLength={2000}\n            value={config.customInstructions}\n            onChange={(e) => update("customInstructions", e.target.value)}\n            placeholder={"Example: Always offer free delivery on orders above 10,000 PKR. Never share supplier prices with customers."}\n          />\n          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">\n            The assistant follows these instructions with the highest priority in every conversation.\n          </p>\n        </div>\n      </div>',
  ],
], "app/dashboard/(portal)/bot/BotForm.tsx");

console.log("");
console.log("SUCCESS! Ab yeh chalao:");
console.log('  git add lib/omniflow/portal.ts "app/api/omniflow/portal/bot/route.ts" "app/dashboard/(portal)/bot/BotForm.tsx"');
console.log('  git commit -m "feat: custom instructions field for AI agent"');
console.log("  git push");
