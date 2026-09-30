"use client";

import { useCallback, useEffect, useState } from "react";

type Severity = "normal" | "high";

interface NotifySettings {
  email_enabled: boolean;
  email_to: string;
  min_severity: Severity;
  kinds: Record<string, boolean>;
}

interface NotifyKind {
  key: string;
  label: string;
  description: string;
}

interface NotificationItem {
  id: number;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  conversation_id: number | null;
  email_to: string;
  email_status: string;
  email_error: string;
  created_at: string | null;
}

interface Payload {
  items: NotificationItem[];
  settings: NotifySettings;
  kinds: NotifyKind[];
  severities: Severity[];
  email_configured: boolean;
}

interface TestResult {
  ok: boolean;
  result: {
    in_app: number | null;
    email: string;
    email_to: string;
    ledger_id: number | null;
    error: string;
  };
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line px-3 py-2 text-xs text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-50";

const EMAIL_STATUS_LABEL: Record<string, string> = {
  off: "bell only",
  sent: "email sent",
  queued: "email queued",
  failed: "email failed",
  deduped: "already open",
  no_recipient: "no recipient",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

/**
 * Settings -> Notifications: what reaches the owner outside the dashboard.
 * The bell is always on (its own switch lives in the bell); email is an
 * opt-in per workspace with a recipient, a severity threshold and per-kind
 * toggles rendered from the Control Plane registry. "Send a test" runs the
 * real fan-out and shows the honest result.
 */
export default function NotificationsCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<NotifySettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/notifications?limit=20", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setData(null);
        return;
      }
      const body = (await response.json()) as Payload;
      setData(body);
      setForm(body.settings);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/notifications/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = (await response.json().catch(() => null)) as
        | { settings?: NotifySettings; error?: { message?: string } }
        | null;
      if (!response.ok) {
        setNotice({
          kind: "error",
          text: body?.error?.message ?? "Those settings could not be saved.",
        });
        return;
      }
      if (body?.settings) setForm(body.settings);
      setNotice({ kind: "ok", text: "Notification settings saved." });
      await load();
    } catch {
      setNotice({ kind: "error", text: "Could not reach the workspace. Try again shortly." });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/notifications/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as TestResult | null;
      if (!response.ok || !body) {
        setNotice({ kind: "error", text: "The test could not be sent. Try again shortly." });
        return;
      }
      const r = body.result;
      const bell = r.in_app ? "Bell alert created" : "Bell alert skipped (alerts are off or one is already open)";
      const email =
        r.email === "sent"
          ? "email sent to " + r.email_to
          : r.email === "failed"
            ? "email failed: " + (r.error || "delivery error")
            : r.email === "no_recipient"
              ? "email skipped: no recipient"
              : r.email === "off"
                ? "email is off"
                : "email " + r.email;
      setNotice({ kind: r.email === "failed" ? "error" : "ok", text: bell + " \u00b7 " + email + "." });
      await load();
    } catch {
      setNotice({ kind: "error", text: "Could not reach the workspace. Try again shortly." });
    } finally {
      setBusy(false);
    }
  }

  const kinds = data?.kinds ?? [];

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Notifications</h2>
          <p className="mt-1 text-xs text-ink-3">
            Handoffs, approvals, failed deliveries and workflow problems always
            reach the bell. Turn on email to be told when you are away from the
            dashboard.
          </p>
        </div>
        {data && !data.email_configured ? (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 text-[10px] text-amber-700">
            Email provider not configured on the platform
          </span>
        ) : null}
      </div>

      {!loaded ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : !data || !form ? (
        <p className="mt-3 text-xs text-ink-3">
          Notification settings are unavailable right now. Try again shortly.
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={form.email_enabled}
                onChange={(event) => setForm({ ...form, email_enabled: event.target.checked })}
                className="h-4 w-4 rounded border-line"
              />
              Email me as well as the bell
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] text-ink-3">Send to</p>
                <input
                  value={form.email_to}
                  onChange={(event) => setForm({ ...form, email_to: event.target.value })}
                  placeholder="Leave blank to use the workspace owner's address"
                  maxLength={200}
                  className={inputClass}
                />
              </div>
              <div>
                <p className="mb-1 text-[11px] text-ink-3">Email me for</p>
                <select
                  value={form.min_severity}
                  onChange={(event) =>
                    setForm({ ...form, min_severity: event.target.value === "high" ? "high" : "normal" })
                  }
                  className={inputClass}
                >
                  <option value="normal">Everything I have switched on</option>
                  <option value="high">Only high-priority (policy blocks, approvals, revenue)</option>
                </select>
              </div>
            </div>
            <div>
              <p className="mb-1 text-[11px] text-ink-3">What to email about</p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {kinds.map((kind) => (
                  <li key={kind.key}>
                    <label className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={form.kinds[kind.key] !== false}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            kinds: { ...form.kinds, [kind.key]: event.target.checked },
                          })
                        }
                        className="mt-0.5 h-4 w-4 rounded border-line"
                      />
                      <span>
                        <span className="font-medium">{kind.label}</span>
                        <span className="block text-[10px] text-ink-3">{kind.description}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>
              {busy ? "Working\u2026" : "Save"}
            </button>
            <button type="button" onClick={() => void sendTest()} disabled={busy} className={ghostBtn}>
              Send a test
            </button>
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              className={ghostBtn}
            >
              {showHistory ? "Hide recent" : "Recent notifications"}
            </button>
          </div>
          {notice ? (
            <p className={"mt-3 text-xs " + (notice.kind === "ok" ? "text-ok" : "text-danger")}>
              {notice.text}
            </p>
          ) : null}

          {showHistory ? (
            data.items.length === 0 ? (
              <p className="mt-3 text-xs text-ink-3">Nothing has been sent yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {data.items.map((item) => (
                  <li key={item.id} className="rounded-xl border border-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-xs text-ink">
                        {item.severity === "high" ? (
                          <span className="mr-1 text-amber-600">&#9679;</span>
                        ) : null}
                        {item.title}
                      </p>
                      <span className="shrink-0 text-[10px] text-ink-3">
                        {formatWhen(item.created_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-ink-3">
                      {item.kind}
                      {" \u00b7 "}
                      {EMAIL_STATUS_LABEL[item.email_status] ?? item.email_status}
                      {item.email_to ? " (" + item.email_to + ")" : ""}
                      {item.email_error ? " \u2014 " + item.email_error : ""}
                      {item.conversation_id ? (
                        <>
                          {" \u00b7 "}
                          <a
                            href={"/dashboard/conversations/" + item.conversation_id}
                            className="text-brand hover:underline"
                          >
                            open chat
                          </a>
                        </>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
