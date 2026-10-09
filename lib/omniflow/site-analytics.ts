/**
 * §260 website analytics, server side: records visits, runs the daily
 * retention job and reads the admin numbers. Uses the service-role client, so
 * it is server only. Every function fails soft: analytics never breaks a page.
 *
 * The IP address is used once, inside the visitor hash, and is never stored.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "../supabase/service";
import {
  browserOf,
  countryOf,
  deviceOf,
  isBot,
  langOf,
  normalizeEvent,
  parseSiteStats,
  type SiteStats,
} from "./site-analytics-core";

const WINDOW_MS = 60_000;
const MAX_HITS_PER_WINDOW = 120;
const hits = new Map<string, { count: number; resetAt: number }>();

/** Rate limit per visitor hash, kept in memory only. */
function withinLimit(key: string, now: number): boolean {
  if (hits.size > 5000) hits.clear();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_HITS_PER_WINDOW;
}

/** One-way visitor code. The day is in the input, so the code changes every day. */
export function visitorHash(salt: string, day: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}|${day}|${ip}|${userAgent}`).digest("hex").slice(0, 32);
}

export interface TrackContext {
  ip: string;
  userAgent: string;
  acceptLanguage: string;
  country: string;
  host: string;
}

export async function recordSiteEvent(body: Record<string, unknown>, ctx: TrackContext): Promise<void> {
  if (isBot(ctx.userAgent)) return;
  const salt = process.env.OF_ANALYTICS_SALT ?? "";
  if (!salt) return; // not configured yet: nothing is recorded
  const event = normalizeEvent(body, ctx.host);
  if (!event) return;
  const day = new Date().toISOString().slice(0, 10);
  const visitor = visitorHash(salt, day, ctx.ip, ctx.userAgent);
  if (!withinLimit(visitor, Date.now())) return;
  const { error } = await createServiceClient()
    .from("site_events")
    .insert({
      event: event.event,
      path: event.path,
      ref_host: event.refHost,
      utm_source: event.utmSource,
      utm_medium: event.utmMedium,
      utm_campaign: event.utmCampaign,
      device: deviceOf(ctx.userAgent),
      browser: browserOf(ctx.userAgent),
      country: countryOf(ctx.country),
      lang: langOf(ctx.acceptLanguage),
      meta: event.meta,
      seconds: event.seconds,
      visitor,
    });
  if (error) console.error("site_events insert failed:", error.code ?? "unknown");
}

export type MaintenanceResult = { ok: true; summary: unknown } | { ok: false; error: string };

/** Daily retention job (site_maintain): deletes visit records older than the window, then logs the run. */
export async function runSiteMaintenance(): Promise<MaintenanceResult> {
  try {
    const { data, error } = await createServiceClient().rpc("site_maintain");
    if (error) return { ok: false, error: error.message };
    return { ok: true, summary: data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "maintenance failed" };
  }
}

export async function loadSiteStats(days: number): Promise<SiteStats | null> {
  try {
    const { data, error } = await createServiceClient().rpc("site_stats", { days });
    return error ? null : parseSiteStats(data);
  } catch {
    return null;
  }
}

export interface SiteSettings {
  retentionDays: number;
  timezone: string;
}

export async function loadSiteSettings(): Promise<SiteSettings | null> {
  try {
    const { data, error } = await createServiceClient()
      .from("site_settings")
      .select("retention_days, tz_name")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      retentionDays: Number(data.retention_days) || 90,
      timezone: String(data.tz_name || "Asia/Karachi"),
    };
  } catch {
    return null;
  }
}

export interface MaintenanceRun {
  ranAt: string;
  retentionDays: number;
  rawDeleted: number;
}

export async function loadMaintenanceLog(limit = 5): Promise<MaintenanceRun[] | null> {
  try {
    const { data, error } = await createServiceClient()
      .from("site_maintenance_log")
      .select("ran_at, retention_days, raw_deleted")
      .order("ran_at", { ascending: false })
      .limit(limit);
    if (error) return null;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      ranAt: String(row.ran_at),
      retentionDays: Number(row.retention_days),
      rawDeleted: Number(row.raw_deleted),
    }));
  } catch {
    return null;
  }
}

/** Constant-time check of a bearer secret (Vercel Cron sends `Bearer <CRON_SECRET>`). */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
