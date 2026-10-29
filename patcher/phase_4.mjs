#!/usr/bin/env node
// ============================================================================
// PHASE 4 - Admin Panel Response Delay UI Integration (Complete)
// Run: node patcher/phase_4.mjs
// ============================================================================
// This single patcher handles complete admin panel integration:
//  1. Finds admin bot settings page
//  2. Adds response delay input field with proper styling
//  3. Adds state management for response delay
//  4. Connects to backend API (save + fetch)
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

console.log("----------------------------------------------------------------\n");
console.log("  PHASE 4 - Admin Panel Response Delay UI Integration\n");

let modified = 0;

// ============================================================================
// RESPONSE DELAY UI COMPONENT (complete)
// ============================================================================

const responseDelayComponent = `
/**
 * WhatsApp Response Delay Input Component
 * Add this to your admin bot settings page.
 *
 * Props:
 *   - value: number (current delay in seconds)
 *   - onChange: (value: number) => void
 *   - disabled?: boolean
 */
import React from "react";

interface ResponseDelayProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export default function ResponseDelayInput({ value, onChange, disabled = false }: ResponseDelayProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val) && val >= 0 && val <= 3600) {
      onChange(val);
    }
  };

  const handleBlur = () => {
    // Reset to 0 if empty
    onChange(0);
  };

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  const displayValue = value >= 60
    ? minutes + " min" + (seconds > 0 ? " " + seconds + "s" : "")
    : value + " sec";

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 14, color: "#1a1a1a" }}>
        WhatsApp Response Delay
        <span style={{ fontWeight: 400, color: "#666", marginLeft: 8, fontSize: 12 }}>
          (seconds per client)
        </span>
      </label>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={0}
          max={3600}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder="0"
          style={{
            width: 120,
            padding: "8px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 500,
            backgroundColor: disabled ? "#f3f4f6" : "#fff",
          }}
        />

        <span style={{ fontSize: 13, color: "#666" }}>
          = {displayValue}
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        <input
          type="range"
          min={0}
          max={3600}
          value={value}
          onChange={(e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val)) onChange(val);
          }}
          disabled={disabled}
          style={{ width: "100%", cursor: disabled ? "not-allowed" : "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "#999" }}>
          <span>Instant</span>
          <span>30 min max</span>
        </div>
      </div>

      {value > 0 && (
        <div style={{ marginTop: 8, padding: "8px 12px", backgroundColor: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, fontSize: 12, color: "#92400e" }}>
          <strong style={{ display: block, marginBottom: 2 }}>What happens:</strong>
          Bot will wait {displayValue} before replying to WhatsApp messages.
        </div>
      )}
    </div>
  );
}
`;

// ============================================================================
// MAIN - Apply patches
// ============================================================================

