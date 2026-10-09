"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  LoyaltyOverview,
  LoyaltyRunResult,
  LoyaltySettings,
  LoyaltySettingsView,
  LoyaltyTier,
} from "../../../../lib/omniflow/portal";

const card = "rounded-2xl border border-line bg-white p-5 shadow-card";
const input = "rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink";
const ghostBtn =
  "rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 transition-colors duration-300 hover:text-ink disabled:opacity-50";
const primaryBtn =
  "rounded-lg bg-brand inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50";
const KIND_LABEL: Record<string, string> = { reorder: "Reorder", winback: "Win-back", cart: "Cart" };
const MODE_LABEL: Record<string, string> = { auto: "Automatic", manual: "Send now", queue: "Win-back queue" };
const HELD_LABEL: Record<string, string> = {
  optedOut: "opted out",
  openCart: "open cart (recovery follows up)",
  inSequence: "in a sequence",
  cooldown: "contacted recently",
  noChat: "no chat yet",
};
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

async function call(
  url: string,
  method: "PUT" | "POST" | "GET",
  body?: unknown
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

function errorOf(data: Record<string, unknown> | null, fallback: string): string {
  const error = data?.error as { message?: string } | undefined;
  return error?.message || fallback;
}

function money(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function hourLabel(hour: number): string {
  return String(hour).padStart(2, "0") + ":00";
}

function when(value: string | null): string {
  if (!value) return "";
  const stamp = Date.parse(value);
  if (Number.isNaN(stamp)) return "";
  const hours = Math.round((Date.now() - stamp) / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

/** §238 Retention: tiers + offers, automatic messages, preview / send, results. */
export default function RetentionClient({
  initialSettings,
  initialOverview,
}: {
  initialSettings: LoyaltySettingsView | null;
  initialOverview: LoyaltyOverview | null;
}) {
  const [view, setView] = useState<LoyaltySettingsView | null>(initialSettings);
  const [overview, setOverview] = useState<LoyaltyOverview | null>(initialOverview);
  const [tiers, setTiers] = useState<LoyaltyTier[]>(initialSettings?.settings.tiers ?? []);
  const [draft, setDraft] = useState<LoyaltySettings | null>(initialSettings?.settings ?? null);
  const [preview, setPreview] = useState<LoyaltyRunResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view || !draft) {
    return <p className="text-sm text-ink-3">Retention could not be loaded. Try again shortly.</p>;
  }
  const canEdit = view.canEdit;

  async function refresh() {
    const result = await call("/api/omniflow/portal/retention/overview", "GET");
    if (result.ok && result.data) setOverview(result.data as unknown as LoyaltyOverview);
  }

  async function save(change: Partial<LoyaltySettings>, done: string) {
    if (!view || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await call("/api/omniflow/portal/retention/settings", "PUT", change);
    if (result.ok && result.data?.settings) {
      const settings = result.data.settings as LoyaltySettings;
      setView({ ...view, settings });
      setDraft(settings);
      setTiers(settings.tiers);
      setNotice(done);
      await refresh();
    } else {
      setNotice(errorOf(result.data, "Saving failed. Try again shortly."));
    }
    setBusy(false);
  }

  async function run(dryRun: boolean) {
    if (busy) return;
    if (!dryRun && !window.confirm("Send these messages now?")) return;
    setBusy(true);
    setNotice(null);
    const result = await call("/api/omniflow/portal/retention/run", "POST", { dryRun });
    if (result.ok && result.data) {
      const data = result.data as unknown as LoyaltyRunResult;
      setPreview(dryRun ? data : null);
      if (!dryRun) {
        setNotice(data.sent === 1 ? "1 message queued." : data.sent + " messages queued.");
        await refresh();
      }
    } else {
      setNotice(errorOf(result.data, "Could not prepare the messages. Try again shortly."));
    }
    setBusy(false);
  }

  function editTier(index: number, change: Partial<LoyaltyTier>) {
    setTiers(tiers.map((tier, position) => (position === index ? { ...tier, ...change } : tier)));
  }

  const held = overview
    ? (Object.keys(HELD_LABEL) as (keyof LoyaltyOverview["skipped"])[])
        .filter((key) => overview.skipped[key] > 0)
        .map((key) => overview.skipped[key] + " " + HELD_LABEL[key])
    : [];
  const tierCounts = new Map((overview?.tiers ?? []).map((tier) => [tier.label, tier]));

  return (
    <div className="space-y-6">
      {notice ? <p className="text-xs text-ink-3">{notice}</p> : null}
      {!canEdit ? (
        <p className="text-xs text-ink-3">Only owners and admins can change retention settings or send messages.</p>
      ) : null}

      {overview ? (
        <section className="grid gap-3 sm:grid-cols-4">
          <div className={card}>
            <p className="text-xs text-ink-3">Customers who bought</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{overview.customers}</p>
          </div>
          <div className={card}>
            <p className="text-xs text-ink-3">Due a message now</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{overview.ready}</p>
            <p className="text-xs text-ink-3">
              {overview.due.reorder} reorder{" \u00b7 "}{overview.due.winback} win-back
            </p>
          </div>
          <div className={card}>
            <p className="text-xs text-ink-3">Sent in the last 24h</p>
            <p className="mt-1 text-2xl font-semibold text-ink">
              {overview.sentLastDay}
              <span className="text-sm font-normal text-ink-3"> / {overview.dailyCap}</span>
            </p>
          </div>
          <div className={card}>
            <p className="text-xs text-ink-3">Came back ({overview.days} days)</p>
            <p className="mt-1 text-2xl font-semibold text-ink">
              {overview.totals.returned}
              <span className="text-sm font-normal text-ink-3"> of {overview.totals.sent}</span>
            </p>
            <p className="text-xs text-ink-3">{money(overview.totals.revenue)} in orders</p>
          </div>
        </section>
      ) : (
        <p className="text-sm text-ink-3">Results could not be loaded right now.</p>
      )}

      <section className={card}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Loyalty tiers</h2>
          <Link href="/dashboard/settings" className="text-xs text-brand hover:underline">
            Manage coupons
          </Link>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          A customer reaches a tier when both minimums are met (purchases = paid, shipped or delivered orders). A tier
          offer is added to reorder and win-back messages only while that coupon is active.
        </p>
        <div className="mt-3 space-y-2">
          {tiers.map((tier, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <input
                className={input + " w-40"}
                value={tier.label}
                maxLength={30}
                disabled={!canEdit || busy}
                onChange={(event) => editTier(index, { label: event.target.value })}
                aria-label="Tier name"
              />
              <label className="flex items-center gap-1 text-xs text-ink-3">
                Orders
                <input
                  type="number"
                  min={1}
                  className={input + " w-20"}
                  value={tier.minOrders}
                  disabled={!canEdit || busy}
                  onChange={(event) => editTier(index, { minOrders: Number(event.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-ink-3">
                Spend
                <input
                  type="number"
                  min={0}
                  className={input + " w-28"}
                  value={tier.minSpend}
                  disabled={!canEdit || busy}
                  onChange={(event) => editTier(index, { minSpend: Number(event.target.value) })}
                />
              </label>
              <select
                className={input}
                value={tier.coupon}
                disabled={!canEdit || busy}
                onChange={(event) => editTier(index, { coupon: event.target.value })}
                aria-label="Tier offer"
              >
                <option value="">No offer</option>
                {tier.coupon && !view.coupons.some((coupon) => coupon.code === tier.coupon) ? (
                  <option value={tier.coupon}>{tier.coupon} (inactive)</option>
                ) : null}
                {view.coupons.map((coupon) => (
                  <option key={coupon.code} value={coupon.code}>
                    {coupon.code + " \u00b7 " + (coupon.kind === "percent" ? coupon.value + "%" : money(coupon.value)) + " off"}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-3">
                {tierCounts.get(tier.label)?.customers ?? 0} customers
              </span>
              {canEdit && tiers.length > 1 ? (
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={busy}
                  onClick={() => setTiers(tiers.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {canEdit ? (
          <div className="mt-3 flex gap-2">
            {tiers.length < 5 ? (
              <button
                type="button"
                className={ghostBtn}
                disabled={busy}
                onClick={() => {
                  const last = tiers[tiers.length - 1];
                  setTiers([...tiers, { key: "", label: "", minOrders: (last?.minOrders ?? 0) + 1, minSpend: last?.minSpend ?? 0, coupon: "" }]);
                }}
              >
                Add tier
              </button>
            ) : null}
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save({ tiers }, "Tiers saved.")}>
              Save tiers
            </button>
          </div>
        ) : null}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-ink">Automatic messages</h2>
        <p className="mt-1 text-xs text-ink-3">
          Checked about every {view.everyMinutes} minutes inside the send window. Customers who opted out, have an open
          cart, are in a sequence, or got any follow-up in the last {draft.cooldownDays} days are skipped.
        </p>
        <div className="mt-3 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.autoReorder}
              disabled={!canEdit || busy}
              onChange={(event) => void save({ autoReorder: event.target.checked }, "Saved.")}
            />
            <span>
              <span className="text-ink">Reorder reminders</span>
              <span className="block text-xs text-ink-3">
                Repeat buyers whose usual time between orders has passed.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.autoWinback}
              disabled={!canEdit || busy}
              onChange={(event) => void save({ autoWinback: event.target.checked }, "Saved.")}
            />
            <span>
              <span className="text-ink">Win-back messages</span>
              <span className="block text-xs text-ink-3">Buyers who have gone quiet.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.brainContext}
              disabled={!canEdit || busy}
              onChange={(event) => void save({ brainContext: event.target.checked }, "Saved.")}
            />
            <span>
              <span className="text-ink">Tell the assistant about returning customers</span>
              <span className="block text-xs text-ink-3">
                Tier, past orders and favourite item, so replies feel personal. The assistant never offers codes or
                discounts.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <label className="flex items-center gap-1">
              Daily limit
              <input
                type="number"
                min={0}
                max={view.capMax}
                className={input + " w-20"}
                value={draft.dailyCap}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft({ ...draft, dailyCap: Number(event.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1">
              Wait between follow-ups (days)
              <input
                type="number"
                min={1}
                max={90}
                className={input + " w-20"}
                value={draft.cooldownDays}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft({ ...draft, cooldownDays: Number(event.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1">
              Send between
              <select
                className={input}
                value={draft.windowStart}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft({ ...draft, windowStart: Number(event.target.value) })}
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {hourLabel(hour)}
                  </option>
                ))}
              </select>
              and
              <select
                className={input}
                value={draft.windowEnd}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft({ ...draft, windowEnd: Number(event.target.value) })}
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {hourLabel(hour)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(
            [
              ["tplReorder", "Reorder message", view.defaults.reorder],
              ["tplWinback", "Win-back message", view.defaults.winback],
              ["tplOffer", "Offer line (needs {code})", view.defaults.offer],
            ] as const
          ).map(([key, label, fallback]) => (
            <label key={key} className="block">
              <span className="text-xs text-ink-3">{label}</span>
              <textarea
                className={input + " mt-1 block w-full"}
                rows={2}
                maxLength={500}
                value={draft[key]}
                placeholder={fallback}
                disabled={!canEdit || busy}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </label>
          ))}
          <p className="text-xs text-ink-3">
            Leave a message empty to use the default shown. Placeholders:{" "}
            {view.placeholders.map((name) => "{" + name + "}").join(" ")}
          </p>
          {canEdit ? (
            <button
              type="button"
              className={primaryBtn}
              disabled={busy}
              onClick={() =>
                void save(
                  {
                    dailyCap: draft.dailyCap,
                    cooldownDays: draft.cooldownDays,
                    windowStart: draft.windowStart,
                    windowEnd: draft.windowEnd,
                    tplReorder: draft.tplReorder,
                    tplWinback: draft.tplWinback,
                    tplOffer: draft.tplOffer,
                  },
                  "Saved."
                )
              }
            >
              Save messages and limits
            </button>
          ) : null}
        </div>
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Who is due now</h2>
            <p className="text-xs text-ink-3">
              {held.length ? "Held back: " + held.join(", ") + "." : "Nobody is held back right now."}{" "}
              <Link href="/dashboard/winback" className="text-brand hover:underline">
                Open the win-back queue
              </Link>
            </p>
          </div>
          {canEdit ? (
            <div className="flex gap-2">
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => void run(true)}>
                Preview
              </button>
              {preview && preview.messages.length > 0 ? (
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run(false)}>
                  Send {preview.messages.length} now
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {preview ? (
          preview.messages.length ? (
            <ul className="mt-3 divide-y divide-line">
              {preview.messages.map((entry) => (
                <li key={entry.contactId} className="py-2 text-sm">
                  <p className="text-ink">
                    {entry.name || entry.contactId}
                    <span className="text-xs text-ink-3">
                      {" \u00b7 "}
                      {KIND_LABEL[entry.kind] || entry.kind}
                      {entry.tier ? " \u00b7 " + entry.tier : ""}
                    </span>
                  </p>
                  <p className="text-xs text-ink-2">{entry.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-ink-3">
              {preview.room === 0 ? "Today's limit is reached." : "Nobody is due a message right now."}
            </p>
          )
        ) : null}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-ink">Recent messages</h2>
        <p className="mt-1 text-xs text-ink-3">
          A purchase within {overview?.attributionDays ?? 14} days of a message counts as came back.
        </p>
        {overview && overview.recent.length ? (
          <ul className="mt-3 divide-y divide-line">
            {overview.recent.map((entry, index) => (
              <li key={index} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-ink">
                  {entry.name || entry.contactId}
                  <span className="text-xs text-ink-3">
                    {" \u00b7 "}
                    {KIND_LABEL[entry.kind] || entry.kind}
                    {" \u00b7 "}
                    {MODE_LABEL[entry.mode] || entry.mode}
                    {entry.coupon ? " \u00b7 " + entry.coupon : ""}
                  </span>
                </span>
                <span className="text-xs text-ink-3">
                  {entry.returned ? <span className="text-emerald-700">Came back</span> : "No order yet"}
                  {" \u00b7 "}
                  {when(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-ink-3">No retention messages yet.</p>
        )}
      </section>
    </div>
  );
}
