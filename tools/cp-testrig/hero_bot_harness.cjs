// Functional tests for the hero OmniFlowBot (batch 247, 3D model + Soon arc in 248, intro/interactive in 249,
// pre-rendered 3D layers + closing line in 250, arm joint chains in 251, open palms in 252, only the waving palm in 254), run by
// test_hero_bot.py. Loads the real TS/TSX through the repo's own
// `typescript` (transpileModule) and renders with react-dom/server;
// CSS modules resolve to their class names. No extra deps.
// Usage: NODE_PATH=<node_modules> node hero_bot_harness.cjs <site root> <typescript module path>
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const [root, tsPath] = process.argv.slice(2);
const ts = require(tsPath);
const compile = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};
require.extensions[".ts"] = compile;
require.extensions[".tsx"] = compile;
require.extensions[".css"] = (module) => {
  module.exports = new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : String(key)) });
};

const { renderToStaticMarkup } = require("react-dom/server");
const { createElement } = require("react");
const dir = path.join(root, "app/components/OmniFlowBot");
const Bot = require(path.join(dir, "OmniFlowBot.tsx")).default;
const { pickBotChannels } = require(path.join(dir, "botChannels.ts"));
const { INTEGRATIONS } = require(path.join(root, "lib/marketing/integrations.ts"));
const { HERO_SECTION } = require(path.join(root, "lib/marketing/sections.ts"));

const t = (name, fn) => {
  try { fn(); console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + " :: " + e.message); }
};
const item = (id, status, category = "channels") => ({ id, name: id, accent: "#" + id.length + "00", category, status });
const render = (props = {}) => renderToStaticMarkup(createElement(Bot, {
  label: "OmniFlow AI",
  copy: HERO_SECTION.bot,
  ...pickBotChannels(INTEGRATIONS),
  ...props,
}));
const count = (html, needle) => html.split(needle).length - 1;

// ---- channel picking (honest statuses) ----
const PRIMARY = ["whatsapp", "instagram", "facebook", "messenger"];
const SECONDARY = ["tiktok", "x", "telegram", "linkedin"];
const real = () => pickBotChannels(INTEGRATIONS);
t("real list: primary logos in order", () => {
  const ids = real().primary.map((c) => c.id);
  assert.deepStrictEqual(ids, PRIMARY.filter((id) => ids.includes(id)));
  assert.ok(ids.includes("whatsapp"));
});
t("real list: secondary arc in order with honest soon flags", () => {
  const { secondary } = real();
  assert.deepStrictEqual(secondary.map((c) => c.id), SECONDARY.filter((id) => INTEGRATIONS.some((i) => i.id === id && i.category === "channels")));
  for (const c of secondary) assert.strictEqual(c.soon, INTEGRATIONS.find((i) => i.id === c.id).status === "soon", c.id);
});
t("real list: +N counts the other offered channels", () => {
  const offered = INTEGRATIONS.filter((i) => i.category === "channels" && i.status !== "soon");
  const shown = ["whatsapp", "instagram", "messenger", ...SECONDARY];
  const other = offered.filter((i) => !shown.includes(i.id)).length;
  assert.strictEqual(real().more, other);
  assert.ok(other > 0);
});
t("accent comes from the integration (facebook = messenger)", () => {
  const { primary, secondary } = real();
  const messenger = INTEGRATIONS.find((i) => i.id === "messenger");
  if (messenger.status !== "soon") assert.strictEqual(primary.find((c) => c.id === "facebook").accent, messenger.accent);
  assert.strictEqual(primary.find((c) => c.id === "whatsapp").accent, INTEGRATIONS.find((i) => i.id === "whatsapp").accent);
  for (const c of secondary) assert.strictEqual(c.accent, INTEGRATIONS.find((i) => i.id === c.id).accent);
});
t("soon channels never on the primary arc", () => {
  const out = pickBotChannels([item("whatsapp", "live"), item("instagram", "soon"), item("messenger", "soon"), item("tiktok", "soon")]);
  assert.deepStrictEqual(out.primary.map((c) => c.id), ["whatsapp"]);
  assert.deepStrictEqual(out.secondary.map((c) => [c.id, c.soon]), [["tiktok", true]]);
  assert.strictEqual(out.more, 0);
});
t("secondary goes live: badge drops, not counted in +N", () => {
  const out = pickBotChannels([item("whatsapp", "live"), item("telegram", "live"), item("linkedin", "beta"), item("sms", "live")]);
  assert.deepStrictEqual(out.secondary.map((c) => [c.id, c.soon]), [["telegram", false], ["linkedin", false]]);
  assert.strictEqual(out.more, 1);
});
t("non-channel integrations ignored", () => {
  const out = pickBotChannels([item("whatsapp", "live", "commerce"), item("tiktok", "soon", "commerce"), item("shopify", "live", "commerce"), item("sms", "beta")]);
  assert.deepStrictEqual(out.primary, []);
  assert.deepStrictEqual(out.secondary, []);
  assert.strictEqual(out.more, 1);
});
t("logo paths are real svg path data with their viewBox", () => {
  const all = pickBotChannels([...PRIMARY, ...SECONDARY].map((id) => item(id === "facebook" ? "messenger" : id, "live")));
  const logos = [...all.primary, ...all.secondary];
  assert.strictEqual(logos.length, 8);
  for (const c of logos) {
    assert.match(c.path, /^M[\d.\s,-]/);
    assert.ok(c.path.length > 150, c.id);
    assert.strictEqual(c.viewBox, c.id === "linkedin" ? "0 0 16 16" : "0 0 24 24", c.id);
  }
});

