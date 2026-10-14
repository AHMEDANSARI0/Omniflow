"use client";

import { useCallback, useEffect, useState } from "react";

/** §214: the Twilio account's numbers, whether each one reaches this
 * Control Plane, and a confirmed one-click Connect (sets the number's
 * Voice URL + status callback in Twilio - no console step). §244: the
 * same for SMS ("Connect SMS" sets only the number's SMS webhook). */
interface TwilioNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  state: string;
  voice_host: string;
  voice_capable: boolean;
  sms_state: string;
  sms_host: string;
  sms_capable: boolean;
  assigned_client_id: number | null;
}

interface TwilioPayload {
  base_url: string;
  base_source: string;
  voice_url: string;
  status_url: string;
  sms_url: string;
  numbers: TwilioNumber[];
  truncated: boolean;
}

const STATE_LABELS: Record<string, { label: string; ok: boolean }> = {
  connected: { label: "Connected", ok: true },
  partial: { label: "Status updates missing", ok: false },
  elsewhere: { label: "Points elsewhere", ok: false },
  not_set: { label: "Not set up", ok: false },
  app: { label: "Uses a TwiML app", ok: false },
  trunk: { label: "Uses a SIP trunk", ok: false },
};

const SMS_LABELS: Record<string, { label: string; ok: boolean }> = {
  connected: { label: "SMS connected", ok: true },
  elsewhere: { label: "SMS points elsewhere", ok: false },
  not_set: { label: "SMS not set up", ok: false },
  app: { label: "SMS uses a TwiML app", ok: false },
};

const SOURCE_LABELS: Record<string, string> = {
  env: "from the server environment",
  panel: "from the Voice channel settings",
  request: "detected from this request - set Webhook address in the Voice channel to pin it",
  none: "",
};

