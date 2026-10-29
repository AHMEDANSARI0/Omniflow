#!/usr/bin/env node
// ============================================================================
// PHASE 2 — Verification + CP Portal UI Refinement + Test Setup
// Run: node patcher/phase_2.mjs
// ============================================================================
// This phase:
//  1. Verifies phase_1 patches applied correctly
//  2. Creates/Updates CP Portal admin response delay UI (fallback)
//  3. Adds helper for testing response delay
//  4. Verifies WhatsApp bridge configuration
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

console.log("----------------------------------------------------------------\n");
console.log("  PHASE 2 — Verification + Setup\n");

let issues = 0;

// ============================================================================
// PART 1: Verify Phase 1 Patches
// ============================================================================

function verifyPatches() {
  console.log("--- Verification ---\n");

  // Check 1: BotConfig has responseDelaySeconds
  const portalPath = path.join(root, "lib", "omniflow", "portal.ts");
  if (fs.existsSync(portalPath)) {
    const content = fs.readFileSync(portalPath, "utf8");
    if (content.includes("responseDelaySeconds:")) {
      console.log("  ✓ BotConfig.responseDelaySeconds — PRESENT");
    } else {
      console.log("  ✗ BotConfig.responseDelaySeconds — MISSING");
      issues++;
    }
  } else {
    console.log("  ? BotConfig file not found — skipping");
  }

  // Check 2: Bot route handles responseDelaySeconds
  const botRoutePath = path.join(root, "app", "api", "omniflow", "portal", "bot", "route.ts");
  if (fs.existsSync(botRoutePath)) {
    const content = fs.readFileSync(botRoutePath, "utf8");
    if (content.includes("responseDelaySeconds: typeof payload.responseDelaySeconds")) {
      console.log("  ✓ Bot route — responseDelaySeconds handling — PRESENT");
    } else {
      console.log("  ✗ Bot route — responseDelaySeconds handling — MISSING");
      issues++;
    }
  }

  // Check 3: WhatsApp Response Delay API endpoint exists
  const endpointPath = path.join(root, "app", "api", "omniflow", "portal", "whatsapp-response-delay", "route.ts");
  if (fs.existsSync(endpointPath)) {
    console.log("  ✓ WhatsApp Response Delay API endpoint — PRESENT");
  } else {
    console.log("  ✗ WhatsApp Response Delay API endpoint — MISSING");
    issues++;
  }

  // Check 4: WhatsApp Bridge uses get_response_delay
  const bridgePath = path.join(root, "connector-bridge", "control_plane_bridge.py");
  if (fs.existsSync(bridgePath)) {
    const content = fs.readFileSync(bridgePath, "utf8");
    if (content.includes("def get_response_delay")) {
      console.log("  ✓ WhatsApp Bridge — get_response_delay method — PRESENT");
    } else if (content.includes("OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS")) {
      console.log("  ? WhatsApp Bridge — still using env variable — needs update");
      issues++;
    } else {
      console.log("  ? WhatsApp Bridge — no response delay handling found");
      issues++;
    }
  } else {
    console.log("  ? WhatsApp Bridge file not found — skipping");
  }

  console.log("");
}

// ============================================================================
// PART 2: Create Fallback CP Portal UI (if admin page not found in phase_1)
// ============================================================================

