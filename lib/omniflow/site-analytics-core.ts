/**
 * §260 website analytics: the pure rules (no I/O). The track route, the
 * server helpers, the admin page and the Node harness share this one file.
 *
 * Privacy: nothing here identifies a person. An event carries a page path, a
 * referrer host, UTM tags, a device and browser family, a language, a country
 * and a daily visitor hash (made on the server in site-analytics.ts).
 */

export const ANALYTICS_EVENTS = ["page_view", "page_time", "cta_click", "form_submit"] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export const MAX_SECONDS = 1800;

const PATH_RE = /^\/[A-Za-z0-9/_.~%-]{0,159}$/;
const TOKEN_RE = /^[a-z0-9_.-]{1,64}$/;
const META_RE = /^[A-Za-z0-9/_.:%-]{1,120}$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const BOT_RE =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|uptime|curl|wget|python-requests|facebookexternalhit|whatsapp/i;

export interface SiteEventInput {
  event: AnalyticsEvent;
  path: string;
  refHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  meta: string;
  seconds: number;
}

export function cleanEvent(value: unknown): AnalyticsEvent | null {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value)
    ? (value as AnalyticsEvent)
    : null;
}

/** A path only: no query string, no trailing slash. Anything odd becomes "/other". */
export function cleanPath(value: unknown): string {
  if (typeof value !== "string") return "/other";
  const trimmed = value.trim();
  const path = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  return PATH_RE.test(path) ? path : "/other";
}

export function cleanToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const token = value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
  return TOKEN_RE.test(token) ? token : "";
}

export function cleanMeta(value: unknown): string {
  if (typeof value !== "string") return "";
  const meta = value.trim().slice(0, 120);
  return META_RE.test(meta) ? meta : "";
}

/** Referrer host only. Our own site (and its subdomains) is not a referrer. */
export function cleanHost(value: unknown, ownHost: string): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let host = value.trim().toLowerCase();
  if (host.includes("/")) {
    try {
      const url = new URL(host.startsWith("http") ? host : `https://${host}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      host = url.host;
    } catch {
      return "";
    }
  }
  host = host.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!HOST_RE.test(host) || host.length > 120) return "";
  const own = ownHost.trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  if (own && (host === own || host.endsWith(`.${own}`))) return "";
  return host;
}

export function clampSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_SECONDS, Math.max(0, Math.round(n)));
}

/** Turns the request body into the stored shape, or null when it is not an event we keep. */
export function normalizeEvent(body: Record<string, unknown>, ownHost: string): SiteEventInput | null {
  const event = cleanEvent(body.event);
  if (!event) return null;
  const seconds = event === "page_time" ? clampSeconds(body.seconds) : 0;
  if (event === "page_time" && seconds <= 0) return null;
  const isView = event === "page_view";
  const hasMeta = event === "cta_click" || event === "form_submit";
  return {
    event,
    path: cleanPath(body.path),
    refHost: isView ? cleanHost(body.referrer_host, ownHost) : "",
    utmSource: isView ? cleanToken(body.utm_source) : "",
    utmMedium: isView ? cleanToken(body.utm_medium) : "",
    utmCampaign: isView ? cleanToken(body.utm_campaign) : "",
    meta: hasMeta ? cleanMeta(body.meta) : "",
    seconds,
  };
}

/** Automated traffic (search bots, link previews, monitors, scripts) is not a visitor. */
export function isBot(userAgent: string): boolean {
  return !userAgent || BOT_RE.test(userAgent);
}

export function deviceOf(userAgent: string): string {
  if (/ipad|tablet|playbook|silk|kindle/i.test(userAgent)) return "tablet";
  if (/mobi|iphone|android/i.test(userAgent)) return "mobile";
  return "desktop";
}

export function browserOf(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return "edge";
  if (/opr\/|opera/i.test(userAgent)) return "opera";
  if (/firefox\/|fxios\//i.test(userAgent)) return "firefox";
  if (/chrome\/|crios\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
}

/** Primary language subtag of Accept-Language, e.g. "en-US,en;q=0.9" -> "en". */
export function langOf(acceptLanguage: string): string {
  const first = (acceptLanguage || "").split(",")[0]?.trim().split("-")[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(first) ? first : "";
}

/** Two-letter country code from the hosting header (country level only). */
export function countryOf(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

export function targetLabel(meta: string): string {
  if (meta.startsWith("outbound:")) return `External: ${meta.slice("outbound:".length)}`;
  return meta || "(unnamed)";
}

// ---- admin numbers -------------------------------------------------------

export interface SiteStats {
  days: number;
  timezone: string;
  totals: {
    views: number;
    visitors: number;
    ctaClicks: number;
    ctaVisitors: number;
    formSubmits: number;
    formVisitors: number;
    avgSeconds: number;
  };
  daily: { day: string; views: number; visitors: number }[];
  pages: { path: string; views: number; visitors: number }[];
  sources: { source: string; views: number; visitors: number }[];
  campaigns: { utmSource: string; utmCampaign: string; views: number; visitors: number }[];
  countries: { country: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
  browsers: { browser: string; visitors: number }[];
  languages: { lang: string; visitors: number }[];
  clicks: { target: string; clicks: number }[];
  forms: { target: string; submits: number }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Reads the site_stats() JSON. Missing parts become empty lists; garbage becomes null. */
export function parseSiteStats(raw: unknown): SiteStats | null {
  if (!isRecord(raw)) return null;
  const totals = isRecord(raw.totals) ? raw.totals : {};
  return {
    days: num(raw.days),
    timezone: text(raw.timezone) || "Asia/Karachi",
    totals: {
      views: num(totals.views),
      visitors: num(totals.visitors),
      ctaClicks: num(totals.cta_clicks),
      ctaVisitors: num(totals.cta_visitors),
      formSubmits: num(totals.form_submits),
      formVisitors: num(totals.form_visitors),
      avgSeconds: num(totals.avg_seconds),
    },
    daily: rows(raw.daily).map((r) => ({ day: text(r.day), views: num(r.views), visitors: num(r.visitors) })),
    pages: rows(raw.pages).map((r) => ({ path: text(r.path) || "/other", views: num(r.views), visitors: num(r.visitors) })),
    sources: rows(raw.sources).map((r) => ({ source: text(r.source) || "direct", views: num(r.views), visitors: num(r.visitors) })),
    campaigns: rows(raw.campaigns).map((r) => ({
      utmSource: text(r.utm_source),
      utmCampaign: text(r.utm_campaign),
      views: num(r.views),
      visitors: num(r.visitors),
    })),
    countries: rows(raw.countries).map((r) => ({ country: text(r.country), visitors: num(r.visitors) })),
    devices: rows(raw.devices).map((r) => ({ device: text(r.device), visitors: num(r.visitors) })),
    browsers: rows(raw.browsers).map((r) => ({ browser: text(r.browser), visitors: num(r.visitors) })),
    languages: rows(raw.languages).map((r) => ({ lang: text(r.lang), visitors: num(r.visitors) })),
    clicks: rows(raw.clicks).map((r) => ({ target: text(r.target), clicks: num(r.clicks) })),
    forms: rows(raw.forms).map((r) => ({ target: text(r.target), submits: num(r.submits) })),
  };
}

/** Share of a whole, one decimal. No data (whole = 0) gives null, never a fake zero. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Bar height in percent. A day with any traffic stays visible (minimum 3). */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(3, Math.round((value / max) * 100));
}

export function formatSeconds(seconds: number): string {
  if (!(seconds > 0)) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}
