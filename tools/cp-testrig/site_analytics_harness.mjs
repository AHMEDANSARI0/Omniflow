// §260 website analytics rules, run on fixed inputs (no database, no network).
// Run from any folder: `node site_analytics_harness.mjs` (no flag needed on Node 22.6+).
// Node 22.6 to 22.17 cannot load .ts files without --experimental-strip-types, so the
// harness starts itself once more with that flag. It finds the website root by walking
// up from this folder to lib/omniflow/site-analytics-core.ts (or set OF_RIG_WEB_ROOT).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE = path.join("lib", "omniflow", "site-analytics-core.ts");

function findWebRoot() {
  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, CORE))) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

const OWN = "omniflow.pk";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Runs this same file again with the strip-types flag. The child prints the checks and
// sets the exit code. OF_RIG_RELAUNCHED stops a loop if a Node build ignores the flag.
function relaunchWithStripTypes() {
  if (process.env.OF_RIG_RELAUNCHED === "1") return false;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) {
    console.log("FAIL Node 22.6 or newer is needed (this is " + process.version + ")");
    process.exitCode = 1;
    return true;
  }
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, OF_RIG_RELAUNCHED: "1" } },
  );
  if (child.error) return false;
  process.exitCode = child.status === null ? 1 : child.status;
  return true;
}

