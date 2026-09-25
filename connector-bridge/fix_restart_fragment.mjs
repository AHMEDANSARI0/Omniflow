// fix_restart_fragment.mjs — repairs the JSX parse error on the WhatsApp page:
// the "connected" branch now renders two buttons (Disconnect + Restart), and a
// ternary branch must return a single element, so both buttons are wrapped in
// a React fragment (<> ... </>).
//
// Run from the bot ROOT (the folder containing the Omniflow/ folder):
//   node fix_restart_fragment.mjs
//
// CRLF-tolerant, idempotent, backup: *.pre_frag.bak

import fs from "node:fs";

const FILE = "Omniflow/app/dashboard/(portal)/channels/whatsapp/page.tsx";

const SWAPS = [
  {
    name: "open fragment before Disconnect button",
    from: `            {state === "connected" ? (
              <button
                onClick={() => void runAction("disconnect")}`,
    to: `            {state === "connected" ? (
              <>
              <button
                onClick={() => void runAction("disconnect")}`,
  },
  {
    name: "close fragment after Restart button",
    from: `                {busy ? "Working…" : "Restart session"}
              </button>
            ) : (`,
    to: `                {busy ? "Working…" : "Restart session"}
              </button>
              </>
            ) : (`,
  },
];

if (!fs.existsSync(FILE)) {
  console.error("FAIL: file not found: " + FILE);
  console.error("Run this script from the bot ROOT (the folder with Omniflow/).");
  process.exit(1);
}

let text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

let applied = 0;
let already = 0;
let missing = 0;

for (const swap of SWAPS) {
  const fromCount = text.split(swap.from).length - 1;
  const toCount = text.split(swap.to).length - 1;

  if (fromCount === 1) {
    text = text.split(swap.from).join(swap.to);
    applied++;
    console.log("  + " + swap.name);
  } else if (fromCount === 0 && toCount > 0) {
    already++;
    console.log("  = " + swap.name + " (already done)");
  } else {
    missing++;
    console.log("  ? " + swap.name + " NOT FOUND — report this line");
  }
}

if (applied === 0) {
  console.log("Nothing to change — fragment already in place.");
  process.exit(0);
}

fs.copyFileSync(FILE, FILE + ".pre_frag.bak");
fs.writeFileSync(FILE, text, "utf8");

console.log("");
console.log(
  "SUCCESS: " + applied + " applied, " + already + " already done" +
    (missing > 0 ? ", " + missing + " NOT FOUND (see ? lines above)" : "")
);
