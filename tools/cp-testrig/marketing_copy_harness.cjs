// Functional tests for lib/marketing/copy.ts + fields.ts (batch 218), run
// by test_marketing_copy.py. Loads the real TypeScript source through the
// repo's own `typescript` package (transpileModule) - no extra deps.
// Usage: node marketing_copy_harness.cjs <site root> <typescript module path>
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
const C = require(path.join(root, "lib/marketing/copy.ts"));
const F = require(path.join(root, "lib/marketing/fields.ts"));
const t = (name, fn) => {
  try { fn(); console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + " :: " + e.message); }
};
const keys = Object.keys(C.COPY_BLOCKS);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fieldsOf = (k) => C.copyFields(C.COPY_BLOCKS[k].defaults).flatMap((g) => g.fields);
const allFields = keys.flatMap((k) => fieldsOf(k).map((f) => [k, f]));
const firstOf = (type) => allFields.find(([, f]) => f.type === type);

t('eight blocks', () => assert.deepStrictEqual(keys, ['home_sections','home_mockups','dashboard_preview','page_heroes','page_ctas','pricing_page','about_page','other_pages']));
t('sections prefixed copy_ and unique', () => { const s = keys.map((k) => C.COPY_BLOCKS[k].section); assert.ok(s.every((x) => x.startsWith('copy_'))); assert.strictEqual(new Set(s).size, s.length); });
t('empty row -> exact defaults (every block)', () => { for (const k of keys) assert.deepStrictEqual(C.sanitizeCopy(k, {}), clone(C.COPY_BLOCKS[k].defaults), k); });
t('defaults survive sanitize (every block)', () => { for (const k of keys) assert.deepStrictEqual(C.sanitizeCopy(k, clone(C.COPY_BLOCKS[k].defaults)), clone(C.COPY_BLOCKS[k].defaults), k); });
t('garbage rows -> defaults', () => { for (const raw of [null, undefined, 'x', 5, [], true]) assert.deepStrictEqual(C.sanitizeCopy('page_heroes', raw), clone(C.COPY_BLOCKS.page_heroes.defaults)); });
t('edited text kept + trimmed', () => { const o = C.sanitizeCopy('home_sections', { templates: { title: '  New title  ' } }); assert.strictEqual(o.templates.title, 'New title'); assert.strictEqual(o.templates.copy, C.COPY_BLOCKS.home_sections.defaults.templates.copy); });
t('empty / wrong type -> default', () => { const d = C.COPY_BLOCKS.home_sections.defaults.templates; for (const bad of ['', '   ', 5, null, {}, ['x']]) assert.strictEqual(C.sanitizeCopy('home_sections', { templates: { title: bad } }).templates.title, d.title); });
t('locked id/tone keep defaults', () => { const o = C.sanitizeCopy('home_sections', { templates: { id: 'evil' } }); assert.strictEqual(o.templates.id, C.COPY_BLOCKS.home_sections.defaults.templates.id); const dash = clone(C.COPY_BLOCKS.dashboard_preview.defaults); const tones = JSON.stringify(dash).match(/"tone":"[^"]*"/g) || []; const evil = JSON.parse(JSON.stringify(dash).replace(/"tone":"[^"]*"/g, '"tone":"evil"')); assert.ok(tones.length > 0); assert.deepStrictEqual(C.sanitizeCopy('dashboard_preview', evil), dash); });
t('locked keys never become fields', () => { for (const [, f] of allFields) assert.ok(!/(^|\.)(id|tone)$/.test(f.key), f.key); });
t('every field path exists in defaults', () => { for (const [k, f] of allFields) assert.notStrictEqual(F.getPath(C.COPY_BLOCKS[k].defaults, f.key), undefined, k + ':' + f.key); });
t('labels present, groups titled', () => { for (const k of keys) for (const g of C.copyFields(C.COPY_BLOCKS[k].defaults)) { assert.ok(g.title && g.fields.length); for (const f of g.fields) assert.ok(f.label.trim(), f.key); } });
t('href fields block unsafe links', () => { const hit = firstOf('href'); assert.ok(hit, 'has href field'); const [k, f] = hit; const def = F.getPath(C.COPY_BLOCKS[k].defaults, f.key); for (const bad of ['javascript:alert(1)', '//evil.com', 'data:text/html,x']) assert.strictEqual(F.getPath(C.sanitizeCopy(k, F.setPath({}, f.key, bad)), f.key), def); assert.strictEqual(F.getPath(C.sanitizeCopy(k, F.setPath({}, f.key, '/signup')), f.key), '/signup'); });
// Edits start from the full value (as the editor does), so array paths stay arrays.
const edit = (k, key, value) => F.getPath(C.sanitizeCopy(k, F.setPath(clone(C.COPY_BLOCKS[k].defaults), key, value)), key);
t('icon fields validated', () => { const hit = firstOf('icon'); assert.ok(hit, 'has icon field'); const [k, f] = hit; const def = F.getPath(C.COPY_BLOCKS[k].defaults, f.key); assert.strictEqual(edit(k, f.key, 'nope'), def); const other = def === 'brain' ? 'target' : 'brain'; assert.strictEqual(edit(k, f.key, other), other); });
t('number fields: numeric string ok, clamp, NaN -> default', () => { const hit = firstOf('number'); assert.ok(hit, 'has number field'); const [k, f] = hit; const def = F.getPath(C.COPY_BLOCKS[k].defaults, f.key); const v = (raw) => F.getPath(C.sanitizeCopy(k, F.setPath({}, f.key, raw)), f.key); assert.strictEqual(v('42'), 42); assert.strictEqual(v(-5), 0); assert.strictEqual(v('abc'), def); assert.strictEqual(v(''), def); });
t('toggle fields need real booleans', () => { const hit = firstOf('toggle'); assert.ok(hit, 'has toggle field'); const [k, f] = hit; const def = F.getPath(C.COPY_BLOCKS[k].defaults, f.key); assert.strictEqual(edit(k, f.key, 'true'), def); assert.strictEqual(edit(k, f.key, !def), !def); });
t('lines: edited, capped, empty -> default', () => { const def = C.COPY_BLOCKS.home_sections.defaults.whyStates; assert.deepStrictEqual(C.sanitizeCopy('home_sections', { whyStates: [' a ', '', 'b'] }).whyStates, ['a', 'b']); const f = fieldsOf('home_sections').find((x) => x.key === 'whyStates'); assert.strictEqual(C.sanitizeCopy('home_sections', { whyStates: Array.from({ length: 30 }, (_, i) => 'L' + i) }).whyStates.length, f.maxLines); assert.deepStrictEqual(C.sanitizeCopy('home_sections', { whyStates: ['', ' '] }).whyStates, clone(def)); });
t('object arrays keep fixed length; nulls -> default', () => { const d = clone(C.COPY_BLOCKS.dashboard_preview.defaults); const arrKey = Object.keys(d).find((k) => Array.isArray(d[k]) && typeof d[k][0] === 'object'); assert.ok(arrKey); const long = [...d[arrKey], ...d[arrKey]]; assert.strictEqual(C.sanitizeCopy('dashboard_preview', { [arrKey]: long })[arrKey].length, d[arrKey].length); assert.deepStrictEqual(C.sanitizeCopy('dashboard_preview', { [arrKey]: [null] })[arrKey], d[arrKey]); });
t('unknown keys + __proto__ dropped', () => { const raw = JSON.parse('{"__proto__":{"polluted":1},"evil":"x","templates":{"evil":"y"}}'); const o = C.sanitizeCopy('home_sections', raw); assert.ok(!('evil' in o)); assert.ok(!('evil' in o.templates)); assert.strictEqual({}.polluted, undefined); assert.deepStrictEqual(Object.keys(o), Object.keys(C.COPY_BLOCKS.home_sections.defaults)); });
t('text length capped', () => { const f = fieldsOf('home_sections').find((x) => x.key === 'templates.title'); assert.strictEqual(C.sanitizeCopy('home_sections', { templates: { title: 'x'.repeat(5000) } }).templates.title.length, f.max); });
t('overrides: defaults -> {}', () => { for (const k of keys) assert.deepStrictEqual(C.copyOverrides(k, C.sanitizeCopy(k, {})), {}, k); });
t('overrides store only edits', () => { const v = C.sanitizeCopy('home_sections', { liveDemo: { replay: 'Again' } }); assert.deepStrictEqual(C.copyOverrides('home_sections', v), { liveDemo: { replay: 'Again' } }); });
t('overrides sparse arrays round-trip', () => { const d = clone(C.COPY_BLOCKS.dashboard_preview.defaults); const arrKey = Object.keys(d).find((k) => Array.isArray(d[k]) && typeof d[k][0] === 'object'); const f = fieldsOf('dashboard_preview').find((x) => x.key.startsWith(arrKey + '.1.') && (x.type === 'text' || x.type === 'textarea')); assert.ok(f, 'text field in item #2'); const v = C.sanitizeCopy('dashboard_preview', F.setPath(d, f.key, 'Edited')); const o = C.copyOverrides('dashboard_preview', v); assert.strictEqual(o[arrKey][0], null); assert.deepStrictEqual(C.sanitizeCopy('dashboard_preview', JSON.parse(JSON.stringify(o))), v); });
t('overrides round-trip every block', () => { for (const k of keys) { let v = clone(C.COPY_BLOCKS[k].defaults); for (const f of fieldsOf(k).filter((x) => x.type === 'text').slice(0, 3)) v = F.setPath(v, f.key, 'Edited ' + f.key); const s = C.sanitizeCopy(k, v); assert.deepStrictEqual(C.sanitizeCopy(k, JSON.parse(JSON.stringify(C.copyOverrides(k, s)))), s, k); } });
t('field types derived from key/value', () => { for (const [k, f] of allFields) { const last = f.key.split('.').pop(); const def = F.getPath(C.COPY_BLOCKS[k].defaults, f.key); if (last === 'href') assert.strictEqual(f.type, 'href', f.key); if (last === 'icon') assert.strictEqual(f.type, 'icon', f.key); if (typeof def === 'number') assert.strictEqual(f.type, 'number', f.key); if (Array.isArray(def)) assert.strictEqual(f.type, 'lines', f.key); } });
t('isCopyBlockKey', () => { assert.ok(C.isCopyBlockKey('page_heroes')); for (const bad of ['__proto__', 'toString', 'nope', 3, null]) assert.ok(!C.isCopyBlockKey(bad)); });
t('setPath array-aware + immutable', () => { const a = { rows: [{ n: 'a' }, { n: 'b' }] }; const b = F.setPath(a, 'rows.1.n', 'c'); assert.ok(Array.isArray(b.rows)); assert.strictEqual(b.rows[1].n, 'c'); assert.strictEqual(a.rows[1].n, 'b'); assert.strictEqual(b.rows[0], a.rows[0]); });
t('cleanValue toggle/number', () => { assert.strictEqual(F.cleanValue({ key: 'x', label: 'x', type: 'toggle' }, 'yes'), false); assert.strictEqual(F.cleanValue({ key: 'x', label: 'x', type: 'toggle' }, true), true); assert.strictEqual(F.cleanValue({ key: 'x', label: 'x', type: 'number' }, Infinity), undefined); });
