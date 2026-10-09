"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  NlAnswer,
  NlCatalog,
  NlPin,
  NlPlan,
  NlUnit,
} from "../../../../lib/omniflow/portal";
import PortalIcon from "../../components/PortalIcon";

const ASK = "/api/omniflow/portal/analytics/ask";
const PINS = "/api/omniflow/portal/analytics/pins";

const card = "rounded-2xl border border-line bg-white shadow-card";
const chip =
  "rounded-xl border border-line bg-soft inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 transition-colors duration-300 hover:border-brand/25 hover:text-brand";
const select =
  "rounded-xl border border-line bg-white px-2.5 py-1.5 text-xs text-ink-2 focus:border-brand/40 focus:outline-none";

function formatValue(value: number | null, unit: NlUnit, currency: string): string {
  if (value === null) return "—";
  if (unit === "percent") return String(Math.round(value * 10) / 10) + "%";
  if (unit === "score") return value.toFixed(2);
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  const text = value.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return unit === "money" ? (currency ? currency + " " : "") + text : text;
}

function changeText(answer: NlAnswer): { text: string; good: boolean | null } | null {
  const delta = answer.changePoints ?? answer.changePct;
  if (delta === null || answer.previous === null) return null;
  const suffix = answer.changePoints !== null ? " pts" : "%";
  if (delta === 0) return { text: "No change", good: null };
  const up = delta > 0;
  return {
    text: (up ? "+" : "−") + String(Math.abs(Math.round(delta * 10) / 10)) + suffix,
    good: up === (answer.goodDirection === "up"),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function errorOf(payload: Record<string, unknown> | null): string {
  const error = payload?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "Try again shortly.";
}

function Chart({ answer }: { answer: NlAnswer }) {
  const values = answer.series.map((point) => point.value ?? 0);
  const max = Math.max(1, ...values, ...answer.series.map((point) => point.previous ?? 0));
  if (answer.chart === "time") {
    const step = answer.series.length > 14 ? Math.ceil(answer.series.length / 7) : 1;
    return (
      <div className="mt-5">
        <div className="flex h-32 items-end gap-1">
          {answer.series.map((point) => (
            <div
              key={point.key}
              title={point.label + ": " + formatValue(point.value, answer.unit, answer.currency)}
              className="flex h-full flex-1 flex-col justify-end"
            >
              <div
                className="w-full rounded-t-md bg-brand/70"
                style={{
                  height:
                    (point.value === null
                      ? 0
                      : Math.max(point.value === 0 ? 2 : 6, Math.round(((point.value ?? 0) / max) * 100))) + "%",
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex gap-1">
          {answer.series.map((point, index) => (
            <div key={point.key} className="flex-1 text-center">
              {index % step === 0 ? (
                <span className="text-[9px] text-ink-3">{point.label.replace("Week of ", "")}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (answer.chart !== "rank") return null;
  return (
    <ul className="mt-5 space-y-3">
      {answer.series.map((point) => (
        <li key={point.key + point.label}>
          <div className="flex items-center justify-between gap-4 text-xs">
            <span className="min-w-0 truncate text-ink-2">{point.label}</span>
            <span className="shrink-0 text-ink">
              {formatValue(point.value, answer.unit, answer.currency)}
              {point.previous !== null ? (
                <span className="ml-2 text-ink-3">
                  was {formatValue(point.previous, answer.unit, answer.currency)}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-soft">
            <div
              className="h-full rounded-full bg-brand/70"
              style={{ width: Math.max(3, Math.round(((point.value ?? 0) / max) * 100)) + "%" }}
            />
          </div>
        </li>
      ))}
      {answer.others !== null ? (
        <li className="text-[11px] text-ink-3">
          Everything else: {formatValue(answer.others, answer.unit, answer.currency)}
        </li>
      ) : null}
    </ul>
  );
}

export default function AskData() {
  const [catalog, setCatalog] = useState<NlCatalog | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<NlAnswer | null>(null);
  const [message, setMessage] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pins, setPins] = useState<NlPin[]>([]);
  const [pinNote, setPinNote] = useState("");

  const loadPins = useCallback(async () => {
    try {
      const response = await fetch(PINS, { credentials: "same-origin", cache: "no-store" });
      const payload = await readJson(response);
      if (response.ok && payload && Array.isArray(payload.pins)) {
        setPins(payload.pins as NlPin[]);
      }
    } catch {
      // Pins are optional; the ask box keeps working.
    }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(ASK, { credentials: "same-origin", cache: "no-store" });
        const payload = await readJson(response);
        if (live && response.ok && payload && Array.isArray(payload.metrics)) {
          setCatalog(payload as unknown as NlCatalog);
        }
      } catch {
        // The panel stays hidden until the server answers.
      }
    })();
    void loadPins();
    return () => {
      live = false;
    };
  }, [loadPins]);

  const run = useCallback(async (body: { question?: string; plan?: NlPlan }) => {
    setBusy(true);
    setMessage("");
    setPinNote("");
    try {
      const response = await fetch(ASK, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setMessage(errorOf(payload));
        return;
      }
      const next = (payload.answer as NlAnswer | null) ?? null;
      setAnswer(next);
      setMessage(typeof payload.message === "string" ? payload.message : "");
      setSuggestions(Array.isArray(payload.suggestions) ? (payload.suggestions as string[]) : []);
    } catch {
      setMessage("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const ask = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      setQuestion(clean);
      setAsked(clean);
      void run({ question: clean });
    },
    [busy, run]
  );

  const adjust = useCallback(
    (change: Partial<NlPlan>) => {
      if (!answer || busy) return;
      void run({ plan: { ...answer.plan, ...change } });
    },
    [answer, busy, run]
  );

  const pin = useCallback(async () => {
    if (!answer) return;
    setPinNote("");
    try {
      const response = await fetch(PINS, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: asked || answer.label, plan: answer.plan }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setPinNote(errorOf(payload));
        return;
      }
      setPinNote(payload?.duplicate ? "Already pinned." : "Pinned below.");
      void loadPins();
    } catch {
      setPinNote("Could not pin. Try again.");
    }
  }, [answer, asked, loadPins]);

  const unpin = useCallback(
    async (id: number) => {
      try {
        const response = await fetch(PINS + "/" + String(id), {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (response.ok) setPins((current) => current.filter((item) => item.id !== id));
      } catch {
        // Keep the pin; the next load shows the truth.
      }
    },
    []
  );

  if (!catalog) return null;
  const metric = answer ? catalog.metrics.find((item) => item.key === answer.metric) : undefined;
  const change = answer ? changeText(answer) : null;
  const periodKnown = answer ? catalog.periods.some((item) => item.key === answer.plan.period) : true;

  return (
    <div className="mb-6 space-y-4">
      <div className={card + " p-6"}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">
            <PortalIcon name="sparkles" className="mr-1.5 inline-block h-4 w-4 align-[-3px] text-brand" />Ask your data
          </h2>
          {!catalog.ai.ready ? (
            <span className="text-[10px] text-ink-3" title={catalog.ai.reason}>
              Keyword mode
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-ink-3">
          Ask in your own words, in English or Roman Urdu. Numbers come straight from your
          data, and each answer shows how it was measured.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={300}
            placeholder="How many paid orders this week vs last week?"
            className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3.5 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity duration-300 disabled:opacity-50"
          >
            {busy ? "Working…" : "Ask"}
          </button>
        </form>
        {!answer || message ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {(suggestions.length ? suggestions : catalog.suggestions).map((item) => (
              <button key={item} type="button" className={chip} onClick={() => ask(item)}>
                {item}
              </button>
            ))}
          </div>
        ) : null}
        {message ? <p className="mt-3 text-xs leading-relaxed text-ink-2">{message}</p> : null}
      </div>

      {answer && !message ? (
        <div className={card + " p-6" + (busy ? " opacity-60" : "")}>
          <p className="text-sm font-medium leading-relaxed text-ink">{answer.headline}</p>
          {!answer.empty || answer.value !== null ? (
            <div className="mt-3 flex flex-wrap items-baseline gap-3">
              <span className="text-3xl font-semibold tracking-tight text-ink">
                {formatValue(answer.value, answer.unit, answer.currency)}
              </span>
              {change ? (
                <span
                  className={
                    "rounded-lg px-2 py-0.5 text-xs font-medium " +
                    (change.good === null
                      ? "bg-soft text-ink-3"
                      : change.good
                        ? "bg-ok-soft text-ok"
                        : "bg-danger-soft text-danger")
                  }
                >
                  {change.text}
                </span>
              ) : null}
              {answer.previous !== null ? (
                <span className="text-xs text-ink-3">
                  {answer.previousLabel}: {formatValue(answer.previous, answer.unit, answer.currency)}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <select
              aria-label="Period"
              className={select}
              value={answer.plan.period}
              disabled={busy}
              onChange={(event) => adjust({ period: event.target.value })}
            >
              {!periodKnown ? <option value={answer.plan.period}>{answer.periodRange}</option> : null}
              {catalog.periods.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Show"
              className={select}
              value={answer.plan.groupBy}
              disabled={busy}
              onChange={(event) => adjust({ groupBy: event.target.value })}
            >
              <option value="none">Total</option>
              <option value="day">By day</option>
              <option value="week">By week</option>
              <option value="month">By month</option>
              {(metric?.dims ?? []).map((dim) => (
                <option key={dim.key} value={dim.key}>
                  By {dim.label.toLowerCase()}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={answer.plan.compare === "previous"}
                disabled={busy}
                onChange={(event) => adjust({ compare: event.target.checked ? "previous" : "none" })}
              />
              Compare with the previous period
            </label>
            {catalog.canPin ? (
              <button
                type="button"
                onClick={() => void pin()}
                className="ml-auto rounded-xl border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-brand/25 hover:text-brand"
              >
                <PortalIcon name="pin" className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]" /> Pin
              </button>
            ) : null}
          </div>
          {pinNote ? <p className="mt-2 text-[11px] text-ink-3">{pinNote}</p> : null}

          <Chart answer={answer} />

          <details className="mt-5 rounded-xl bg-soft px-4 py-3">
            <summary className="cursor-pointer text-xs font-medium text-ink-2">
              How this was measured
            </summary>
            <ul className="mt-2 space-y-1">
              {answer.how.map((line) => (
                <li key={line} className="text-[11px] leading-relaxed text-ink-3">
                  {line}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {pins.length ? (
        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-wider text-ink-3">Pinned questions</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {pins.map((item) => (
              <div key={item.id} className={card + " px-5 py-4"}>
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => {
                      if (!item.answer) return;
                      setAsked(item.question);
                      setQuestion(item.question);
                      setMessage("");
                      setAnswer(item.answer);
                    }}
                  >
                    <p className="truncate text-xs text-ink-3">{item.question}</p>
                    <p className="mt-1 text-lg font-semibold text-ink">
                      {item.answer
                        ? formatValue(item.answer.value, item.answer.unit, item.answer.currency)
                        : "—"}
                    </p>
                  </button>
                  {catalog.canPin ? (
                    <button
                      type="button"
                      onClick={() => void unpin(item.id)}
                      className="shrink-0 text-[11px] text-ink-3 hover:text-danger"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                  {item.answer ? item.answer.headline : item.error}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
