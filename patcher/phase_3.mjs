#!/usr/bin/env node
// ============================================================================
// PHASE 3 — Testing + WhatsApp Bridge Deployment Setup
// Run: node patcher/phase_3.mjs
// ============================================================================
// This phase:
//  1. Creates WhatsApp bridge test script
//  2. Verifies bridge configuration
//  3. Creates admin test harness
//  4. Provides deployment checklist
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

console.log("----------------------------------------------------------------\n");
console.log("  PHASE 3 — Testing + Bridge Setup\n");

// ============================================================================
// PART 1: WhatsApp Bridge Test Script
// ============================================================================

function createBridgeTest() {
  console.log("--- WhatsApp Bridge Test ---\n");

  const testDir = path.join(root, "connector-bridge", "test");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const testFile = path.join(testDir, "test_bridge.mjs");
  const testContent = `/**
 * WhatsApp Bridge Test Script
 * Run: node connector-bridge/test/test_bridge.mjs
 *
 * Tests the WhatsApp bridge connection and response delay functionality.
 */

const BRIDGE_CONFIG = {
  cpBaseUrl: process.env.CP_BASE_URL || "http://localhost:3000",
  clientId: parseInt(process.env.TEST_CLIENT_ID || "1"),
  accessToken: process.env.CP_ACCESS_TOKEN || "",
};

async function testBridgeConnection() {
  console.log("Testing WhatsApp Bridge connection...");

  try {
    // Test 1: CP connection
    const cpResponse = await fetch(\`\${BRIDGE_CONFIG.cpBaseUrl}/api/v1/portal/whatsapp-response-delay?client_id=\${BRIDGE_CONFIG.clientId}\`, {
      headers: {
        "Authorization": \`Bearer \${BRIDGE_CONFIG.accessToken}\`,
        "Content-Type": "application/json",
      },
    });

    if (!cpResponse.ok) {
      console.log(\`  ✗ CP connection failed: \${cpResponse.status}\`);
      return false;
    }

    const data = await cpResponse.json();
    console.log(\`  ✓ CP connected — response delay: \${data.responseDelaySeconds}s\`);

    // Test 2: Verify delay is a valid number
    if (typeof data.responseDelaySeconds !== "number") {
      console.log(\`  ✗ Invalid delay type: \${typeof data.responseDelaySeconds}\`);
      return false;
    }

    if (data.responseDelaySeconds < 0 || data.responseDelaySeconds > 3600) {
      console.log(\`  ✗ Delay out of range: \${data.responseDelaySeconds}\`);
      return false;
    }

    console.log(\`  ✓ Delay valid (0-3600 range)\`);
    return true;

  } catch (error) {
    console.log(\`  ✗ Error: \${error.message}\`);
    return false;
  }
}

async function simulateWhatsAppMessage() {
  console.log("\nSimulating WhatsApp message with delay...");

  const delay = 120; // 2 minutes for testing
  console.log(\`  Setting delay: \${delay}s\`);

  const startTime = Date.now();

  // Simulate delay
  await new Promise(resolve => setTimeout(resolve, Math.min(delay, 5000))); // Max 5s for test

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(\`  Elapsed: \${elapsed.toFixed(1)}s\`);

  if (elapsed >= delay * 0.8) {
    console.log(\`  ✓ Delay simulation passed\`);
    return true;
  } else {
    console.log(\`  ✗ Delay too short\`);
    return false;
  }
}

// Run tests
console.log("=== WhatsApp Bridge Test Suite ===\n");

const connectionOk = await testBridgeConnection();
const delayOk = await simulateWhatsAppMessage();

console.log("\n--- Results ---");
console.log(\`  Connection: \${connectionOk ? "PASS" : "FAIL"}\`);
console.log(\`  Delay Test: \${delayOk ? "PASS" : "FAIL"}\`);

if (connectionOk && delayOk) {
  console.log("\n  ✓ All tests passed");
  process.exit(0);
} else {
  console.log("\n  ✗ Some tests failed");
  process.exit(1);
}
`;

  fs.writeFileSync(testFile, testContent, "utf8");
  console.log("  ✓ Created connector-bridge/test/test_bridge.mjs");
  console.log("  Run: node connector-bridge/test/test_bridge.mjs");
  console.log("");
}

// ============================================================================
// PART 2: Admin Test Harness
// ============================================================================

