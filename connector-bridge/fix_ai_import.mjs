// fix_ai_import.mjs — ai.py ka purana SYSTEM_INSTRUCTION import hatata hai
// (usage pehle se portal prompt se replace ho chuka hai).
// Bot root me chalao:  node fix_ai_import.mjs   — idempotent.
import fs from "node:fs";
import { execSync } from "node:child_process";

const TARGET = "src/ai.py";
const OLD = "from gemini_ai import GeminiAI, SYSTEM_INSTRUCTION";
const NEW = "from gemini_ai import GeminiAI";

const original = fs.readFileSync(TARGET, "utf8");

if (!original.includes(OLD)) {
  if (original.includes(NEW)) {
    console.log("Import pehle se fix hai — kuch nahi kiya.");
    process.exit(0);
  }
  console.log("Import anchor nahi mila — poora output mujhe bhejo.");
  process.exit(1);
}

fs.copyFileSync(TARGET, TARGET + ".pre_imp.bak");
fs.writeFileSync(TARGET, original.replace(OLD, NEW), "utf8");

try {
  execSync("python -m py_compile " + JSON.stringify(TARGET), { stdio: "pipe" });
} catch (error) {
  fs.copyFileSync(TARGET + ".pre_imp.bak", TARGET);
  console.log("COMPILE FAIL — backup restore ho gaya.");
  console.log(String(error.stderr || error));
  process.exit(1);
}

console.log("  + ai.py import fixed: from gemini_ai import GeminiAI");
console.log("SUCCESS! Ab bot chalao:  python run_channel.py 1");
