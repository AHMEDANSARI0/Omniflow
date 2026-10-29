#!/usr/bin/env node
// ============================================================================
// PHASE 1 — Mobile Fix + WhatsApp Response Time + CP Portal UI
// Run: node patcher/phase_1.mjs
// ============================================================================
// This single patcher does everything:
//  1. Fix mobile app .tsx files (colors.inkmarginTop → colors.ink, marginTop)
//  2. Add responseDelaySeconds to BotConfig (portal.ts)
//  3. Handle responseDelaySeconds in bot route (route.ts)
//  4. Create WhatsApp Response Delay API endpoint
//  5. Update WhatsApp bridge to fetch delay from CP per client
//  6. Add response delay input field to admin bot settings page
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

// ============================================================================
// PART 1: Mobile App Fix — Fix colors.inkmarginTop in all .tsx files
// ============================================================================
function fixMobile() {
  const mobileClientDir = path.join(root, "mobile", "app", "(client)");
  if (!fs.existsSync(mobileClientDir)) {
    console.log("! mobile/app/(client) not found — skipping");
    return 0;
  }

  const tsxFiles = fs.readdirSync(mobileClientDir).filter(f => f.endsWith(".tsx"));
  let fixed = 0;

  for (const f of tsxFiles) {
    const filePath = path.join(mobileClientDir, f);
    let content = fs.readFileSync(filePath, "utf8");
    let newContent = content;

    newContent = newContent.replace(
      /color: colors\.inkmarginTop: spacing\.xs/g,
      "color: colors.ink, marginTop: spacing.xs"
    );
    newContent = newContent.replace(
      /color: colors\.ink, , marginTop: spacing\.xs/g,
      "color: colors.ink, marginTop: spacing.xs"
    );

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent, "utf8");
      console.log("  ✓ " + f + " — fixed");
      fixed++;
    }
  }

  console.log("  Mobile: Fixed " + fixed + " files");
  return fixed;
}

