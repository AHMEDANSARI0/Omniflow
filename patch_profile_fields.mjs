// patch_profile_fields.mjs — Business profile form me products/policies/FAQ
// fields add karta hai (bot inhi se jawab dega).
// Chalao Omniflow website repo ke ROOT me:  node patch_profile_fields.mjs
// Backups: *.pre_fields.bak — idempotent.

import fs from "node:fs";

const ACTIONS = "app/dashboard/(portal)/profile/actions.ts";
const FORM = "app/dashboard/(portal)/profile/ProfileForm.tsx";

let actions = fs.readFileSync(ACTIONS, "utf8");
let form = fs.readFileSync(FORM, "utf8");
let changed = false;

// ---------- actions.ts ----------
if (!actions.includes("EXTENDED_FIELDS")) {
  const oldList = [
    'const OPTIONAL_FIELDS = [',
    '  "industry",',
    '  "phone",',
    '  "website",',
    '  "address",',
    '  "timezone",',
    '  "business_hours",',
    '  "default_language",',
    '] as const;',
  ].join("\n");

  const newList = [
    'const OPTIONAL_FIELDS = [',
    '  "industry",',
    '  "phone",',
    '  "website",',
    '  "address",',
    '  "timezone",',
    '  "business_hours",',
    '  "default_language",',
    '] as const;',
    '',
    'const EXTENDED_FIELDS: ReadonlyArray<readonly [string, number]> = [',
    '  ["about", 1000],',
    '  ["products", 3000],',
    '  ["policies", 2000],',
    '  ["faqs", 3000],',
    '] as const;',
  ].join("\n");

  if (actions.split(oldList).length !== 2) throw new Error("actions.ts OPTIONAL_FIELDS anchor 1x nahi mila");
  actions = actions.replace(oldList, newList);
  changed = true;
  console.log("  + actions.ts: EXTENDED_FIELDS list");

  const oldLoop = [
    '  for (const name of OPTIONAL_FIELDS) {',
    '    profile[name] = field(formData, name, 500);',
    '  }',
  ].join("\n");

  const newLoop = [
    '  for (const name of OPTIONAL_FIELDS) {',
    '    profile[name] = field(formData, name, 500);',
    '  }',
    '  for (const [name, max] of EXTENDED_FIELDS) {',
    '    profile[name] = field(formData, name, max);',
    '  }',
  ].join("\n");

  if (actions.split(oldLoop).length !== 2) throw new Error("actions.ts loop anchor 1x nahi mila");
  actions = actions.replace(oldLoop, newLoop);
  console.log("  + actions.ts: extended fields save loop");
}

// ---------- ProfileForm.tsx ----------
if (!form.includes('id="products"')) {
  const oldIface = [
    '  business_hours: string;',
    '  default_language: string;',
    '}',
  ].join("\n");

  const newIface = [
    '  business_hours: string;',
    '  default_language: string;',
    '  about: string;',
    '  products: string;',
    '  policies: string;',
    '  faqs: string;',
    '}',
  ].join("\n");

  if (form.split(oldIface).length !== 2) throw new Error("ProfileForm interface anchor 1x nahi mila");
  form = form.replace(oldIface, newIface);
  console.log("  + ProfileForm.tsx: interface fields");

  // Chhota robust anchor: section-close + Save row comment (unique)
  const oldTail = [
    '        </div>',
    '      </div>',
    '',
    '      {/* Save row */}',
  ].join("\n");

  const fieldsBlock = [
    '      <div className="space-y-4">',
    '        <div>',
    '          <label htmlFor="about" className={labelClass}>',
    '            About your business',
    '          </label>',
    '          <textarea',
    '            id="about"',
    '            name="about"',
    '            rows={2}',
    '            defaultValue={profile.about ?? ""}',
    '            placeholder="Aik line me apna business batayein"',
    '            className={inputClass}',
    '          />',
    '        </div>',
    '        <div>',
    '          <label htmlFor="products" className={labelClass}>',
    '            Products &amp; prices (har line: item — price)',
    '          </label>',
    '          <textarea',
    '            id="products"',
    '            name="products"',
    '            rows={5}',
    '            defaultValue={profile.products ?? ""}',
    '            placeholder={"LED TV 43 inch — 45,000 PKR\\nInverter AC 1 ton — 95,000 PKR"}',
    '            className={inputClass}',
    '          />',
    '        </div>',
    '        <div>',
    '          <label htmlFor="policies" className={labelClass}>',
    '            Policies (return, warranty, delivery)',
    '          </label>',
    '          <textarea',
    '            id="policies"',
    '            name="policies"',
    '            rows={3}',
    '            defaultValue={profile.policies ?? ""}',
    '            placeholder={"7 din return warranty\\nLahore me free delivery"}',
    '            className={inputClass}',
    '          />',
    '        </div>',
    '        <div>',
    '          <label htmlFor="faqs" className={labelClass}>',
    '            FAQs (har line: sawal? — jawab)',
    '          </label>',
    '          <textarea',
    '            id="faqs"',
    '            name="faqs"',
    '            rows={4}',
    '            defaultValue={profile.faqs ?? ""}',
    '            placeholder={"Delivery kitne din me hoti hai? — 2 se 3 din\\nPayment method? — Cash on delivery ya bank transfer"}',
    '            className={inputClass}',
    '          />',
    '        </div>',
    '      </div>',
  ].join("\n");

  const newTail = [
    '        </div>',
    '      </div>',
    '',
    fieldsBlock,
    '',
    '      {/* Save row */}',
  ].join("\n");

  if (form.split(oldTail).length !== 2) throw new Error("ProfileForm tail anchor 1x nahi mila");
  form = form.replace(oldTail, newTail);
  console.log("  + ProfileForm.tsx: 4 naye fields (about/products/policies/faqs)");
  changed = true;
}

if (!changed) {
  console.log("Dono files pehle se patched hain — kuch nahi kiya.");
  process.exit(0);
}

for (const [path, content] of [[ACTIONS, actions], [FORM, form]]) {
  fs.copyFileSync(path, path + ".pre_fields.bak");
  fs.writeFileSync(path, content, "utf8");
  console.log("  LIKHA: " + path + " (backup: .pre_fields.bak)");
}

console.log("");
console.log("SUCCESS! Ab yeh chalao:");
console.log('  git add "app/dashboard/(portal)/profile"');
console.log('  git commit -m "feat: business profile products/policies/FAQ fields"');
console.log("  git push");