function ensureCPPortalUI() {
  console.log("--- CP Portal UI Fallback ---\n");

  // Check if any admin bot settings page exists
  const adminPaths = [
    path.join(root, "app", "admin"),
    path.join(root, "app", "(admin)"),
    path.join(root, "pages", "admin"),
    path.join(root, "components", "admin"),
  ];

  let adminFound = false;
  for (const dir of adminPaths) {
    if (fs.existsSync(dir)) {
      adminFound = true;
      break;
    }
  }

  if (!adminFound) {
    console.log("  ! No admin directory found — create fallback UI component");
    // Create a standalone settings component that can be imported
    const fallbackDir = path.join(root, "components", "admin");
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }

    const fallbackFile = path.join(fallbackDir, "BotSettingsResponseDelay.tsx");
    const fallbackContent = `/**
 * BotSettingsResponseDelay — WhatsApp Response Delay Input Component
 * Import this into your admin bot settings page.
 *
 * Usage:
 *   import BotSettingsResponseDelay from "@/components/admin/BotSettingsResponseDelay";
 *
 *   // In your settings form:
 *   <BotSettingsResponseDelay
 *     value={botSettings?.responseDelaySeconds ?? 0}
 *     onChange={(val) => setBotSettings({ ...botSettings, responseDelaySeconds: val })}
 *   />
 */

import React from "react";

interface Props {
  value: number;
  onChange: (value: number) => void;
}

export default function BotSettingsResponseDelay({ value, onChange }: Props) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 14 }}>
        WhatsApp Response Delay (seconds per client)
      </label>
      <input
        type="number"
        min={0}
        max={3600}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        placeholder="0 for instant, 120 for 2 min delay"
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid",
          borderColor: "#ccc",
          borderRadius: 4,
          fontSize: 14,
        }}
      />
      <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
        Set 0 for instant reply, or up to 3600 seconds (1 hour) max.
        This delay applies before the bot sends a WhatsApp message reply.
      </div>
    </div>
  );
}
`;
    fs.writeFileSync(fallbackFile, fallbackContent, "utf8");
    console.log("  ✓ Created BotSettingsResponseDelay.tsx (import into admin page)");
  } else {
    console.log("  = Admin directory exists — phase_1 should have handled UI");
  }

  console.log("");
}

// ============================================================================
// PART 3: Create Test Helper Script
// ============================================================================

function createTestHelper() {
  console.log("--- Test Helper ---\n");

  const testDir = path.join(root, "tools", "test");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const testFile = path.join(testDir, "test_response_delay.mjs");
  const testContent = `/**
 * Test: WhatsApp Response Delay
 * Run: node tools/test/test_response_delay.mjs
 *
 * This script tests that the WhatsApp Response Delay API endpoint
 * returns the correct delay for a given client.
 */

const BASE_URL = process.env.CP_BASE_URL || "http://localhost:3000";
const ACCESS_TOKEN = process.env.CP_ACCESS_TOKEN || "";

async function testResponseDelay(clientId, expectedDelay) {
  console.log(\`Testing response delay for client \${clientId}...\`);

  const url = \`\${BASE_URL}/api/v1/portal/whatsapp-response-delay?client_id=\${clientId}\`;

  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": \`Bearer \${ACCESS_TOKEN}\`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(\`  ✗ API returned \${response.status} \${response.statusText}\`);
      return false;
    }

    const data = await response.json();
    console.log(\`  ✓ API responded: \${JSON.stringify(data)}\`);

    if (data.responseDelaySeconds === expectedDelay) {
      console.log(\`  ✓ Delay matches expected value (\${expectedDelay}s)\`);
      return true;
    } else {
      console.log(\`  ✗ Delay mismatch: got \${data.responseDelaySeconds}, expected \${expectedDelay}\`);
      return false;
    }
  } catch (error) {
    console.log(\`  ✗ Error: \${error.message}\`);
    return false;
  }
}

// Run tests
const testClients = [
  { id: 1, delay: 0 },      // Client 1: instant
  { id: 2, delay: 120 },    // Client 2: 2 min delay
  { id: 3, delay: 60 },     // Client 3: 1 min delay
];

let passed = 0;
let failed = 0;

for (const client of testClients) {
  const result = await testResponseDelay(client.id, client.delay);
  if (result) passed++;
  else failed++;
}

console.log(\`\n--- Results ---\`);
console.log(\`  Passed: \${passed}\`);
console.log(\`  Failed: \${failed}\`);

if (failed > 0) {
  process.exit(1);
}
`;

  fs.writeFileSync(testFile, testContent, "utf8");
  console.log("  ✓ Created tools/test/test_response_delay.mjs");
  console.log("  Run: node tools/test/test_response_delay.mjs");
  console.log("");
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  verifyPatches();
  ensureCPPortalUI();
  createTestHelper();

  console.log("----------------------------------------------------------------");
  console.log("  Phase 2 Complete");
  console.log("----------------------------------------------------------------");
  console.log("  Issues found: " + issues);
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Fix any issues marked with ✗ above");
  console.log("    2. Import BotSettingsResponseDelay.tsx into admin bot settings page");
  console.log("    3. Run test: node tools/test/test_response_delay.mjs");
  console.log("    4. Test real WhatsApp messages with delay");
  console.log("----------------------------------------------------------------\n");
}

main();