async function main() {
  // Node prints a typeless-package notice when it loads the .ts core. The harness prints
  // only its own PASS/FAIL lines, so that notice is switched off here.
  process.removeAllListeners("warning");
  const root = findWebRoot();
  if (!root) {
    console.log("FAIL site-analytics-core.ts not found: put this folder inside the website repo, or set OF_RIG_WEB_ROOT");
    process.exitCode = 1;
    return;
  }
  let core;
  try {
    core = await import(pathToFileURL(path.join(root, CORE)).href);
  } catch (err) {
    if (err && err.code === "ERR_UNKNOWN_FILE_EXTENSION" && relaunchWithStripTypes()) return;
    console.log("FAIL load site-analytics-core.ts :: " + (err && err.code ? err.code : String(err && err.message).split("\n")[0]));
    console.log("      Run with: node --experimental-strip-types --no-warnings site_analytics_harness.mjs");
    process.exitCode = 1;
    return;
  }
  const {
    ANALYTICS_EVENTS, cleanEvent, cleanPath, cleanToken, cleanMeta, cleanHost, clampSeconds,
    normalizeEvent, isBot, deviceOf, browserOf, langOf, countryOf, targetLabel, percentOf,
    barPercent, formatSeconds, parseSiteStats,
  } = core;

  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try {
      fn();
      pass += 1;
      console.log("PASS " + name);
    } catch (err) {
      fail += 1;
      console.log("FAIL " + name + " :: " + String(err && err.message).split("\n")[0]);
    }
  }

  check("events: exactly the four kept events", () => {
    assert.deepEqual([...ANALYTICS_EVENTS], ["page_view", "page_time", "cta_click", "form_submit"]);
    for (const ok of ANALYTICS_EVENTS) assert.equal(cleanEvent(ok), ok);
    for (const bad of ["click", "", null, 3, "__proto__", "constructor", "PAGE_VIEW"]) {
      assert.equal(cleanEvent(bad), null, String(bad));
    }
  });

  check("path: query, odd characters and long values become /other", () => {
    assert.equal(cleanPath("/pricing"), "/pricing");
    assert.equal(cleanPath("/pricing/"), "/pricing");
    assert.equal(cleanPath("/"), "/");
    assert.equal(cleanPath("/urdu/ai-chatbot"), "/urdu/ai-chatbot");
    for (const bad of ["//", "/a?x=1", "https://evil.example/x", "/" + "a".repeat(200), 42, "", "/<b>"]) {
      assert.equal(cleanPath(bad), "/other", String(bad));
    }
  });

  check("tokens: UTM values are lower-case, spaces become dashes, junk is dropped", () => {
    assert.equal(cleanToken("Summer Sale 2026"), "summer-sale-2026");
    assert.equal(cleanToken("a".repeat(80)), "a".repeat(64));
    assert.equal(cleanToken("<script>"), "");
    assert.equal(cleanToken("bad/value"), "");
    assert.equal(cleanToken(""), "");
    assert.equal(cleanToken(undefined), "");
  });

  check("meta: button ids, paths and outbound hosts pass; markup and empty values do not", () => {
    assert.equal(cleanMeta("/signup"), "/signup");
    assert.equal(cleanMeta("outbound:wa.me"), "outbound:wa.me");
    assert.equal(cleanMeta("hero_start"), "hero_start");
    assert.equal(cleanMeta("<b>"), "");
    assert.equal(cleanMeta(""), "");
    assert.equal(cleanMeta("x".repeat(130)).length, 120);
  });

  check("referrer host: www and port stripped, own site and subdomains dropped, other URL schemes dropped", () => {
    assert.equal(cleanHost("https://www.google.com/search?q=x", OWN), "google.com");
    assert.equal(cleanHost("WWW.Facebook.COM", OWN), "facebook.com");
    assert.equal(cleanHost("google.com:443", OWN), "google.com");
    assert.equal(cleanHost("l.instagram.com", OWN), "l.instagram.com");
    assert.equal(cleanHost("omniflow.pk", OWN), "");
    assert.equal(cleanHost("blog.omniflow.pk", OWN), "");
    assert.equal(cleanHost("notomniflow.pk", OWN), "notomniflow.pk", "a look-alike domain is not our site");
    assert.equal(cleanHost("javascript:alert(1)", OWN), "");
    assert.equal(cleanHost("ftp://files.example.com/x", OWN), "");
    assert.equal(cleanHost("a".repeat(130) + ".com", OWN), "");
    assert.equal(cleanHost(42, OWN), "");
    assert.equal(cleanHost("", OWN), "");
  });

  check("seconds: rounded, clamped to 0..1800, non-numbers become 0", () => {
    assert.equal(clampSeconds(10.4), 10);
    assert.equal(clampSeconds(-5), 0);
    assert.equal(clampSeconds(99999), 1800);
    assert.equal(clampSeconds("42"), 42);
    assert.equal(clampSeconds("abc"), 0);
    assert.equal(clampSeconds(NaN), 0);
    assert.equal(clampSeconds(Infinity), 0);
  });

  check("page_view: keeps path, referrer host and UTM tags; ignores seconds and meta", () => {
    const got = normalizeEvent(
      {
        event: "page_view",
        path: "/pricing/",
        referrer_host: "https://www.google.com/",
        utm_source: "Google",
        utm_medium: "CPC",
        utm_campaign: "Spring 26",
        meta: "x",
        seconds: 99,
      },
      OWN,
    );
    assert.deepEqual(got, {
      event: "page_view",
      path: "/pricing",
      refHost: "google.com",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring-26",
      meta: "",
      seconds: 0,
    });
  });

  check("cta_click and form_submit keep only the meta; page_time keeps only seconds", () => {
    assert.deepEqual(normalizeEvent({ event: "cta_click", path: "/", meta: "/signup", seconds: 5 }, OWN), {
      event: "cta_click", path: "/", refHost: "", utmSource: "", utmMedium: "", utmCampaign: "", meta: "/signup", seconds: 0,
    });
    assert.equal(normalizeEvent({ event: "form_submit", path: "/contact", meta: "contact-form" }, OWN).meta, "contact-form");
    assert.deepEqual(normalizeEvent({ event: "page_time", path: "/pricing", seconds: 45, meta: "x" }, OWN), {
      event: "page_time", path: "/pricing", refHost: "", utmSource: "", utmMedium: "", utmCampaign: "", meta: "", seconds: 45,
    });
    assert.equal(normalizeEvent({ event: "page_time", path: "/", seconds: 99999 }, OWN).seconds, 1800);
  });

  check("rejected: unknown events, page_time without a measured time, non-object events", () => {
    assert.equal(normalizeEvent({ event: "purchase", path: "/" }, OWN), null);
    assert.equal(normalizeEvent({ path: "/" }, OWN), null);
    assert.equal(normalizeEvent({ event: "page_time", path: "/", seconds: 0 }, OWN), null);
    assert.equal(normalizeEvent({ event: "page_time", path: "/", seconds: "abc" }, OWN), null);
  });

  check("UTM with markup is dropped; our own referrer is dropped", () => {
    const got = normalizeEvent(
      { event: "page_view", path: "/", utm_source: "<img onerror=x>", referrer_host: "omniflow.pk" },
      OWN,
    );
    assert.equal(got.utmSource, "");
    assert.equal(got.refHost, "");
  });

  check("privacy: a normalized event carries no IP, visitor, user agent or raw URL field", () => {
    const keys = Object.keys(normalizeEvent({ event: "page_view", path: "/", referrer_host: "google.com", ip: "1.2.3.4", user_agent: "x", url: "https://omniflow.pk/?token=abc" }, OWN)).sort();
    assert.deepEqual(keys, ["event", "meta", "path", "refHost", "seconds", "utmCampaign", "utmMedium", "utmSource"]);
  });

  check("bots: empty, crawlers, scripts, headless browsers and link previews are not visitors", () => {
    assert.equal(isBot(""), true);
    assert.equal(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
    assert.equal(isBot("curl/8.5.0"), true);
    assert.equal(isBot("HeadlessChrome/120.0.0.0"), true);
    assert.equal(isBot("WhatsApp/2.23.20.0"), true);
    assert.equal(isBot(CHROME_WIN), false);
    assert.equal(isBot(IPHONE_SAFARI), false);
  });

  check("device: phone, tablet, desktop", () => {
    assert.equal(deviceOf(IPHONE_SAFARI), "mobile");
    assert.equal(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15"), "tablet");
    assert.equal(deviceOf(CHROME_WIN), "desktop");
    assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36"), "mobile");
  });

  check("browser family: Edge, Opera, Firefox (incl. iOS), Chrome (incl. iOS), Safari, other", () => {
    assert.equal(browserOf(CHROME_WIN + " Edg/126.0.0.0"), "edge");
    assert.equal(browserOf("Mozilla/5.0 Chrome/126.0 Safari/537.36 OPR/111.0"), "opera");
    assert.equal(browserOf("Mozilla/5.0 (Windows NT 10.0; rv:127.0) Gecko/20100101 Firefox/127.0"), "firefox");
    assert.equal(browserOf(IPHONE_SAFARI.replace("Version/17.5", "FxiOS/127.0")), "firefox");
    assert.equal(browserOf(CHROME_WIN), "chrome");
    assert.equal(browserOf(IPHONE_SAFARI.replace("Version/17.5", "CriOS/126.0")), "chrome");
    assert.equal(browserOf(IPHONE_SAFARI), "safari");
    assert.equal(browserOf(""), "other");
  });

  check("language and country: primary subtag only; two letters only", () => {
    assert.equal(langOf("en-US,en;q=0.9"), "en");
    assert.equal(langOf("ur-PK,ur;q=0.9"), "ur");
    assert.equal(langOf("EN"), "en");
    assert.equal(langOf("zh-Hant-TW"), "zh");
    assert.equal(langOf("*"), "");
    assert.equal(langOf(""), "");
    assert.equal(countryOf("PK"), "PK");
    assert.equal(countryOf("pk"), "PK");
    assert.equal(countryOf("PAK"), "");
    assert.equal(countryOf("P1"), "");
    assert.equal(countryOf(null), "");
    assert.equal(countryOf(undefined), "");
  });

  check("labels: outbound hosts read as External, empty meta reads as unnamed", () => {
    assert.equal(targetLabel("outbound:wa.me"), "External: wa.me");
    assert.equal(targetLabel("/signup"), "/signup");
    assert.equal(targetLabel("hero_start"), "hero_start");
    assert.equal(targetLabel(""), "(unnamed)");
  });

  check("percent: one decimal; no whole gives null, never a fake zero", () => {
    assert.equal(percentOf(1, 4), 25);
    assert.equal(percentOf(1, 3), 33.3);
    assert.equal(percentOf(0, 10), 0);
    assert.equal(percentOf(0, 0), null);
    assert.equal(percentOf(5, 0), null);
  });

  check("bars: zero stays zero, any traffic is at least 3%, never above 100%", () => {
    assert.equal(barPercent(0, 10), 0);
    assert.equal(barPercent(1, 100), 3);
    assert.equal(barPercent(50, 100), 50);
    assert.equal(barPercent(100, 100), 100);
    assert.equal(barPercent(5, 0), 0);
    assert.equal(barPercent(-1, 10), 0);
  });

  check("durations: dash when unmeasured, seconds, minutes", () => {
    assert.equal(formatSeconds(0), "-");
    assert.equal(formatSeconds(-3), "-");
    assert.equal(formatSeconds(NaN), "-");
    assert.equal(formatSeconds(45), "45s");
    assert.equal(formatSeconds(125), "2m 5s");
  });

  check("parse: garbage gives null; a partial result gives empty lists, not crashes", () => {
    assert.equal(parseSiteStats(null), null);
    assert.equal(parseSiteStats("x"), null);
    assert.equal(parseSiteStats([]), null);
    const empty = parseSiteStats({});
    assert.equal(empty.totals.views, 0);
    assert.deepEqual(empty.daily, []);
    assert.equal(empty.timezone, "Asia/Karachi");
    const odd = parseSiteStats({ daily: "x", pages: [{ views: "12" }], sources: [{}], totals: null });
    assert.deepEqual(odd.daily, []);
    assert.deepEqual(odd.pages, [{ path: "/other", views: 12, visitors: 0 }]);
    assert.deepEqual(odd.sources, [{ source: "direct", views: 0, visitors: 0 }]);
  });

  check("parse: a full site_stats() object maps to camelCase", () => {
    const got = parseSiteStats({
      days: 7,
      timezone: "Asia/Karachi",
      totals: { views: 90, visitors: 40, cta_clicks: 9, cta_visitors: 7, form_submits: 3, form_visitors: 2, avg_seconds: 65 },
      daily: [{ day: "2026-10-08", views: 30, visitors: 15 }],
      pages: [{ path: "/pricing", views: 50, visitors: 25 }],
      sources: [{ source: "google.com", views: 20, visitors: 10 }],
      campaigns: [{ utm_source: "meta", utm_campaign: "launch", views: 12, visitors: 6 }],
      countries: [{ country: "PK", visitors: 30 }],
      devices: [{ device: "mobile", visitors: 25 }],
      browsers: [{ browser: "chrome", visitors: 20 }],
      languages: [{ lang: "ur", visitors: 18 }],
      clicks: [{ target: "/signup", clicks: 9 }],
      forms: [{ target: "contact-form", submits: 3 }],
    });
    assert.equal(Object.hasOwn(got, "lifetimeViews"), false); // no lifetime total is kept or read
    assert.equal(got.totals.ctaVisitors, 7);
    assert.equal(got.totals.avgSeconds, 65);
    assert.equal(got.daily[0].day, "2026-10-08");
    assert.equal(got.campaigns[0].utmCampaign, "launch");
    assert.equal(got.forms[0].target, "contact-form");
    assert.equal(got.languages[0].lang, "ur");
  });

  console.log("SUMMARY[site_analytics_harness]: " + pass + " PASS, " + fail + " FAIL");
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
