#!/usr/bin/env node
// ============================================================================
// WhatsApp Response Time Setting — CP Portal Feature
// ============================================================================

import fs from "fs";
import path from "path";

const root = process.cwd();

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, text) { fs.writeFileSync(p, text, "utf8"); }
function exists(p) { return fs.existsSync(p); }

function patchFile(p, find, replace) {
  if (!exists(p)) {
    console.warn("! " + p + " not found");
    return false;
  }
  const content = read(p);
  // If replace string already exists, patch is already applied
  if (content.includes(replace)) {
    console.log("= " + p + " — already patched");
    return true;
  }
  // Otherwise, do the replacement
  if (content.includes(find)) {
    const updated = content.replace(find, replace);
    write(p, updated);
    console.log("+ " + p + " — patched");
    return true;
  }
  console.warn("! " + p + " — find string not found, skipping");
  return false;
}

function patcher() {
  console.log("================================================================");
  console.log("  WhatsApp Response Time Setting — CP Portal Feature");
  console.log("================================================================");
  console.log("");

  // 1. Update BotConfig interface in portal.ts
  console.log("--- 1. BotConfig interface ---");
  const portalPath = path.join(root, "lib", "omniflow", "portal.ts");
  if (exists(portalPath)) {
    patchFile(portalPath,
      "  customInstructions: string;\n  updatedAt: string | null;",
      "  customInstructions: string;\n  responseDelaySeconds: number;\n  updatedAt: string | null;"
    );
    patchFile(portalPath,
      "  customInstructions: \"\",",
      "  customInstructions: \"\",\n  responseDelaySeconds: 0,"
    );
    patchFile(portalPath,
      "    customInstructions: typeof p.custom_instructions === \"string\" ? p.custom_instructions : \"\",",
      "    customInstructions: typeof p.custom_instructions === \"string\" ? p.custom_instructions : \"\",\n    responseDelaySeconds: typeof p.response_delay_seconds === \"number\" ? Math.max(0, Math.min(3600, p.response_delay_seconds)) : 0,"
    );
  }

  // 2. Update bot route
  console.log("--- 2. Bot route ---");
  const botRoutePath = path.join(root, "app", "api", "omniflow", "portal", "bot", "route.ts");
  if (exists(botRoutePath)) {
    patchFile(botRoutePath,
      "    humanHandoffEnabled: payload.humanHandoffEnabled === true,",
      "    humanHandoffEnabled: payload.humanHandoffEnabled === true,\n    responseDelaySeconds: typeof payload.responseDelaySeconds === \"number\" ? Math.max(0, Math.min(3600, payload.responseDelaySeconds)) : 0,"
    );
  }

  // 3. Update WhatsApp bridge
  console.log("--- 3. WhatsApp bridge ---");
  const bridgePath = path.join(root, "connector-bridge", "control_plane_bridge.py");
  if (exists(bridgePath)) {
    patchFile(bridgePath,
      "        self.media_backlog = max(\n            1, int(_env_float(\"OMNIFLOW_CP_MEDIA_BACKLOG\", 3))\n        )",
      "        self.media_backlog = max(\n            1, int(_env_float(\"OMNIFLOW_CP_MEDIA_BACKLOG\", 3))\n        )\n\n        # WhatsApp response delay (seconds) — 0 = instant, 120 = 2 min, etc.\n        self.response_delay_seconds = max(\n            0.0,\n            _env_float(\"OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS\", 0.0),\n        )"
    );
  }

  console.log("");
  console.log("================================================================");
  console.log("  Patches Applied");
  console.log("================================================================");
  console.log("");
  console.log("What was added:");
  console.log("  - BotConfig.responseDelaySeconds field");
  console.log("  - Bot route handles responseDelaySeconds");
  console.log("  - WhatsApp bridge reads OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS");
  console.log("");
  console.log("How to use:");
  console.log("  1. Set response delay via CP portal bot settings");
  console.log("  2. Or set env var: OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS=120");
  console.log("");
  console.log("================================================================");
}

patcher();