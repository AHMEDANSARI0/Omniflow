// add_custom_instructions_laptop.mjs v3 — CRLF-tolerant, robust anchors.
// Bot root me chalao:  node add_custom_instructions_laptop.mjs
// Backup: .pre_ci3.bak — idempotent.

import fs from "node:fs";
import { execSync } from "node:child_process";

const TARGET = "src/portal_agent_config.py";

if (!fs.existsSync(TARGET)) {
  console.log("src/portal_agent_config.py nahi mila — bot root me chalao.");
  process.exit(1);
}

let text = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

if (text.includes("custom_instructions")) {
  console.log("portal_agent_config.py pehle se patched hai — kuch nahi kiya.");
  process.exit(0);
}

const edits = [
  [
    '    "human_handoff_enabled": False,\n    "configured": False,\n}',
    '    "human_handoff_enabled": False,\n    "custom_instructions": "",\n    "configured": False,\n}',
  ],
  [
    '        config["configured"] = data.get("updated_at") is not None',
    '        if isinstance(data.get("custom_instructions"), str):\n'
    + '            config["custom_instructions"] = data["custom_instructions"].strip()\n\n'
    + '        config["configured"] = data.get("updated_at") is not None',
  ],
  [
    '    return "\\n".join(lines)',
    '    if config.get("custom_instructions"):\n'
    + '        lines.append("")\n'
    + '        lines.append(\n'
    + '            "OWNER CUSTOM INSTRUCTIONS (highest priority after the rules "\n'
    + '            "above — follow them exactly):"\n'
    + '        )\n'
    + '        lines.append(str(config["custom_instructions"]))\n\n'
    + '    return "\\n".join(lines)',
  ],
  [
    '        + (", handoff=on" if config["human_handoff_enabled"] else "")',
    '        + (", handoff=on" if config["human_handoff_enabled"] else "")\n        + (", custom=on" if config["custom_instructions"] else "")',
  ],
];

for (const [oldStr, newStr] of edits) {
  const count = text.split(oldStr).length - 1;
  if (count !== 1) {
    console.log(`FAIL — anchor ${count} dafa mila (1 chahiye):\n${oldStr.slice(0, 140)}`);
    console.log("Kuch change NahI kiya. Poora output mujhe bhejo.");
    process.exit(1);
  }
  text = text.replace(oldStr, newStr);
}

fs.copyFileSync(TARGET, TARGET + ".pre_ci3.bak");
fs.writeFileSync(TARGET, text, "utf8");

try {
  execSync("python -m py_compile " + JSON.stringify(TARGET), {
    stdio: "pipe",
  });
} catch (error) {
  fs.copyFileSync(TARGET + ".pre_ci3.bak", TARGET);
  console.log("COMPILE FAIL — backup restore ho gaya.");
  console.log(String(error.stderr || error));
  process.exit(1);
}

console.log("  + portal_agent_config.py: custom instructions support");
console.log("");
console.log("SUCCESS! Ab bot restart karo:  python run_channel.py 1");
