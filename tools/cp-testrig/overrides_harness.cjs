// Functional tests for lib/marketing/overrides.ts (§256 CMS overrides), run
// by test_cms_overrides.py. Loads the real TypeScript through the repo's own
// `typescript` package (transpileModule) - no extra deps.
// Usage: node overrides_harness.cjs <site root> <typescript module path>
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const [root, tsPath] = process.argv.slice(2);
const ts = require(tsPath);
require.extensions[".ts"] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(out.outputText, filename);
};
const O = require(path.join(root, "lib/marketing/overrides.ts"));
const C = require(path.join(root, "lib/marketing/copy.ts"));
const L = require(path.join(root, "lib/marketing/lists.ts"));
const D = require(path.join(root, "lib/content-defaults.ts"));
const t = (name, fn) => {
  try { fn(); console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + " :: " + e.message); }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const HERO = D.HERO_DEFAULTS;
// what the website renders for a stored row (lib/content.ts, lib/marketing/cms.ts)
// (section components read the default keys only; stray stored keys are never rendered)
const renderSection = (section, stored) => {
  const defaults = O.SECTION_DEFAULTS[section].defaults;
  const merged = { ...defaults, ...(stored || {}) };
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, merged[k]]));
};
const renderCopy = (key, stored) => C.sanitizeCopy(key, stored);
const renderList = (key, stored) => {
  const items = L.sanitizeList(key, (stored || {}).items);
  return items.length ? items : L.MARKETING_LISTS[key].defaults;
};
const firstLeaf = (value, prefix = "") => {
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.trim()) return prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = firstLeaf(v, prefix + k + ".");
      if (found) return found;
    }
  }
  return null;
};

