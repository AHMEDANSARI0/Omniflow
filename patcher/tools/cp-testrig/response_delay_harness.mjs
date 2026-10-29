/**
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
  console.log(`Setting response delay for client ${clientId}: ${delaySeconds}s`);

  try {
    const response = await fetch(`${config.cpUrl}/api/v1/portal/bot`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${config.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        responseDelaySeconds: delaySeconds,
      }),
    });

    if (!response.ok) {
      console.log(`  ✗ Failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    console.log(`  ✓ Set successfully: ${JSON.stringify(data)}`);
    return true;
  } catch (error) {
    console.log(`  ✗ Error: ${error.message}`);
    return false;
  }
}

async function getResponseDelay(clientId) {
  console.log(`Getting response delay for client ${clientId}...`);

  try {
    const response = await fetch(`${config.cpUrl}/api/v1/portal/whatsapp-response-delay?client_id=${clientId}`, {
      headers: {
        "Authorization": `Bearer ${config.adminToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`  ✗ Failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    console.log(`  ✓ Delay: ${data.responseDelaySeconds}s`);
    return data.responseDelaySeconds;
  } catch (error) {
    console.log(`  ✗ Error: ${error.message}`);
    return null;
  }
}

async function runTests() {
  console.log("=== Response Delay Admin Test Harness ===
");

  // Test 1: Set delays for all test clients
  console.log("--- Step 1: Set Response Delays ---");
  for (const clientId of config.testClientIds) {
    const delay = clientId * 30; // Client 1: 30s, Client 2: 60s, Client 3: 90s
    await setResponseDelay(clientId, delay);
  }

  // Test 2: Verify delays
  console.log("
--- Step 2: Verify Response Delays ---");
  for (const clientId of config.testClientIds) {
    const delay = await getResponseDelay(clientId);
    if (delay !== null) {
      console.log(`  Client ${clientId}: ${delay}s (expected: ${clientId * 30}s)`);
    }
  }

  console.log("
--- Test Complete ---");
}

runTests().catch(console.error);