export default function TwilioNumbersSection({
  onPick,
}: {
  onPick: (number: string) => void;
}) {
  const [data, setData] = useState<TwilioPayload | null>(null);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/admin/voice/twilio", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | (TwilioPayload & { error?: { message?: string } })
        | null;
      if (response.ok && payload && Array.isArray(payload.numbers)) {
        setData(payload);
        setProblem("");
      } else {
        setData(null);
        setProblem(payload?.error?.message || "Could not load the Twilio numbers.");
      }
    } catch {
      setData(null);
      setProblem("Could not load the Twilio numbers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(row: TwilioNumber, what: "voice" | "sms" = "voice") {
    if (busy || !data) return;
    const host = what === "sms" ? row.sms_host : row.voice_host;
    const elsewhere = (what === "sms" ? row.sms_state : row.state) === "elsewhere";
    const current =
      elsewhere && host
        ? " It currently sends " + (what === "sms" ? "texts" : "calls") + " to " + host + "."
        : "";
    const ok = window.confirm(
      what === "sms"
        ? "Send SMS for " +
            row.phone_number +
            " to OmniFlow?" +
            current +
            "\n\nTwilio will post incoming texts to " +
            data.sms_url +
            ". Call routing is not changed. If the number belongs to a Messaging Service, set the service's incoming webhook to the same address."
        : "Point " +
            row.phone_number +
            " at OmniFlow?" +
            current +
            "\n\nTwilio will send its calls to " +
            data.voice_url +
            " and call status updates to " +
            data.status_url +
            "."
    );
    if (!ok) return;
    setBusy(row.sid + what);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/admin/voice/twilio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: row.sid, what }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setNotice({
          text: row.phone_number + (what === "sms" ? " now sends its texts to OmniFlow." : " now reaches OmniFlow."),
          ok: true,
        });
        await load();
      } else {
        setNotice({
          text: payload?.error?.message || "Twilio did not accept the change.",
          ok: false,
        });
      }
    } catch {
      setNotice({ text: "Could not reach the server. Try again.", ok: false });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-line bg-soft/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">Twilio account numbers</p>
        <button
          onClick={() => void load()}
          disabled={loading || busy !== ""}
          className="text-[11px] font-medium text-brand disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {data?.base_url ? (
        <p className="mt-1 text-[11px] text-ink-3">
          Calls reach {data.base_url}
          {SOURCE_LABELS[data.base_source] ? " (" + SOURCE_LABELS[data.base_source] + ")" : ""}.
        </p>
      ) : data ? (
        <p className="mt-1 text-[11px] text-danger">
          Set the Webhook address in the Voice channel settings before connecting numbers.
        </p>
      ) : null}
      {problem ? <p className="mt-2 text-[11px] text-ink-3">{problem}</p> : null}
      {data && data.numbers.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-3">This Twilio account has no phone numbers.</p>
      ) : null}
      {data && data.numbers.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {data.numbers.map((row) => {
            const state = STATE_LABELS[row.state] ?? { label: row.state, ok: false };
            const sms = SMS_LABELS[row.sms_state] ?? { label: row.sms_state, ok: false };
            const blocked = row.state === "app" || row.state === "trunk";
            return (
              <li
                key={row.sid}
                className="rounded-xl border border-line bg-white px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ink">
                    {row.phone_number}
                    {row.friendly_name && row.friendly_name !== row.phone_number ? (
                      <span className="ml-2 text-ink-3">{row.friendly_name}</span>
                    ) : null}
                    {row.assigned_client_id ? (
                      <span className="ml-2 text-ink-3">workspace {row.assigned_client_id}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "rounded-md border px-2 py-0.5 text-[10px] " +
                        (state.ok
                          ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                          : "border-line bg-soft text-ink-3")
                      }
                    >
                      {state.label}
                    </span>
                    {row.state !== "connected" && !blocked && row.voice_capable ? (
                      <button
                        onClick={() => void connect(row)}
                        disabled={busy !== "" || !data.base_url}
                        className="rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand disabled:opacity-50"
                      >
                        {busy === row.sid + "voice" ? "Connecting…" : "Connect"}
                      </button>
                    ) : null}
                    {row.sms_capable ? (
                      <span
                        className={
                          "rounded-md border px-2 py-0.5 text-[10px] " +
                          (sms.ok
                            ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                            : "border-line bg-soft text-ink-3")
                        }
                      >
                        {sms.label}
                      </span>
                    ) : null}
                    {row.sms_capable && row.sms_state !== "connected" && row.sms_state !== "app" ? (
                      <button
                        onClick={() => void connect(row, "sms")}
                        disabled={busy !== "" || !data.base_url}
                        className="rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand disabled:opacity-50"
                      >
                        {busy === row.sid + "sms" ? "Connecting…" : "Connect SMS"}
                      </button>
                    ) : null}
                    {!row.assigned_client_id ? (
                      <button
                        onClick={() => onPick(row.phone_number)}
                        className="text-[11px] font-medium text-ink-2"
                      >
                        Use
                      </button>
                    ) : null}
                  </span>
                </div>
                {blocked ? (
                  <p className="mt-1 text-[10px] text-ink-3">
                    Twilio ignores webhook addresses while a{" "}
                    {row.state === "app" ? "TwiML app" : "SIP trunk"} is attached. Remove it
                    from this number in the Twilio console, then refresh.
                  </p>
                ) : null}
                {!row.voice_capable ? (
                  <p className="mt-1 text-[10px] text-ink-3">This number cannot take calls.</p>
                ) : null}
                {row.sms_state === "app" ? (
                  <p className="mt-1 text-[10px] text-ink-3">
                    Twilio ignores the SMS webhook while a TwiML app handles this number&apos;s texts. Remove it in the
                    Twilio console, then refresh.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {data?.truncated ? (
        <p className="mt-2 text-[10px] text-ink-3">Showing the first page of numbers only.</p>
      ) : null}
      {notice ? (
        <p className={"mt-2 text-[11px] " + (notice.ok ? "text-ok" : "text-danger")}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