t("13 section forms, each with its own defaults", () => {
  assert.deepStrictEqual(Object.keys(O.SECTION_DEFAULTS).sort(), ["ai_intelligence", "customer_memory", "faq",
    "features", "final_cta", "footer", "hero", "how_it_works", "multi_channel", "problem_solution", "trust",
    "use_cases", "why_omniflow"]);
  assert.strictEqual(O.SECTION_DEFAULTS.hero.defaults, HERO);
});
t("section defaults are flat strings (a top-level diff loses nothing)", () => {
  for (const [s, { defaults }] of Object.entries(O.SECTION_DEFAULTS)) {
    for (const [k, v] of Object.entries(defaults)) assert.strictEqual(typeof v, "string", s + "." + k);
  }
});
t("every section form saves exactly the default keys", () => {
  for (const section of Object.keys(O.SECTION_DEFAULTS)) {
    const dir = section.replace(/_/g, "-");
    const src = fs.readFileSync(path.join(root, "app/admin/(panel)/content", dir, "actions.ts"), "utf8");
    const quoted = (re) => { const m = src.match(re); return m ? [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]) : null; };
    const list = quoted(/const FIELDS = \[([\s\S]*?)\]/);
    const caseFields = quoted(/const CASE_FIELDS = \[([\s\S]*?)\]/);
    const keys = list ? list
      : caseFields ? [...quoted(/const SECTION_FIELDS = \[([\s\S]*?)\]/),
          ...[1, 2, 3, 4, 5].flatMap((i) => caseFields.map((f) => "u" + i + "_" + f))]
      : [...src.matchAll(/formData\.get\("([a-z0-9_]+)"\)/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(keys)].sort(), Object.keys(O.SECTION_DEFAULTS[section].defaults).sort(), section);
  }
});
t("sectionOverrides keeps only changed known keys", () => {
  const values = { ...HERO, heading_line1: "Sell more on WhatsApp", badge: HERO.badge, evil: "x" };
  assert.deepStrictEqual(O.sectionOverrides(values, HERO), { heading_line1: "Sell more on WhatsApp" });
  assert.deepStrictEqual(O.sectionOverrides(clone(HERO), HERO), {});
  assert.deepStrictEqual(O.sectionOverrides({ badge: "" }, HERO), { badge: "" }, "a cleared field is a real change");
});
t("form save renders exactly like the old whole-object save", () => {
  const values = { ...HERO, heading_line2: "for Pakistan", badge: "" };
  assert.deepStrictEqual(renderSection("hero", O.sectionOverrides(values, HERO)), renderSection("hero", values));
});
t("specs: sections + every copy block + every list, no collisions", () => {
  const specs = O.overrideSpecs();
  const want = Object.keys(O.SECTION_DEFAULTS).length + Object.keys(C.COPY_BLOCKS).length + Object.keys(L.MARKETING_LISTS).length;
  assert.strictEqual(Object.keys(specs).length, want);
  assert.strictEqual(specs.hero.href, "/admin/content/hero");
  assert.strictEqual(specs.final_cta.href, "/admin/content/final-cta");
  assert.strictEqual(specs.marketing_nav.kind, "list");
  assert.strictEqual(specs.copy_home_sections.href, "/admin/content/copy/home_sections");
});
t("hero override: one field, stored vs default", () => {
  const row = O.overrideRow("hero", { heading_line1: "Custom H1" });
  assert.strictEqual(row.kind, "section");
  assert.strictEqual(row.tidy, false);
  assert.deepStrictEqual(row.fields.map((f) => [f.path, f.stored, f.fallback, f.resettable]),
    [["heading_line1", "Custom H1", HERO.heading_line1, true]]);
});
t("pinned hero (old whole-object save) -> nothing overridden, tidy offered", () => {
  const row = O.overrideRow("hero", clone(HERO));
  assert.deepStrictEqual(row.fields, []);
  assert.strictEqual(row.tidy, true);
  assert.deepStrictEqual(O.tidyRow("hero", clone(HERO)), {});
});
t("empty / unknown / junk rows show nothing", () => {
  assert.strictEqual(O.overrideRow("hero", {}), null);
  assert.strictEqual(O.overrideRow("hero", null), null);
  assert.strictEqual(O.overrideRow("not_a_section", { a: 1 }), null);
  assert.ok(O.overrideRow("hero", ["x"]) === null);
});
t("unknown stored keys are tidied away (not rendered as overrides)", () => {
  const row = O.overrideRow("hero", { legacy_key: "x" });
  assert.deepStrictEqual(row.fields, []);
  assert.strictEqual(row.tidy, true);
});
t("Use default: one field back, the other override kept, pinned ones dropped", () => {
  const stored = { heading_line1: "A", description: "B", badge: HERO.badge };
  assert.deepStrictEqual(O.resetOverride("hero", stored, "heading_line1"), { description: "B" });
  assert.strictEqual(O.resetOverride("hero", stored, "nope"), null);
  assert.strictEqual(O.resetOverride("hero", stored, "__proto__"), null);
  assert.strictEqual(O.resetOverride("hero", stored, "toString"), null);
  assert.strictEqual(O.resetOverride("marketing_nav", { items: [] }, "items.0"), null, "lists reset whole only");
  assert.strictEqual(O.resetOverride("copy_home_sections", {}, "__proto__"), null, "copy paths must be own keys");
  assert.strictEqual(O.resetOverride("copy_home_sections", {}, "hero.constructor"), null);
  assert.strictEqual(O.resetOverride("copy_home_sections", {}, "hero"), null, "only leaves reset");
});
t("copy block: changed leaf listed with its label; reset hands it back", () => {
  const key = "home_sections";
  const leaf = firstLeaf(C.COPY_BLOCKS[key].defaults);
  const stored = {};
  let cursor = stored;
  const parts = leaf.split(".");
  parts.slice(0, -1).forEach((p) => { cursor = cursor[p] = {}; });
  cursor[parts[parts.length - 1]] = "Custom copy";
  const row = O.overrideRow(C.COPY_BLOCKS[key].section, stored);
  assert.strictEqual(row.kind, "copy");
  assert.deepStrictEqual(row.fields.map((f) => [f.path, f.stored]), [[leaf, "Custom copy"]]);
  assert.ok(row.fields[0].label.length > 0);
  assert.deepStrictEqual(O.resetOverride(C.COPY_BLOCKS[key].section, stored, leaf), {});
});
t("copy block equal to defaults -> tidy to {}", () => {
  for (const key of Object.keys(C.COPY_BLOCKS)) {
    const section = C.COPY_BLOCKS[key].section;
    assert.deepStrictEqual(O.tidyRow(section, clone(C.COPY_BLOCKS[key].defaults)), {}, key);
  }
});
t("list equal to defaults -> tidy; one changed item listed, list-reset only", () => {
  const key = "integrations";
  const spec = L.MARKETING_LISTS[key];
  const section = spec.section;
  assert.deepStrictEqual(O.tidyRow(section, { items: clone(spec.defaults) }), {});
  const items = clone(spec.defaults);
  items[1] = { ...items[1], [spec.titleKey]: "Renamed" };
  const row = O.overrideRow(section, { items });
  assert.strictEqual(row.kind, "list");
  assert.deepStrictEqual(row.fields.map((f) => [f.path, f.resettable]), [["items.1", false]]);
  assert.ok(row.fields[0].label.includes("Renamed"));
  assert.strictEqual(row.tidy, false);
});
t("tidying never changes what the website renders", () => {
  const leaf = firstLeaf(C.COPY_BLOCKS.home_sections.defaults);
  const cases = [
    ["hero", { ...HERO, heading_line1: "X" }], ["hero", clone(HERO)], ["hero", { junk: 1, badge: "" }],
    ["footer", { ...D.FOOTER_DEFAULTS }], ["faq", {}],
  ];
  for (const [s, stored] of cases) assert.deepStrictEqual(renderSection(s, O.tidyRow(s, stored)), renderSection(s, stored), s);
  const copyStored = clone(C.COPY_BLOCKS.home_sections.defaults);
  const parts = leaf.split(".");
  let cursor = copyStored;
  parts.slice(0, -1).forEach((p) => { cursor = cursor[p]; });
  cursor[parts[parts.length - 1]] = "Changed";
  copyStored.unknown = "x";
  assert.deepStrictEqual(renderCopy("home_sections", O.tidyRow("copy_home_sections", copyStored)), renderCopy("home_sections", copyStored));
  for (const key of Object.keys(L.MARKETING_LISTS)) {
    const spec = L.MARKETING_LISTS[key];
    for (const stored of [{ items: clone(spec.defaults) }, { items: [] }, { items: "junk" }, {}]) {
      assert.deepStrictEqual(renderList(key, O.tidyRow(spec.section, stored)), renderList(key, stored), key);
    }
  }
});
t("same content regardless of key order (what the list editor stores)", () => {
  assert.ok(O.sameContent({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 }));
  assert.ok(!O.sameContent([1, 2], [2, 1]));
  for (const key of Object.keys(L.MARKETING_LISTS)) {
    if (key === "story") continue; // the sanitizer rewrites story defaults (never tidied unless equal)
    const spec = L.MARKETING_LISTS[key];
    assert.ok(O.sameContent(L.sanitizeList(key, spec.defaults), spec.defaults), key);
  }
});
t("long values shortened for display only", () => {
  const row = O.overrideRow("hero", { description: "y".repeat(400) });
  assert.ok(row.fields[0].stored.length <= 160 && row.fields[0].stored.endsWith("..."));
});
