// Functional tests for lib/marketing/lists.ts (batches 217-218), run by
// test_marketing_lists.py. Loads the real TypeScript source through the
// repo's own `typescript` package (transpileModule) - no extra deps.
// Usage: node marketing_lists_harness.cjs <site root> <typescript module path>
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
const L = require(path.join(root, "lib/marketing/lists.ts"));
const F = require(path.join(root, "lib/marketing/fields.ts"));
const t = (name, fn) => {
  try { fn(); console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + " :: " + e.message); }
};
const keys = Object.keys(L.MARKETING_LISTS);
t('eleven lists', () => assert.deepStrictEqual(keys, ['templates','integrations','demo','story','nav','footer','pricing_plans','feature_pillars','about_values','security_areas','use_case_samples']));
t('defaults survive sanitize unchanged (every list)', () => { for (const k of keys) { const spec = L.MARKETING_LISTS[k]; const out = L.sanitizeList(k, spec.defaults); assert.strictEqual(out.length, spec.defaults.length, k); if (k !== 'story') assert.deepStrictEqual(out, JSON.parse(JSON.stringify(spec.defaults)), k); } });
t('non-array -> []', () => { for (const raw of [null, undefined, {}, 'x', 5]) assert.deepStrictEqual(L.sanitizeList('nav', raw), []); });
t('drops item missing required', () => assert.strictEqual(L.sanitizeList('nav', [{label:'A', href:'/a'}, {label:'', href:'/b'}, {label:'C'}]).length, 1));
t('blocks javascript: and protocol-relative href', () => assert.deepStrictEqual(L.sanitizeList('nav', [{label:'x',href:'javascript:alert(1)'},{label:'y',href:'//evil.com'},{label:'z',href:'https://ok.com'},{label:'w',href:'#top'},{label:'m',href:'mailto:a@b.c'}]).map(i=>i.label), ['z','w','m']));
t('invalid select/status dropped', () => assert.strictEqual(L.sanitizeList('integrations', [{...L.MARKETING_LISTS.integrations.defaults[0], status:'gold'}]).length, 0));
t('bad colour dropped, bad optional icon omitted', () => { const base = L.MARKETING_LISTS.integrations.defaults[0]; assert.strictEqual(L.sanitizeList('integrations',[{...base, accent:'red;}'}]).length,0); const o = L.sanitizeList('integrations',[{...base, icon:'nope'}])[0]; assert.ok(!('icon' in o)); });
t('slug auto + unique', () => { const b = {...L.MARKETING_LISTS.templates.defaults[0]}; const out = L.sanitizeList('templates', [{...b, id:''}, {...b, id:''}, {...b, id:'Hello World!'}]); assert.deepStrictEqual(out.map(i=>i.id), ['sales-qualification','sales-qualification-2','hello-world']); });
t('lines: string or array, trimmed, capped at 6', () => { const b = L.MARKETING_LISTS.templates.defaults[0]; assert.deepStrictEqual(L.sanitizeList('templates',[{...b, steps:' a \n\n b '}])[0].steps, ['a','b']); assert.strictEqual(L.sanitizeList('templates',[{...b, steps:['1','2','3','4','5','6','7','8']}])[0].steps.length, 6); assert.strictEqual(L.sanitizeList('templates',[{...b, steps:['', ' ']}]).length, 0); });
t('nested path demo customer', () => { const d = L.MARKETING_LISTS.demo.defaults[0]; assert.strictEqual(L.sanitizeList('demo',[{...d, customer:{name:'', message:'x'}}]).length, 0); assert.strictEqual(L.sanitizeList('demo',[d])[0].customer.name, d.customer.name); });
t('strips unknown keys', () => { const o = L.sanitizeList('nav',[{label:'a',href:'/a', evil:'<script>'}])[0]; assert.deepStrictEqual(Object.keys(o).sort(), ['href','label']); });
t('length caps', () => assert.strictEqual(L.sanitizeList('nav',[{label:'x'.repeat(500), href:'/a'}])[0].label.length, 30));
t('maxItems cap', () => assert.strictEqual(L.sanitizeList('nav', Array.from({length:20},(_,i)=>({label:'L'+i,href:'/'+i}))).length, 8));
t('fixed story needs exactly 6', () => { const s = L.MARKETING_LISTS.story.defaults; assert.strictEqual(L.sanitizeList('story', s.slice(0,5)).length, 0); assert.strictEqual(L.sanitizeList('story', s).length, 6); });
t('groupFooterLinks keeps order', () => { const g = L.groupFooterLinks([{column:'A',label:'1',href:'/1'},{column:'B',label:'2',href:'/2'},{column:'A',label:'3',href:'/3'}]); assert.deepStrictEqual(g.map(c=>[c.title,c.links.length]), [['A',2],['B',1]]); });
t('footer defaults round-trip to same columns', () => { const g = L.groupFooterLinks(L.MARKETING_LISTS.footer.defaults); assert.deepStrictEqual(g.map(c=>c.title), ['Product','Solutions','Integrations','Resources','Company','Legal']); });
t('isMarketingListKey', () => { assert.ok(L.isMarketingListKey('nav')); assert.ok(!L.isMarketingListKey('__proto__')); assert.ok(!L.isMarketingListKey('toString')); assert.ok(!L.isMarketingListKey(3)); });
t('setPath immutable', () => { const a = {customer:{name:'x'}}; const b = F.setPath(a,'customer.name','y'); assert.strictEqual(a.customer.name,'x'); assert.strictEqual(b.customer.name,'y'); });
t('toggle always boolean (pricing featured)', () => { const p = L.MARKETING_LISTS.pricing_plans.defaults[0]; assert.strictEqual(L.sanitizeList('pricing_plans',[{...p, featured:'yes'}])[0].featured, false); assert.strictEqual(L.sanitizeList('pricing_plans',[{...p, featured:true}])[0].featured, true); const { featured, ...rest } = p; assert.strictEqual(L.sanitizeList('pricing_plans',[rest])[0].featured, false); });
t('pricing cta href validated', () => { const p = L.MARKETING_LISTS.pricing_plans.defaults[0]; assert.strictEqual(L.sanitizeList('pricing_plans',[{...p, cta:{label:'Go', href:'javascript:x'}}]).length, 0); });
t('pillar visual must be a known kind', () => { const p = L.MARKETING_LISTS.feature_pillars.defaults[0]; assert.strictEqual(L.sanitizeList('feature_pillars',[{...p, visual:'hologram'}]).length, 0); assert.strictEqual(L.sanitizeList('feature_pillars',[{...p, visual:'handoff'}])[0].visual, 'handoff'); });
t('fixed use case samples need all 5', () => { const s = L.MARKETING_LISTS.use_case_samples.defaults; assert.strictEqual(s.length, 5); assert.strictEqual(L.sanitizeList('use_case_samples', s.slice(0,4)).length, 0); });
t('security areas icon required', () => { const a = L.MARKETING_LISTS.security_areas.defaults[0]; assert.strictEqual(L.sanitizeList('security_areas',[{...a, icon:'nope'}]).length, 0); });