function createAdminTestHarness() {
  console.log("--- Admin Test Harness ---\n");

  const harnessDir = path.join(root, "tools", "cp-testrig");
  if (!fs.existsSync(harnessDir)) {
    fs.mkdirSync(harnessDir, { recursive: true });
  }

  const harnessFile = path.join(harnessDir, "response_delay_harness.mjs");
  const harnessContent = `/**
 * Response Delay Admin Test Harness
 * Run: node tools/cp-testrig/response_delay_harness.mjs
 *
 * Tests the complete response delay flow from admin to WhatsApp.
 */

const config = {
  cpUrl: process.env.CP_URL || "http://localhost:3000",
  adminToken: process.env.ADMIN_TOKEN || "",
  testClientIds: [1, 2, 3],
};

async function setResponseDelay(clientId, delaySeconds) {
  console.log(\`Setting response delay for client \${clientId}: \${delaySeconds}s\`);

  try {
    const response = await fetch(\`\${config.cpUrl}/api/v1/portal/bot\`, {
      method: "PUT",
      headers: {
        "Authorization": \`Bearer \${config.adminToken}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        responseDelaySeconds: delaySeconds,
      }),
    });

    if (!response.ok) {
      console.log(\`  ✗ Failed: \${response.status} \${response.statusText}\`);
      return false;
    }

    const data = await response.json();
    console.log(\`  ✓ Set successfully: \${JSON.stringify(data)}\`);
    return true;
  } catch (error) {
    console.log(\`  ✗ Error: \${error.message}\`);
    return false;
  }
}

async function getResponseDelay(clientId) {
  console.log(\`Getting response delay for client \${clientId}...\`);

  try {
    const response = await fetch(\`\${config.cpUrl}/api/v1/portal/whatsapp-response-delay?client_id=\${clientId}\`, {
      headers: {
        "Authorization": \`Bearer \${config.adminToken}\`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(\`  ✗ Failed: \${response.status}\`);
      return null;
    }

    const data = await response.json();
    console.log(\`  ✓ Delay: \${data.responseDelaySeconds}s\`);
    return data.responseDelaySeconds;
  } catch (error) {
    console.log(\`  ✗ Error: \${error.message}\`);
    return null;
  }
}

async function runTests() {
  console.log("=== Response Delay Admin Test Harness ===\n");

  // Test 1: Set delays for all test clients
  console.log("--- Step 1: Set Response Delays ---");
  for (const clientId of config.testClientIds) {
    const delay = clientId * 30; // Client 1: 30s, Client 2: 60s, Client 3: 90s
    await setResponseDelay(clientId, delay);
  }

  // Test 2: Verify delays
  console.log("\n--- Step 2: Verify Response Delays ---");
  for (const clientId of config.testClientIds) {
    const delay = await getResponseDelay(clientId);
    if (delay !== null) {
      console.log(\`  Client \${clientId}: \${delay}s (expected: \${clientId * 30}s)\`);
    }
  }

  console.log("\n--- Test Complete ---");
}

runTests().catch(console.error);
`;

  fs.writeFileSync(harnessFile, harnessContent, "utf8");
  console.log("  ✓ Created tools/cp-testrig/response_delay_harness.mjs");
  console.log("  Run: node tools/cp-testrig/response_delay_harness.mjs");
  console.log("");
}

// ============================================================================
// PART 3: Deployment Checklist
// ============================================================================

function printChecklist() {
  console.log("--- Deployment Checklist ---\n");
  console.log(`  BEFORE PRODUCTION DEPLOYMENT:

  1. WhatsApp Bridge Configuration
     - [ ] Set CP_BASE_URL in bridge environment
     - [ ] Set CP_ACCESS_TOKEN in bridge environment
     - [ ] Test bridge connection: node connector-bridge/test/test_bridge.mjs

  2. Admin Panel
     - [ ] Bot settings page has response delay input
     - [ ] Admin can set delay per client (seconds)
     - [ ] Values save correctly to backend

  3. API Endpoints
     - [ ] GET /api/v1/portal/whatsapp-response-delay?client_id=X works
     - [ ] Bot route saves responseDelaySeconds correctly

  4. Testing
     - [ ] Run test harness: node tools/cp-testrig/response_delay_harness.mjs
     - [ ] Send WhatsApp message, verify delay works

  5. Production
     - [ ] WhatsApp Business API connected
     - [ ] Bridge deployed and running
     - [ ] CP portal accessible
`);
  console.log("");
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  createBridgeTest();
  createAdminTestHarness();
  printChecklist();

  console.log("----------------------------------------------------------------");
  console.log("  Phase 3 Complete");
  console.log("----------------------------------------------------------------");
  console.log("  Files created:");
  console.log("    - connector-bridge/test/test_bridge.mjs");
  console.log("    - tools/cp-testrig/response_delay_harness.mjs");
  console.log("");
  console.log("  Next: Run tests, then deploy bridge.");
  console.log("----------------------------------------------------------------\n");
}

main();