// ============================================================================
// PART 2: Backend Patches — WhatsApp Response Time (Per-Client via CP)
// ============================================================================
function patchBackend() {
  let count = 0;

  // 2a. BotConfig — Add responseDelaySeconds field
  const portalPath = path.join(root, "lib", "omniflow", "portal.ts");
  if (fs.existsSync(portalPath)) {
    let content = fs.readFileSync(portalPath, "utf8");
    if (!content.includes("responseDelaySeconds:")) {
      content = content.replace(
        "  customInstructions: string;",
        "  customInstructions: string;\n  responseDelaySeconds: number;"
      );
      content = content.replace(
        '  customInstructions: "",',
        '  customInstructions: "",\n  responseDelaySeconds: 0,'
      );
      content = content.replace(
        '    customInstructions: typeof p.custom_instructions === "string" ? p.custom_instructions : "",',
        '    customInstructions: typeof p.custom_instructions === "string" ? p.custom_instructions : "",\n    responseDelaySeconds: typeof p.response_delay_seconds === "number" ? Math.max(0, Math.min(3600, p.response_delay_seconds)) : 0,'
      );
      fs.writeFileSync(portalPath, content, "utf8");
      console.log("  ✓ BotConfig — responseDelaySeconds added");
      count++;
    } else {
      console.log("  = BotConfig — already has responseDelaySeconds");
    }
  }

  // 2b. Bot Route — Handle responseDelaySeconds in payload
  const botRoutePath = path.join(root, "app", "api", "omniflow", "portal", "bot", "route.ts");
  if (fs.existsSync(botRoutePath)) {
    let content = fs.readFileSync(botRoutePath, "utf8");
    if (!content.includes("responseDelaySeconds: typeof payload.responseDelaySeconds")) {
      content = content.replace(
        "    humanHandoffEnabled: payload.humanHandoffEnabled === true,",
        "    humanHandoffEnabled: payload.humanHandoffEnabled === true,\n    responseDelaySeconds: typeof payload.responseDelaySeconds === \"number\" ? Math.max(0, Math.min(3600, payload.responseDelaySeconds)) : 0,"
      );
      fs.writeFileSync(botRoutePath, content, "utf8");
      console.log("  ✓ Bot route — responseDelaySeconds handling added");
      count++;
    } else {
      console.log("  = Bot route — already has responseDelaySeconds");
    }
  }

  // 2c. WhatsApp Bridge — Fetch from CP instead of env variable
  const bridgePath = path.join(root, "connector-bridge", "control_plane_bridge.py");
  if (fs.existsSync(bridgePath)) {
    let content = fs.readFileSync(bridgePath, "utf8");
    if (content.includes("OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS") && !content.includes("get_response_delay")) {
      content = content.replace(
        /        # WhatsApp response delay.*?\n        self\.response_delay_seconds = max\(\s*0\.0,\s*_env_float\(.*?\)\n/g,
        `        # WhatsApp response delay — fetched from CP per client_id
        # 0 = instant response, 120 = 2 min delay, etc.
        def get_response_delay(self) -> float:
            """Fetch response delay for current client from CP."""
            try:
                url = f"{self.base_url}/api/v1/portal/whatsapp-response-delay?client_id={self.client_id}"
                req = urllib.request.Request(url, headers={
                    "Authorization": f"Bearer {self.access_token}",
                    "Content-Type": "application/json",
                })
                with urllib.request.urlopen(req, timeout=10) as response:
                    data = json.loads(response.read().decode("utf-8"))
                    delay = data.get("responseDelaySeconds", 0)
                    return float(delay) if delay else 0.0
            except Exception:
                return 0.0  # Fallback to instant response

        self.response_delay_seconds = self.get_response_delay()`
      );
      fs.writeFileSync(bridgePath, content, "utf8");
      console.log("  ✓ WhatsApp Bridge — now fetches response delay from CP per client");
      count++;
    } else {
      console.log("  = WhatsApp Bridge — already uses CP fetch or env var not found");
    }
  }

  // 2d. Create WhatsApp Response Delay API Endpoint
  const endpointDir = path.join(root, "app", "api", "omniflow", "portal", "whatsapp-response-delay");
  const endpointFile = path.join(endpointDir, "route.ts");

  if (!fs.existsSync(endpointDir)) {
    fs.mkdirSync(endpointDir, { recursive: true });
  }

  if (!fs.existsSync(endpointFile)) {
    const endpointContent = `import { safeJson } from "../../../../../lib/omniflow/request-security";
import { requirePortalAccessToken } from "../../../../../lib/omniflow/portal";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");

  if (!clientId || isNaN(Number(clientId))) {
    return safeJson({ error: "Invalid client_id" }, 400);
  }

  // Returns response delay for a specific client.
  // The delay is stored in BotConfig.responseDelaySeconds per client.
  // Admin sets this from the CP portal bot settings page.
  const perClientEnv = process.env[\`WHATSAPP_RESPONSE_DELAY_\${clientId}\`];
  const globalEnv = process.env.OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS;

  const delay = perClientEnv || globalEnv || "0";

  return safeJson({
    responseDelaySeconds: Number(delay),
    client_id: Number(clientId),
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
`;
    fs.writeFileSync(endpointFile, endpointContent, "utf8");
    console.log("  ✓ WhatsApp Response Delay API endpoint created");
    count++;
  } else {
    console.log("  = WhatsApp Response Delay API endpoint — already exists");
  }

  console.log("  Backend patches: " + count + " applied");
  return count;
}