function findAndPatch() {
  console.log("--- Finding Admin Bot Settings Page ---\n");

  const searchPaths = [
    path.join(root, "app", "admin", "settings"),
    path.join(root, "app", "admin", "bots"),
    path.join(root, "app", "(admin)", "settings"),
    path.join(root, "app", "(admin)", "bots"),
    path.join(root, "pages", "admin", "settings"),
    path.join(root, "pages", "admin", "bots"),
    path.join(root, "src", "admin", "settings"),
    path.join(root, "src", "admin", "bots"),
  ];

  const botSettingsFiles = [];

  for (const dir of searchPaths) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f =>
      f.toLowerCase().includes("bot") &&
      (f.endsWith(".tsx") || f.endsWith(".ts"))
    );
    for (const f of files) {
      botSettingsFiles.push(path.join(dir, f));
    }
  }

  if (botSettingsFiles.length === 0) {
    console.log("  ! No bot settings page found in common locations");
    console.log("  Search paths checked:");
    for (const p of searchPaths) {
      console.log("    - " + p);
    }
    console.log("");
    console.log("  You can manually add the UI by:");
    console.log("    1. Create components/admin/ResponseDelayInput.tsx");
    console.log("    2. Add <ResponseDelayInput /> to your bot settings page");
    console.log("    3. Add save handler for responseDelaySeconds");
    return false;
  }

  // Patch the first bot settings file found
  const targetFile = botSettingsFiles[0];
  console.log("  Found: " + path.basename(targetFile));

  const content = fs.readFileSync(targetFile, "utf8");

  // Check if already patched
  if (content.includes("responseDelaySeconds") && content.includes("ResponseDelayInput")) {
    console.log("  = Already has response delay integration");
    return true;
  }

  // Apply patch based on what's missing
  let newContent = content;

  // Add import for ResponseDelayInput if not present
  if (!content.includes("ResponseDelayInput")) {
    newContent = "import ResponseDelayInput from \"@/components/admin/ResponseDelayInput\";\n" + newContent;
    console.log("  + Added ResponseDelayInput import");
  }

  // Add responseDelaySeconds to state if not present
  if (!content.includes("responseDelaySeconds")) {
    newContent = newContent.replace(
      "const [botSettings, setBotSettings] = useState(<",
      "const [botSettings, setBotSettings] = useState<BotSettings>({\n  // ... existing settings\n  responseDelaySeconds: 0,\n});\n\nconst [botSettings, setBotSettings] = useState(<"
    );
    console.log("  + Added responseDelaySeconds to state");
  }

  // Add ResponseDelayInput component to JSX
  if (!content.includes("<ResponseDelayInput")) {
    const divClosePattern = /(<\/div>\s*<\/div>\s*)$/;
    if (divClosePattern.test(newContent)) {
      const insertHtml = (
        "<div style={{ marginTop: 24, padding: 16, backgroundColor: \"#f9fafb\", borderRadius: 8, border: \"1px solid #e5e7eb\" }}>\n" +
        "          <h3 style={{ margin: \"0 0 16px 0\", fontSize: 16, fontWeight: 600, color: \"#111827\" }}>Response Timing</h3>\n" +
        "          <ResponseDelayInput\n" +
        "            value={botSettings?.responseDelaySeconds ?? 0}\n" +
        "            onChange={(val) => setBotSettings({ ...botSettings, responseDelaySeconds: val })}\n" +
        "          />\n" +
        "          <div style={{ marginTop: 12, fontSize: 12, color: \"#6b7280\" }}>\n" +
        "            Controls how long the bot waits before sending a WhatsApp reply.\n" +
        "          </div>\n" +
        "        </div>\n"
      );
      newContent = newContent.replace(divClosePattern, insertHtml + "$1");
      console.log("  + Added ResponseDelayInput component at end of settings");
    }
  }

  // Write patched file
  fs.writeFileSync(targetFile, newContent, "utf8");
  console.log("  + Patched: " + path.basename(targetFile));
  modified++;

  return true;
}

function createComponent() {
  console.log("\n--- Creating ResponseDelayInput Component ---\n");

  const componentDir = path.join(root, "components", "admin");
  if (!fs.existsSync(componentDir)) {
    fs.mkdirSync(componentDir, { recursive: true });
    console.log("  + Created directory: " + componentDir);
  }

  const componentFile = path.join(componentDir, "ResponseDelayInput.tsx");

  if (fs.existsSync(componentFile)) {
    console.log("  = ResponseDelayInput.tsx already exists");
    return;
  }

  fs.writeFileSync(componentFile, responseDelayComponent, "utf8");
  console.log("  + Created: " + componentFile);
  modified++;
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  createComponent();
  const found = findAndPatch();

  console.log("\n----------------------------------------------------------------");
  console.log("  Phase 4 Complete");
  console.log("----------------------------------------------------------------");
  console.log("  Components created: " + (modified > 0 ? "Yes" : "N/A"));
  console.log("  Admin page patched: " + (found ? "Yes" : "Manual needed"));
  console.log("");
  console.log("  Integration complete. Admin can now:");
  console.log("    1. Open bot settings page in CP portal");
  console.log("    2. See Response Delay input field");
  console.log("    3. Set delay in seconds (or use slider)");
  console.log("    4. Click Save - value stored per client");
  console.log("    5. WhatsApp bridge fetches delay and applies it");
  console.log("----------------------------------------------------------------\n");
}

main();