// ---- render ----
const bot = HERO_SECTION.bot;
const labelOf = (html) => html.match(/aria-label="([^"]+)"/)[1].replace(/&#x27;/g, "'");
t("render: one accessible image, sentences, no doubled dots", () => {
  const html = render();
  assert.strictEqual(count(html, 'role="img"'), 1);
  assert.strictEqual(labelOf(html), ["OmniFlow AI.", bot.greeting, bot.intro, bot.channels, bot.soon, bot.connected].join(" "));
  // sentence() never adds a dot after punctuation (an ellipsis in the copy stays as written)
  assert.ok(!/(^|[^.])\.\.($|[^.])/.test(labelOf(html)), labelOf(html));
  assert.ok(!labelOf(html).includes("...."));
});
t("render: no left arc = no soon line, closing line stays", () => {
  const html = render({ secondary: [] });
  assert.strictEqual(labelOf(html), ["OmniFlow AI.", bot.greeting, bot.intro, bot.channels, bot.connected].join(" "));
  assert.ok(!html.includes("line4"));
  assert.strictEqual(count(html, 'class="line line5">' + bot.connected + "</p>"), 1);
});
t("render: five spoken lines + display text", () => {
  const html = render();
  for (const line of [bot.greeting, bot.intro, bot.channels, bot.soon, bot.connected]) assert.ok(html.includes(line.replace(/'/g, "&#x27;")), line);
  assert.strictEqual(count(html, ">" + bot.display + "</text>"), 2);
});
t("render: a node per channel + the +N node", () => {
  const { primary, secondary, more } = real();
  const html = render();
  const nodes = primary.length + secondary.length + (more ? 1 : 0);
  assert.strictEqual(count(html, 'class="node"'), nodes);
  assert.ok(html.includes(">+" + more + "</span>"));
  assert.strictEqual(count(html, "<line "), nodes);
});
t("render: soon badge + dim link only for soon channels", () => {
  const { secondary } = real();
  const soon = secondary.filter((c) => c.soon).length;
  const html = render();
  assert.ok(soon > 0);
  assert.strictEqual(count(html, 'class="badge">' + bot.soonLabel + "</span>"), soon);
  assert.strictEqual(count(html, 'class="soonLink"'), soon);
  assert.strictEqual(count(html, "soonBubble"), soon);
  const live = render({ secondary: secondary.map((c) => ({ ...c, soon: false })) });
  assert.strictEqual(count(live, 'class="badge"'), 0);
});
t("render: linkedin keeps its own viewBox", () => {
  assert.strictEqual(count(render(), 'viewBox="0 0 16 16"'), real().secondary.some((c) => c.id === "linkedin") ? 1 : 0);
});
t("render: socialBubbles=false drops nodes and links", () => {
  const html = render({ socialBubbles: false });
  assert.strictEqual(count(html, 'class="node"'), 0);
  assert.strictEqual(count(html, "<line "), 0);
  assert.ok(!html.includes("line4"));
});
t("render: more=0 has no +N", () => {
  assert.ok(!/>\+\d+</.test(render({ more: 0 })));
});
t("render: at most four spots per arc", () => {
  const four = real().primary;
  const many = [...four, ...four.map((c) => ({ ...c, id: c.id + "2" }))];
  const html = render({ primary: many, secondary: many, more: 0 });
  assert.strictEqual(count(html, 'class="node"'), 8);
});
t("render: intro=false starts in the resting pose", () => {
  assert.ok(render({ intro: false }).includes('data-nointro=""'));
  assert.ok(!render().includes("data-nointro"));
  assert.strictEqual(count(render({ intro: false }), 'class="node"'), count(render(), 'class="node"'));
});
t("render: interactive is not leaked to the DOM", () => {
  const html = render({ interactive: false });
  assert.ok(!html.includes("interactive") && !html.includes("tap="));
});
t("render: animated=false marks the still pose", () => {
  assert.ok(render({ animated: false }).includes('data-static=""'));
  assert.ok(!render().includes("data-static"));
});
t("render: chest display text comes from the copy", () => {
  assert.strictEqual(count(render({ copy: { ...bot, display: "Acme" } }), ">Acme</text>"), 2);
});
t("render: long display text is fitted", () => {
  const html = render({ copy: { ...bot, display: "OmniFlow Assistant" } });
  assert.strictEqual(count(html, 'textLength="15.4"'), 2);
  assert.strictEqual(count(render({ copy: { ...bot, display: "Acme" } }), 'textLength="8.4"'), 2);
});
t("render: colours only from tokens or the integration accent", () => {
  const html = render({ primary: [], secondary: [], more: 0 });
  assert.deepStrictEqual(html.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});
t("render: gradients defined once", () => {
  const html = render();
  for (const id of ["ofbot-halo", "ofbot-disc", "ofbot-rim", "ofbot-floor-shadow", "ofbot-scanlines"]) {
    assert.strictEqual(count(html, 'id="' + id + '"'), 1, id);
  }
});
t("render: 3d model = render layers on depth planes, face in front", () => {
  const html = render();
  const z = [...html.matchAll(/class="depth" style="--z:([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(z, [0, 0.8, 0.8, 1.4, 1.6]);
  assert.ok(html.indexOf('class="eyeRing"') > html.indexOf("omniflow-bot-head.webp"));
});
t("render: eight pre-rendered layers, each with its own light mask", () => {
  const html = render();
  const srcs = [...html.matchAll(/<img src="([^"]+)" alt="" width="560" height="846"/g)].map((m) => m[1]);
  const arm = (side) => ["upper", "fore", "hand"].map((seg) => "/bot/omniflow-bot-" + seg + "-" + side + ".webp");
  assert.deepStrictEqual(srcs, ["/bot/omniflow-bot-body.webp", ...arm("l"), ...arm("r"), "/bot/omniflow-bot-head.webp"]);
  for (const src of srcs) {
    assert.ok(fs.statSync(path.join(root, "public", src)).size > 4000, src);
    assert.ok(html.includes("mask-image:url(" + src + ")"), src);
  }
  assert.strictEqual(count(html, 'class="light"'), 9);
});
t("render: open palm only on the waving hand, in its own box; the other hand stays relaxed", () => {
  const html = render();
  const hand = new RegExp('<div class="part handR"><div class="part gripR"><img src="/bot/omniflow-bot-hand-r.webp"[^>]+>'
    + '<span class="light"[^>]*><span class="lightSpot"></span></span></div><div class="palm palmR" style="left:81.25%;top:61.58%;width:25.36%;height:19.03%">'
    + '<img src="/bot/omniflow-bot-palm-r.webp" alt="" width="142" height="161"');
  assert.ok(hand.test(html));
  assert.ok(html.includes("mask-image:url(/bot/omniflow-bot-palm-r.webp)"));
  assert.ok(fs.statSync(path.join(root, "public/bot/omniflow-bot-palm-r.webp")).size > 4000);
  assert.ok(/<div class="part handL"><img src="\/bot\/omniflow-bot-hand-l.webp"/.test(html));
  assert.strictEqual(count(html, 'class="palm '), 1);
  assert.ok(!html.includes("palm-l") && !html.includes("gripL"));
});
t("render: arms are shoulder > elbow > wrist chains", () => {
  const html = render();
  for (const [side, grip] of [["L", ""], ["R", '<div class="part gripR">']]) {
    const chain = new RegExp('class="part arm' + side + '"><img [^>]+><span class="light"[^>]*><span class="lightSpot"></span></span>'
      + '<div class="part fore' + side + '"><img [^>]+><span class="light"[^>]*><span class="lightSpot"></span></span>'
      + '<div class="part hand' + side + '">' + grip + '<img ');
    assert.ok(chain.test(html), side);
  }
  assert.ok(html.indexOf('class="tap"') < html.indexOf('class="part armR"'));
});
t("render: standing on the light platform", () => {
  const html = render();
  assert.strictEqual(count(html, 'class="disc"'), 1);
  assert.strictEqual(count(html, 'class="discRing"'), 2);
  assert.ok(html.indexOf('class="disc"') < html.indexOf("<img "));
});
