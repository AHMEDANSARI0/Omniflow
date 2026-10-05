"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AbConfig,
  AbMetric,
  AbPlan,
  AbTest,
  AbVariant,
} from "../../../../lib/omniflow/portal";

const API = "/api/omniflow/portal/ab-tests";
/** CopyGenCard dispatches this with its versions ("A/B test these"). */
export const AB_PREFILL_EVENT = "of:ab-prefill";

const card = "rounded-2xl border border-line bg-white shadow-card";
const field =
  "w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand/40";
const select =
  "rounded-xl border border-line bg-white px-2.5 py-1.5 text-xs text-ink-2 focus:border-brand/40 focus:outline-none";
const primary =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";
const quiet =
  "rounded-xl border border-line bg-soft px-3 py-1.5 text-xs text-ink-2 transition-colors duration-300 hover:text-ink disabled:opacity-50";

const PERCENTS = [20, 30, 50, 100];
const HOURS = [6, 12, 24, 48, 72];

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function errorOf(payload: Record<string, unknown> | null): string {
  const error = payload?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "Try again shortly.";
}

function when(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function rate(value: number | null): string {
  return value === null ? "—" : String(value) + "%";
}

function withOption(list: number[], value: number): number[] {
  return list.includes(value) ? list : [...list, value].sort((a, b) => a - b);
}

function statusChip(test: AbTest): { text: string; tone: string } {
  if (test.status === "completed") return { text: "Completed", tone: "text-ok border-emerald-400/25" };
  if (test.status === "cancelled") return { text: "Cancelled", tone: "text-ink-3 border-line" };
  if (test.windowOver) return { text: "Ready to decide", tone: "text-amber-600 border-amber-400/30" };
  return { text: "Collecting results", tone: "text-brand border-brand/25" };
}

function VariantRow({
  variant,
  test,
  currency,
}: {
  variant: AbVariant;
  test: AbTest;
  currency: string;
}) {
  const winner = test.winner === variant.label;
  const leading = !test.winner && test.decision.leader === variant.label;
  return (
    <tr className={"border-t border-line align-top " + (winner || leading ? "bg-brand-soft/40" : "")}>
      <td className="py-2 pr-3">
        <span className="font-semibold text-ink">{variant.label}</span>
        {winner ? (
          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-ok">Winner</span>
        ) : leading ? (
          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-brand">Leading</span>
        ) : null}
        <p className="mt-0.5 line-clamp-2 max-w-xs whitespace-pre-wrap break-words text-[11px] text-ink-3">
          {variant.body}
        </p>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-ink-2">
        {variant.sent}
        {variant.failed > 0 ? <span className="block text-[10px] text-danger">{variant.failed} failed</span> : null}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-ink-2">
        {variant.replied} <span className="text-ink-3">({rate(variant.replyRate)})</span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-ink-2">
        {variant.ordered} <span className="text-ink-3">({rate(variant.orderRate)})</span>
      </td>
      <td className="py-2 text-right tabular-nums text-ink-2">
        {currency} {variant.sales.toLocaleString("en-US", { maximumFractionDigits: 0 })}
      </td>
    </tr>
  );
}

function TestCard({
  test,
  config,
  onChanged,
}: {
  test: AbTest;
  config: AbConfig;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const chip = statusChip(test);
  const audience =
    config.audiences.find((option) => option.key === test.audience)?.label ?? test.audience;
  const metricLabel = config.metrics.find((m) => m.key === test.metric)?.label ?? test.metric;

  async function act(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(API + "/" + String(test.id) + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body ?? {}),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setNote({ ok: false, text: errorOf(payload) });
        return;
      }
      setConfirm(null);
      if (path === "/winner") {
        const sent = typeof payload?.sent === "number" ? payload.sent : 0;
        setNote({ ok: true, text: sent > 0 ? "Queued for " + String(sent) + " customers." : "Winner saved." });
      }
      await onChanged();
    } catch {
      setNote({ ok: false, text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={card + " p-4"}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{test.name || "A/B test"}</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {audience} · tested on {test.testSize} of {test.audienceSize} customers ({test.testPercent}%) ·
            judged by {metricLabel.toLowerCase()} within {test.decideHours} h · {when(test.createdAt)}
          </p>
        </div>
        <span className={"shrink-0 self-start rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider " + chip.tone}>
          {chip.text}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-3">
              <th className="pb-1.5 text-left font-semibold">Version</th>
              <th className="pb-1.5 pr-3 text-right font-semibold">Sent</th>
              <th className="pb-1.5 pr-3 text-right font-semibold">Replied</th>
              <th className="pb-1.5 pr-3 text-right font-semibold">Paid orders</th>
              <th className="pb-1.5 text-right font-semibold">Sales</th>
            </tr>
          </thead>
          <tbody>
            {test.variants.map((variant) => (
              <VariantRow key={variant.label} variant={variant} test={test} currency={config.currency} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-ink-2">
        {test.status === "completed"
          ? "Version " + String(test.winner) + " won (" + (test.winnerReason === "auto" ? "picked automatically" : "picked by you") + ")" +
            (test.restSent > 0 ? " and went to " + String(test.restSent) + " more customers." : ".")
          : test.status === "cancelled"
            ? "Cancelled — messages already sent stay sent."
            : test.decision.reason}
      </p>
      {test.status === "running" && !test.windowOver ? (
        <p className="mt-1 text-[11px] text-ink-3">Collecting results until {when(test.decideAt)}.</p>
      ) : null}
      {test.autoPending ? (
        <p className="mt-1 text-[11px] text-ink-3">
          The winner goes out automatically at {when(test.decideAt)} — only if one version clearly wins.
        </p>
      ) : null}
      {test.status === "running" && test.autoNote ? (
        <p className="mt-1 text-[11px] text-amber-600">{test.autoNote}</p>
      ) : null}
      <p className="mt-1 text-[10px] text-ink-3">
        A reply or paid order counts when it comes from that customer within {test.decideHours} h of their message.
      </p>

      {test.status === "running" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirm ? (
            <>
              <span className="text-xs text-amber-600">
                {confirm === "cancel"
                  ? "Stop this test? Sent messages cannot be recalled."
                  : test.restSize > 0
                    ? "Send version " + confirm + " to the remaining customers on WhatsApp?"
                    : "Mark version " + confirm + " as the winner?"}
              </span>
              <button type="button" className={quiet} disabled={busy} onClick={() => setConfirm(null)}>
                Back
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy}
                onClick={() =>
                  void (confirm === "cancel" ? act("/cancel") : act("/winner", { variant: confirm }))
                }
              >
                {busy ? "Working…" : "Confirm"}
              </button>
            </>
          ) : (
            <>
              {test.variants.map((variant) => (
                <button
                  key={variant.label}
                  type="button"
                  className={variant.label === test.decision.leader ? primary : quiet}
                  onClick={() => setConfirm(variant.label)}
                >
                  {test.restSize > 0
                    ? "Send " + variant.label + " to the remaining ~" + String(test.restSize)
                    : "Mark " + variant.label + " as winner"}
                </button>
              ))}
              <button type="button" className={quiet} onClick={() => setConfirm("cancel")}>
                Cancel test
              </button>
            </>
          )}
        </div>
      ) : null}
      {note ? <p className={"mt-2 text-xs " + (note.ok ? "text-ok" : "text-danger")}>{note.text}</p> : null}
    </li>
  );
}

/**
 * Broadcasts -> A/B tests: 2-4 versions go to a random slice of the
 * audience; replies / paid orders decide; the winner goes to the rest by
 * the owner's click or automatically when it is clear (owner's choice).
 */
export default function ABTests() {
  const [tests, setTests] = useState<AbTest[]>([]);
  const [config, setConfig] = useState<AbConfig | null>(null);
  const [failed, setFailed] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [audience, setAudience] = useState("all");
  const [variants, setVariants] = useState<string[]>(["", ""]);
  const [percent, setPercent] = useState(30);
  const [hours, setHours] = useState(24);
  const [metric, setMetric] = useState<AbMetric>("reply");
  const [auto, setAuto] = useState(false);
  const [plan, setPlan] = useState<AbPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const defaultsApplied = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setFailed(errorOf(payload));
        return;
      }
      setFailed("");
      setTests((payload.tests as AbTest[]) ?? []);
      const next = payload.config as AbConfig | undefined;
      if (next) {
        setConfig(next);
        if (!defaultsApplied.current) {
          defaultsApplied.current = true;
          setPercent(next.defaultPercent);
          setHours(next.defaultHours);
        }
      }
    } catch {
      setFailed("Network error — try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function prefill(event: Event) {
      const detail = (event as CustomEvent<string[]>).detail;
      if (!Array.isArray(detail) || detail.length < 2) return;
      setVariants(detail.slice(0, config?.maxVariants ?? 3));
      setPlan(null);
      setOpen(true);
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.addEventListener(AB_PREFILL_EVENT, prefill);
    return () => window.removeEventListener(AB_PREFILL_EVENT, prefill);
  }, [config]);

  const input = {
    name: name.trim(),
    audience,
    variants: variants.map((v) => v.trim()),
    testPercent: percent,
    decideHours: hours,
    metric,
    autoWinner: auto && percent < 100,
  };
  const ready = input.variants.every((v) => v.length > 0);

  async function submit(dryRun: boolean) {
    if (!ready || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...input, dryRun }),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setMessage({ ok: false, text: errorOf(payload) });
        if (!dryRun) setPlan(null);
        return;
      }
      if (dryRun) {
        setPlan(payload.plan as AbPlan);
        return;
      }
      const started = payload.plan as AbPlan;
      setMessage({
        ok: true,
        text: "Test started — " + String(started.testSize) + " messages queued (about " +
          String(started.perVariant) + " per version).",
      });
      setPlan(null);
      setOpen(false);
      setName("");
      setVariants(["", ""]);
      setAuto(false);
      await load();
    } catch {
      setMessage({ ok: false, text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  function edit(apply: () => void) {
    apply();
    setPlan(null);
  }

  const maxVariants = config?.maxVariants ?? 3;
  const maxBody = config?.maxBody ?? 1000;

  return (
    <section ref={panel} className={card + " mx-auto max-w-3xl p-4 sm:p-5"}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">{"\u2442"} A/B tests</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Send 2–{maxVariants} versions to a random part of the audience, see which gets more replies or
            paid orders, then send the winner to everyone else.
          </p>
        </div>
        {!open ? (
          <button type="button" className={primary + " shrink-0"} onClick={() => setOpen(true)}>
            New A/B test
          </button>
        ) : null}
      </div>

      {open && config ? (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-soft/40 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={name}
              maxLength={80}
              onChange={(event) => edit(() => setName(event.target.value))}
              placeholder="Test name, e.g. Eid sale wording"
              className={field}
            />
            <select
              value={audience}
              onChange={(event) => edit(() => setAudience(event.target.value))}
              className={select + " sm:w-48"}
              aria-label="Audience"
            >
              {config.audiences.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {variants.map((text, index) => (
            <div key={index}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-ink-2">Version {"ABCD"[index]}</span>
                {variants.length > 2 ? (
                  <button
                    type="button"
                    className="text-[11px] text-ink-3 hover:text-danger"
                    onClick={() => edit(() => setVariants(variants.filter((_v, i) => i !== index)))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <textarea
                value={text}
                rows={3}
                maxLength={maxBody}
                onChange={(event) =>
                  edit(() => setVariants(variants.map((v, i) => (i === index ? event.target.value : v))))
                }
                placeholder={index === 0 ? "Hi {name}! Eid sale — 20% off this week." : "Salam {name}, Eid offer: 20% off till Sunday."}
                className={field + " mt-1 resize-none"}
              />
            </div>
          ))}
          {variants.length < maxVariants ? (
            <button type="button" className="text-[11px] text-brand hover:underline" onClick={() => edit(() => setVariants([...variants, ""]))}>
              + Add version
            </button>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-[11px] text-ink-3">
              Test on
              <select value={percent} onChange={(event) => edit(() => setPercent(Number(event.target.value)))} className={select + " mt-1 w-full"}>
                {withOption(PERCENTS, config.defaultPercent).map((value) => (
                  <option key={value} value={value}>
                    {value === 100 ? "Everyone (split evenly)" : String(value) + "% of the audience"}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-3">
              Judge by
              <select value={metric} onChange={(event) => edit(() => setMetric(event.target.value === "order" ? "order" : "reply"))} className={select + " mt-1 w-full"}>
                {config.metrics.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-3">
              Decide after
              <select value={hours} onChange={(event) => edit(() => setHours(Number(event.target.value)))} className={select + " mt-1 w-full"}>
                {withOption(HOURS, config.defaultHours).map((value) => (
                  <option key={value} value={value}>
                    {String(value)} hours
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={"flex items-start gap-2 text-[11px] " + (percent < 100 ? "text-ink-2" : "text-ink-3")}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={auto && percent < 100}
              disabled={percent >= 100}
              onChange={(event) => edit(() => setAuto(event.target.checked))}
            />
            <span>
              Send the winner to the rest automatically when the time is up — only if one version clearly wins
              (at least {config.minPerVariant} customers per version, {config.confidence}% confidence). Otherwise
              you get a notification and pick yourself.
            </span>
          </label>

          {plan ? (
            <div className="rounded-xl border border-brand/20 bg-white p-3 text-[11px] text-ink-2">
              <p>
                {plan.testSize} of {plan.audienceSize} customers get a version now (about {plan.perVariant} each).
                {plan.restSize > 0
                  ? " The other " + String(plan.restSize) + " get the winner later" +
                    (plan.autoWinner ? " — automatically if it is clear." : " — when you pick it.")
                  : ""}
              </p>
              {plan.warnings.map((warning) => (
                <p key={warning} className="mt-1 text-amber-600">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={quiet} disabled={busy} onClick={() => { setOpen(false); setPlan(null); }}>
              Close
            </button>
            {plan ? (
              <button type="button" className={primary} disabled={busy || !ready} onClick={() => void submit(false)}>
                {busy ? "Starting…" : "Start test — send " + String(plan.testSize) + " messages"}
              </button>
            ) : (
              <button type="button" className={primary} disabled={busy || !ready} onClick={() => void submit(true)}>
                {busy ? "Checking…" : "Review"}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {message ? <p className={"mt-3 text-xs " + (message.ok ? "text-ok" : "text-danger")}>{message.text}</p> : null}
      {failed ? <p className="mt-3 text-xs text-danger">{failed}</p> : null}

      {config && tests.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {tests.map((test) => (
            <TestCard key={test.id} test={test} config={config} onChanged={load} />
          ))}
        </ul>
      ) : config && !failed ? (
        <p className="mt-3 text-[11px] text-ink-3">No A/B tests yet.</p>
      ) : null}
    </section>
  );
}