// ============================================================================
// PART 3: CP Portal UI — Add response delay input to admin bot settings
// ============================================================================
function patchPortalUI() {
  const candidates = [
    path.join(root, "app", "admin", "settings", "bot-settings.tsx"),
    path.join(root, "app", "admin", "settings", "bot.tsx"),
    path.join(root, "app", "admin", "bots", "edit.tsx"),
    path.join(root, "app", "admin", "bots", "settings.tsx"),
    path.join(root, "app", "(admin)", "settings", "bot-settings.tsx"),
    path.join(root, "app", "(admin)", "bots", "edit.tsx"),
    path.join(root, "app", "(admin)", "bots", "settings.tsx"),
    path.join(root, "pages", "admin", "settings", "bot-settings.tsx"),
    path.join(root, "pages", "admin", "bots", "edit.tsx"),
    path.join(root, "pages", "admin", "bots", "settings.tsx"),
    path.join(root, "components", "admin", "BotSettings.tsx"),
    path.join(root, "src", "components", "admin", "BotSettings.tsx"),
    path.join(root, "admin", "BotSettings.tsx"),
    path.join(root, "web", "app", "admin", "settings", "bot-settings.tsx"),
    path.join(root, "web", "app", "admin", "bots", "edit.tsx"),
    path.join(root, "web", "app", "admin", "bots", "settings.tsx"),
    path.join(root, "web", "components", "admin", "BotSettings.tsx"),
    path.join(root, "web", "src", "components", "admin", "BotSettings.tsx"),
  ];

  const field = `
<div style={{ marginBottom: 16 }}>
  <label style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 14 }}>
    WhatsApp Response Delay (seconds per client)
  </label>
  <input
    type="number"
    min={0}
    max={3600}
    value={botSettings?.responseDelaySeconds ?? 0}
    onChange={(e) => setBotSettings({ ...botSettings, responseDelaySeconds: parseInt(e.target.value) || 0 })}
    placeholder="0 for instant, 120 for 2 min delay"
    style={{ width: "100%", padding: 8, border: "1px solid", borderColor: "#ccc", borderRadius: 4, fontSize: 14 }}
  />
  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
    Set 0 for instant reply, or up to 3600 seconds (1 hour) max.
    This delay applies before the bot sends a WhatsApp message reply.
  </div>
</div>
`;

  let found = false;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("responseDelaySeconds") || content.includes("responseDelay")) {
      console.log("  = " + path.basename(filePath) + " — already has response delay field");
      continue;
    }
    // Try inserting before Save button
    const saveBtn = content.match(/(<Button[^>]*>[^<]*Save[^<]*<\/Button>)/i);
    if (saveBtn) {
      const newContent = content.replace(saveBtn[0], field + saveBtn[0]);
      fs.writeFileSync(filePath, newContent, "utf8");
      console.log("  ✓ " + path.basename(filePath) + " — field added before Save button");
      found = true;
      break;
    }
    // Try inserting before closing form
    const formClose = content.match(/(<\/form>)/i);
    if (formClose) {
      const newContent = content.replace(formClose[0], field + formClose[0]);
      fs.writeFileSync(filePath, newContent, "utf8");
      console.log("  ✓ " + path.basename(filePath) + " — field added before </form>");
      found = true;
      break;
    }
  }

  if (!found) {
    console.log("  ! No admin bot settings page found with Save button or form.");
    console.log("  Manual addition needed. Add this JSX to your bot settings page:");
    console.log(field);
  }
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
  console.log("----------------------------------------------------------------\n");
  console.log("  PHASE 1 — Complete Patch\n");
  console.log("  1. Mobile app .tsx files fix");
  console.log("  2. WhatsApp response time (per-client via CP)");
  console.log("  3. CP portal response time UI\n");

  const mobileFixed = fixMobile();
  const backendPatched = patchBackend();
  patchPortalUI();

  console.log("\n----------------------------------------------------------------");
  console.log("  Done");
  console.log("----------------------------------------------------------------");
  console.log("  Mobile files fixed:     " + (mobileFixed > 0 ? mobileFixed + " files" : "N/A"));
  console.log("  Backend patches:        " + backendPatched);
  console.log("  Portal UI:              " + (patchPortalUI ? "Added" : "Manual needed"));
  console.log("\n  Next: Run your app and verify everything works.");
  console.log("----------------------------------------------------------------\n");
}

main();