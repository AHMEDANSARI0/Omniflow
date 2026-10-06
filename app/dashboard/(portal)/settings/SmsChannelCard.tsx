"use client";

/** §244 SMS channel: two-way SMS on the workspace's OmniFlow number, answered from the same inbox. */
import { useCallback, useEffect, useState } from "react";
import type { SmsChannelRecent, SmsChannelState } from "../../../../lib/omniflow/portal";

const API = "/api/omniflow/portal/channels/sms";
const INPUT =
  "w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40 disabled:opacity-60";

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function errorText(payload: Record<string, unknown> | null, fallback: string): string {
  const error = payload?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

function when(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function statusTone(row: SmsChannelRecent): string {
  if (row.status === "delivered" || row.status === "received" || row.status === "read") return "text-ok";
  if (row.status === "failed" || row.status === "undelivered") return "text-danger";
  return "text-ink-3";
}

export default function SmsChannelCard() {
  const [state, setState] = useState<SmsChannelState | null>(null);
  const [limit, setLimit] = useState("");
  const [testTo, setTestTo] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"" | "switch" | "limit" | "test">("");
  const [note, setNote] = useState("");

  const apply = useCallback((next: SmsChannelState) => {
    setState(next);
    setLimit(String(next.daily_limit));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
      const payload = await readJson(response);
      if (response.ok && payload && typeof payload.daily_limit === "number") apply(payload as unknown as SmsChannelState);
      else setNote(errorText(payload, "Could not load the SMS channel right now."));
    } catch {
      setNote("Could not load the SMS channel right now.");
    } finally {
      setLoaded(true);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(kind: "switch" | "limit", body: { enabled?: boolean; daily_limit?: number }) {
    setBusy(kind);
    setNote("");
    try {
      const response = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setNote(errorText(payload, "Could not save the SMS channel right now. Try again shortly."));
        return;
      }
      const next = payload as unknown as SmsChannelState;
      apply(next);
      setNote(kind === "limit" ? "Saved." : next.enabled ? "SMS is on. New texts appear in the inbox." : "SMS is off.");
    } catch {
      setNote("Could not save the SMS channel right now. Try again shortly.");
    } finally {
      setBusy("");
    }
  }

  async function sendTest() {
    setBusy("test");
    setNote("");
    try {
      const response = await fetch(API + "/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const payload = await readJson(response);
      setNote(
        response.ok && payload?.ok
          ? "Test SMS handed to Twilio - delivery status appears below."
          : errorText(payload, "Could not send the test SMS right now.")
      );
      await load();
    } catch {
      setNote("Could not send the test SMS right now.");
    } finally {
      setBusy("");
    }
  }

  const canEdit = state?.can_edit === true;
  const ready = state ? state.twilio_ready && state.number !== "" : false;
  const limitNumber = Number(limit);
  const limitValid = /^\d{1,6}$/.test(limit) && limitNumber >= 1 && limitNumber <= (state?.daily_max ?? 0);

  return (
    <div className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            SMS channel <span className="ml-1 text-[11px] font-normal text-brand">Early access</span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Texts to your OmniFlow phone number arrive in the inbox like any chat, and replies (yours, approved drafts
            and AI answers under your autonomy settings) go back by SMS from the same number. Customers who reply STOP
            are never texted again. Pictures sent by MMS are not shown - the message says how many were sent.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Two-way texting depends on the customer&apos;s country (Twilio SMS guidelines). In Pakistan, for example,
            Twilio delivers texts from a substitute sender and customers cannot reply to them.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state?.enabled === true}
          disabled={!canEdit || busy !== "" || !state || (!state.enabled && !ready)}
          title={ready ? undefined : "Needs the platform Twilio keys and a number assigned to this workspace"}
          onClick={() => state && void save("switch", { enabled: !state.enabled })}
          className={
            "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60 " +
            (state?.enabled ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
          }
        >
          {busy === "switch" ? "Saving..." : state?.enabled ? "Channel on" : "Channel off"}
        </button>
      </div>

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading SMS settings...</p>
      ) : state && !state.available ? (
        <p className="mt-4 text-xs text-ink-3">The SMS channel is turned off on this server.</p>
      ) : state ? (
        <>
          <div className="mt-4 space-y-1 text-[11px] text-ink-3">
            <p>
              Number:{" "}
              {state.number ? (
                <span className="text-ink-2">{state.number}</span>
              ) : (
                <span className="text-ink-2">none yet - the platform admin assigns one (Integrations, Phone numbers)</span>
              )}
              {!state.twilio_ready ? " \u00b7 SMS is not set up on the platform yet" : ""}
            </p>
            <p>
              Today: {state.sent_today} of {state.daily_limit} texts sent (resets 00:00 UTC). Long replies are shortened
              to {state.max_segments} SMS parts.
            </p>
            {state.last_in_at || state.last_sent_at ? (
              <p>
                {state.last_in_at ? "Last text in: " + when(state.last_in_at) : ""}
                {state.last_in_at && state.last_sent_at ? " \u00b7 " : ""}
                {state.last_sent_at ? "Last text out: " + when(state.last_sent_at) : ""}
              </p>
            ) : null}
            {state.last_error ? <p className="text-danger">{state.last_error}</p> : null}
          </div>

          {canEdit ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex items-end gap-2">
                <label className="block flex-1 text-[11px] text-ink-2">
                  <span className="mb-1 block">Daily limit (texts sent per day, max {state.daily_max})</span>
                  <input
                    inputMode="numeric"
                    value={limit}
                    onChange={(event) => setLimit(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    className={INPUT}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy !== "" || !limitValid || limitNumber === state.daily_limit}
                  onClick={() => void save("limit", { daily_limit: limitNumber })}
                  className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
                >
                  {busy === "limit" ? "Saving..." : "Save"}
                </button>
              </div>
              <div className="flex items-end gap-2">
                <label className="block flex-1 text-[11px] text-ink-2">
                  <span className="mb-1 block">Send a test SMS to</span>
                  <input
                    type="tel"
                    value={testTo}
                    onChange={(event) => setTestTo(event.target.value.replace(/[^\d+]/g, "").slice(0, 16))}
                    placeholder="+923001234567"
                    className={INPUT}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy !== "" || !ready || !/^\+[1-9]\d{7,14}$/.test(testTo)}
                  onClick={() => void sendTest()}
                  className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
                >
                  {busy === "test" ? "Sending..." : "Send test"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-[11px] text-ink-3">Only owners and admins can change the SMS channel.</p>
          )}

          {state.recent.length > 0 ? (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line text-[11px]">
              {state.recent.map((row, index) => (
                <li key={index} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                  <span className="text-ink-2">
                    {row.direction === "in" ? "In from " : row.source === "test" ? "Test to " : "Out to "}
                    {row.contact || "unknown"}
                    {row.segments > 1 ? " \u00b7 " + row.segments + " parts" : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={statusTone(row)}>
                      {row.status || "queued"}
                      {row.error_code ? " (Twilio error " + row.error_code + ")" : ""}
                    </span>
                    <span className="text-ink-3">{when(row.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {note ? <p className="mt-3 text-xs text-ink-2">{note}</p> : null}
    </div>
  );
}
