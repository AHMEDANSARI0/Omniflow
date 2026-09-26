// patch_prompt_v2.mjs — prompt_builder.py ko FULL REWRITE karta hai:
//   * hardcoded personal-assistant SYSTEM_PROMPT hata diya (ab use nahi hota)
//   * OWNER INSTRUCTIONS (portal AI agents config) sab se upar, strict priority
//   * business profile directives uske baad
//   * professional English only
// Chalao bot root me:  node patch_prompt_v2.mjs
// Backup: prompt_builder.py.pre_v2.bak — idempotent.

import fs from "node:fs";
import { execSync } from "node:child_process";

const TARGET = "src/prompt_builder.py";
const MARKER = "OWNER INSTRUCTIONS (follow strictly)";

if (!fs.existsSync(TARGET)) {
  console.log("src/prompt_builder.py nahi mila — bot root me chalao.");
  process.exit(1);
}

let current = fs.readFileSync(TARGET, "utf8");

if (current.includes(MARKER)) {
  console.log("prompt_builder.py pehle se v2 hai — kuch nahi kiya.");
  process.exit(0);
}

for (const required of [
  "src/portal_agent_config.py",
  "src/portal_business_profile.py",
]) {
  if (!fs.existsSync(required)) {
    console.log(
      required + " nahi mila — pehle dono mirror modules save karo."
    );
    process.exit(1);
  }
}

const NEXT = `from portal_agent_config import (
    build_directives,
    start_background_refresh,
)
from portal_business_profile import (
    build_business_directives,
    start_background_refresh as start_profile_refresh,
)


class PromptBuilder:
    def __init__(self):
        start_background_refresh()
        start_profile_refresh()

    def build(self, history, user_message):
        prompt = (
            "You are a professional WhatsApp business assistant.\\n"
            "The OWNER INSTRUCTIONS below have top priority: follow them "
            "strictly in every reply.\\n\\n"
            "OWNER INSTRUCTIONS:\\n"
        )

        prompt += build_directives()

        prompt += "\\n"

        prompt += build_business_directives()

        prompt += "\\n\\nRULES:\\n"
        prompt += (
            "- Anything not covered in the OWNER INSTRUCTIONS or BUSINESS "
            "PROFILE: say you will check with the team instead of guessing.\\n"
        )
        prompt += (
            "- Reply in the customer's language (English or Urdu/Roman "
            "Urdu).\\n"
        )
        prompt += (
            "- Keep replies short (1-4 lines), polite and helpful.\\n\\n"
        )

        if history:

            prompt += "CONVERSATION HISTORY:\\n\\n"

            for item in history:

                role = item["role"].capitalize()

                content = item["message"]

                prompt += f"{role}: {content}\\n"

            prompt += "\\n"

        prompt += f"Customer: {user_message}\\n"

        prompt += "Assistant:"

        return prompt
`;

fs.copyFileSync(TARGET, TARGET + ".pre_v2.bak");
fs.writeFileSync(TARGET, NEXT, "utf8");

try {
  execSync("python -m py_compile " + JSON.stringify(TARGET), {
    stdio: "pipe",
  });
} catch (error) {
  fs.copyFileSync(TARGET + ".pre_v2.bak", TARGET);
  console.log("COMPILE FAIL — backup restore ho gaya.");
  console.log(String(error.stderr || error));
  process.exit(1);
}

console.log("  + prompt_builder.py v2 likha (SYSTEM_PROMPT ab use nahi hota)");
console.log("  + OWNER INSTRUCTIONS ab top priority par hain");
console.log("");
console.log("SUCCESS! Ab bot restart karo.");
