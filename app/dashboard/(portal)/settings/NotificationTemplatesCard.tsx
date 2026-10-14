"use client";

import { useEffect, useState } from "react";

import type { NotifyTemplate, NotifyTemplatesView } from "../../../../lib/omniflow/portal";

const BASE = "/api/omniflow/portal/notifications/templates";

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand/[0.12] disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line px-3 py-2 text-xs text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-50";

async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: T | null; message: string }> {
  try {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    return {
      ok: response.ok,
      data: response.ok ? data : null,
      message: data?.error?.message ?? "That did not work. Try again shortly.",
    };
  } catch {
    return { ok: false, data: null, message: "Could not reach the workspace. Try again shortly." };
  }
}

/**
 * §239 Settings -> Email templates: one subject + body per notification
 * kind, with variables. Blank = the built-in email. Preview renders sample
 * values on the Control Plane; "Send a test" sends this kind for real.
 */
export default function NotificationTemplatesCard() {
  const [view, setView] = useState<NotifyTemplatesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState("escalation");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  function pick(next: NotifyTemplatesView, key: string) {
    const item = next.templates.find((t) => t.kind === key) ?? next.templates[0];
    if (!item) return;
    setKind(item.kind);
    setSubject(item.subject);
    setBody(item.body);
    setPreview(null);
  }

  useEffect(() => {
    void (async () => {
      const result = await call<NotifyTemplatesView>(BASE, "GET");
      if (!result.data) {
        setFailed(true);
        return;
      }
      setView(result.data);
      pick(result.data, "escalation");
    })();
  }, []);

  async function run(action: "preview" | "save" | "reset" | "test") {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    if (action === "preview") {
      const result = await call<{ subject: string; body: string }>(BASE + "/preview", "POST", {
        kind,
        subject: subject || view.defaults.subject,
        body: body || view.defaults.body,
      });
      if (result.data) setPreview(result.data);
      else setNotice({ ok: false, text: result.message });
    } else if (action === "test") {
      const result = await call<{ result: { email: string; error: string } }>(
        "/api/omniflow/portal/notifications/test",
        "POST",
        { kind }
      );
      const email = result.data?.result.email ?? "";
      setNotice(
        result.data
          ? {
              ok: email !== "failed",
              text:
                email === "sent"
                  ? "Test email sent with this template."
                  : email === "failed"
                    ? "Test email failed: " + (result.data.result.error || "delivery error")
                    : "Bell alert sent; email is " + (email || "off") + " for this kind.",
            }
          : { ok: false, text: result.message }
      );
    } else {
      const result =
        action === "save"
          ? await call<NotifyTemplatesView>(BASE + "/" + kind, "PUT", { subject, body })
          : await call<NotifyTemplatesView>(BASE + "/" + kind, "DELETE");
      if (result.data) {
        setView(result.data);
        pick(result.data, kind);
        setNotice({ ok: true, text: action === "save" ? "Template saved." : "Back to the built-in email." });
      } else {
        setNotice({ ok: false, text: result.message });
      }
    }
    setBusy(false);
  }

  const current: NotifyTemplate | undefined = view?.templates.find((t) => t.kind === kind);
  const locked = !view?.canEdit || busy;

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-5">
      <h2 className="text-sm font-semibold text-ink">Email templates</h2>
      <p className="mt-1 text-xs text-ink-3">
        Change the subject and wording of notification emails per kind. Leave a kind blank to use the built-in email.
      </p>
      {failed ? (
        <p className="mt-3 text-xs text-ink-3">Email templates are unavailable right now. Try again shortly.</p>
      ) : !view ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3">
            <select
              value={kind}
              onChange={(event) => pick(view, event.target.value)}
              className={inputClass}
              aria-label="Notification kind"
            >
              {view.templates.map((item) => (
                <option key={item.kind} value={item.kind}>
                  {item.label + (item.custom ? " (custom)" : "")}
                </option>
              ))}
            </select>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={view.defaults.subject}
              maxLength={view.subjectMax}
              disabled={locked}
              className={inputClass}
              aria-label="Subject"
            />
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={view.defaults.body}
              maxLength={view.bodyMax}
              rows={6}
              disabled={locked}
              className={inputClass + " font-mono text-xs"}
              aria-label="Body"
            />
            <ul className="flex flex-wrap gap-1.5">
              {view.variables.map((variable) => (
                <li
                  key={variable.key}
                  title={variable.description}
                  className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-2"
                >
                  {"{" + variable.key + "}"}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!subject && !body ? (
              <button
                type="button"
                onClick={() => {
                  setSubject(view.defaults.subject);
                  setBody(view.defaults.body);
                }}
                disabled={locked}
                className={ghostBtn}
              >
                Start from the built-in email
              </button>
            ) : null}
            <button type="button" onClick={() => void run("preview")} disabled={busy} className={ghostBtn}>
              Preview
            </button>
            <button type="button" onClick={() => void run("save")} disabled={locked} className={primaryBtn}>
              {busy ? "Working\u2026" : "Save"}
            </button>
            {current?.custom ? (
              <button type="button" onClick={() => void run("reset")} disabled={locked} className={ghostBtn}>
                Reset to built-in
              </button>
            ) : null}
            <button type="button" onClick={() => void run("test")} disabled={busy} className={ghostBtn}>
              Send a test
            </button>
          </div>
          {!view.canEdit ? (
            <p className="mt-2 text-[11px] text-ink-3">Only owners and admins can change email templates.</p>
          ) : null}
          {notice ? (
            <p className={"mt-3 text-xs " + (notice.ok ? "text-ok" : "text-danger")}>{notice.text}</p>
          ) : null}
          {preview ? (
            <div className="mt-3 rounded-xl border border-line bg-soft p-3">
              <p className="text-xs font-medium text-ink">{preview.subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-xs text-ink-2">{preview.body}</p>
              <p className="mt-2 text-[10px] text-ink-3">Sample values - nothing was sent.</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
