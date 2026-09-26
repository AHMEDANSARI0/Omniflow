// fix_profile_english.mjs — replaces the remaining Roman Urdu labels and
// placeholders on the Business profile page with professional English.
// Run from the Omniflow website repo ROOT:  node fix_profile_english.mjs
// CRLF-tolerant, idempotent, backup: *.pre_eng.bak

import fs from "node:fs";

const FILE = "app/dashboard/(portal)/profile/ProfileForm.tsx";

const SWAPS = [
  {
    name: "About placeholder",
    from: 'placeholder="Aik line me apna business batayein"',
    to: 'placeholder="Describe your business in one line"',
  },
  {
    name: "Products label",
    from: "Products &amp; prices (har line: item — price)",
    to: "Products &amp; prices (one item per line: item — price)",
  },
  {
    name: "Policies placeholder",
    from: 'placeholder={"7 din return warranty\\nLahore me free delivery"}',
    to: 'placeholder={"7-day return warranty\\nFree delivery in Lahore"}',
  },
  {
    name: "FAQs label",
    from: "FAQs (har line: sawal? — jawab)",
    to: "FAQs (one per line: question? — answer)",
  },
  {
    name: "FAQs placeholder",
    from:
      'placeholder={"Delivery kitne din me hoti hai? — 2 se 3 din\\nPayment method? — Cash on delivery ya bank transfer"}',
    to:
      'placeholder={"How long does delivery take? — 2 to 3 days\\nPayment methods? — Cash on delivery or bank transfer"}',
  },
];

if (!fs.existsSync(FILE)) {
  console.error("FAIL: file not found: " + FILE);
  console.error("Run this script from the Omniflow website repo ROOT.");
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
    text = text.replace(swap.from, swap.to);
    applied++;
    console.log("  + " + swap.name);
  } else if (fromCount === 0 && toCount > 0) {
    already++;
    console.log("  = " + swap.name + " (already in English)");
  } else {
    missing++;
    console.log("  ? " + swap.name + " (pattern not found — report this line)");
  }
}

if (applied === 0) {
  console.log("Nothing to change — the form is already fully in English.");
  process.exit(0);
}

fs.copyFileSync(FILE, FILE + ".pre_eng.bak");
fs.writeFileSync(FILE, text, "utf8");

console.log("");
console.log(
  "SUCCESS: " + applied + " replaced, " + already + " already done" +
    (missing > 0 ? ", " + missing + " NOT FOUND (see ? lines above)" : "")
);
