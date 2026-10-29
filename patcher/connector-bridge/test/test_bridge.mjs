/**
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
    const cpResponse = await fetch(`${BRIDGE_CONFIG.cpBaseUrl}/api/v1/portal/whatsapp-response-delay?client_id=${BRIDGE_CONFIG.clientId}`, {
      headers: {
        "Authorization": `Bearer ${BRIDGE_CONFIG.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!cpResponse.ok) {
      console.log(`  ✗ CP connection failed: ${cpResponse.status}`);
      return false;
    }

    const data = await cpResponse.json();
    console.log(`  ✓ CP connected — response delay: ${data.responseDelaySeconds}s`);

    // Test 2: Verify delay is a valid number
    if (typeof data.responseDelaySeconds !== "number") {
      console.log(`  ✗ Invalid delay type: ${typeof data.responseDelaySeconds}`);
      return false;
    }

    if (data.responseDelaySeconds < 0 || data.responseDelaySeconds > 3600) {
      console.log(`  ✗ Delay out of range: ${data.responseDelaySeconds}`);
      return false;
    }

    console.log(`  ✓ Delay valid (0-3600 range)`);
    return true;

  } catch (error) {
    console.log(`  ✗ Error: ${error.message}`);
    return false;
  }
}

async function simulateWhatsAppMessage() {
  console.log("
Simulating WhatsApp message with delay...");

  const delay = 120; // 2 minutes for testing
  console.log(`  Setting delay: ${delay}s`);

  const startTime = Date.now();

  // Simulate delay
  await new Promise(resolve => setTimeout(resolve, Math.min(delay, 5000))); // Max 5s for test

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`  Elapsed: ${elapsed.toFixed(1)}s`);

  if (elapsed >= delay * 0.8) {
    console.log(`  ✓ Delay simulation passed`);
    return true;
  } else {
    console.log(`  ✗ Delay too short`);
    return false;
  }
}

// Run tests
console.log("=== WhatsApp Bridge Test Suite ===
");

const connectionOk = await testBridgeConnection();
const delayOk = await simulateWhatsAppMessage();

console.log("
--- Results ---");
console.log(`  Connection: ${connectionOk ? "PASS" : "FAIL"}`);
console.log(`  Delay Test: ${delayOk ? "PASS" : "FAIL"}`);

if (connectionOk && delayOk) {
  console.log("
  ✓ All tests passed");
  process.exit(0);
} else {
  console.log("
  ✗ Some tests failed");
  process.exit(1);
}
