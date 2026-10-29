/**
 * Test: WhatsApp Response Delay
 * Run: node tools/test/test_response_delay.mjs
 *
 * This script tests that the WhatsApp Response Delay API endpoint
 * returns the correct delay for a given client.
 */

const BASE_URL = process.env.CP_BASE_URL || "http://localhost:3000";
const ACCESS_TOKEN = process.env.CP_ACCESS_TOKEN || "";

async function testResponseDelay(clientId, expectedDelay) {
  console.log(`Testing response delay for client ${clientId}...`);

  const url = `${BASE_URL}/api/v1/portal/whatsapp-response-delay?client_id=${clientId}`;

  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`  ✗ API returned ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    console.log(`  ✓ API responded: ${JSON.stringify(data)}`);

    if (data.responseDelaySeconds === expectedDelay) {
      console.log(`  ✓ Delay matches expected value (${expectedDelay}s)`);
      return true;
    } else {
      console.log(`  ✗ Delay mismatch: got ${data.responseDelaySeconds}, expected ${expectedDelay}`);
      return false;
    }
  } catch (error) {
    console.log(`  ✗ Error: ${error.message}`);
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

console.log(`
--- Results ---`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
