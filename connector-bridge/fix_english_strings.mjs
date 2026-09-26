// fix_english_strings.mjs — Roman Urdu strings ko professional English me
// badalta hai (portal_agent_config.py, portal_business_profile.py,
// ProfileForm.tsx). Bot root me chalao:  node fix_english_strings.mjs
// Idempotent — sirf mojood strings ko badalta hai.

import fs from "node:fs";

const SWAPS = [
  {
    file: "src/portal_agent_config.py",
    from: "Warm, friendly and casual — jaise dost se baat.",
    to: "Warm, friendly and casual.",
  },
  {
    file: "src/portal_agent_config.py",
    from:
      "(aap isay apne alfaaz me thoda adjust kar sakte ho): ",
    to: "(you may rephrase it slightly in your own words): ",
  },
  {
    file: "src/portal_agent_config.py",
    from:
      '"Human handoff is ON: agar customer insaan se baat karna chahe ya "',
    to:
      '"Human handoff is ON: if the customer asks for a human agent or the "',
  },
  {
    file: "src/portal_agent_config.py",
    from:
      '"masla hal na ho, batao ke \'hamari team jald rabta karegi\' — argument "',
    to:
      '"issue cannot be resolved, politely say the team will follow up — "',
  },
  {
    file: "src/portal_agent_config.py",
    from: '"mat karo."',
    to: '"do not argue."',
  },
  {
    file: "src/portal_business_profile.py",
    from:
      '"BUSINESS PROFILE (owner ne yeh information di hai — customer ke "',
    to:
      '"BUSINESS PROFILE (provided by the owner — answer customer questions "',
  },
  {
    file: "src/portal_business_profile.py",
    from:
      '"sawalat ke jawabat pehle isi se do; jo yahan nahi hai woh ghumao "',
    to:
      '"from this information first; if something is not covered here, say "',
  },
  {
    file: "src/portal_business_profile.py",
    from: '"mat, saaf mana kar do):"',
    to: '"you will check with the team. Never invent information):"',
  },
  {
    file: "src/portal_business_profile.py",
    from:
      "- (aur bhi information maujood hai — zaroorat par " +
      "owner se poochna)",
    to: "- (more information is available — check with the owner when needed)",
  },
  {
    file: "../Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    from: "Aik line me apna business batayein",
    to: "One line about your business",
  },
  {
    file: "../Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    from: "Products &amp; prices (har line: item — price)",
    to: "Products &amp; prices (one item per line: item — price)",
  },
  {
    file: "../Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    from: '{"7 din return warranty\\nLahore me free delivery"}',
    to: '{"7-day return warranty\\nFree delivery in Lahore"}',
  },
  {
    file: "../Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    from: "FAQs (har line: sawal? — jawab)",
    to: "FAQs (one per line: question? — answer)",
  },
  {
    file: "../Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    from:
      '{"Delivery kitne din me hoti hai? — 2 se 3 din\\nPayment method? — Cash on delivery ya bank transfer"}',
    to:
      '{"How long does delivery take? — 2 to 3 days\\nPayment methods? — Cash on delivery or bank transfer"}',
  },
];

let applied = 0;
let skipped = 0;

for (const swap of SWAPS) {
  if (!fs.existsSync(swap.file)) {
    console.log("  SKIP (file nahi mili): " + swap.file);
    skipped++;
    continue;
  }

  const original = fs.readFileSync(swap.file, "utf8");

  if (!original.includes(swap.from)) {
    skipped++;
    continue;
  }

  fs.writeFileSync(
    swap.file,
    original.split(swap.from).join(swap.to),
    "utf8"
  );
  applied++;
  console.log("  + " + swap.file + ": English fix");
}

console.log("");
console.log(
  "Ho gaya: " + applied + " badla, " + skipped + " pehle se theek/skip"
);
