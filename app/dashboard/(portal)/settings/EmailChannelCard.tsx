"use client";

/** §243 Email channel: a workspace mailbox (IMAP in, SMTP out) answered from the same inbox. */
import { useCallback, useEffect, useState } from "react";
import type { EmailChannelRun, EmailChannelState } from "../../../../lib/omniflow/portal";

const API = "/api/omniflow/portal/channels/email";
const INPUT =
  "w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40 disabled:opacity-60";

type Form = {
  address: string;
  display_name: string;
  username: string;
  password: string;
  imap_host: string;
  imap_port: string;
  smtp_host: string;
  smtp_port: string;
  enabled: boolean;
};

const EMPTY: Form = {
  address: "",
  display_name: "",
  username: "",
  password: "",
  imap_host: "",
  imap_port: "993",
  smtp_host: "",
  smtp_port: "465",
  enabled: false,
};

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

function formOf(state: EmailChannelState): Form {
  return {
    address: state.address,
    display_name: state.display_name,
    username: state.username === state.address ? "" : state.username,
    password: "",
    imap_host: state.imap_host,
    imap_port: String(state.imap_port),
    smtp_host: state.smtp_host,
    smtp_port: String(state.smtp_port),
    enabled: state.enabled,
  };
}

export default function EmailChannelCard() {
  const [state, setState] = useState<EmailChannelState | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "sync">("");
  const [note, setNote] = useState("");

  const apply = useCallback((next: EmailChannelState) => {
    setState(next);
    setForm(formOf(next));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
      const payload = await readJson(response);
      if (response.ok && payload && typeof payload.address === "string") apply(payload as unknown as EmailChannelState);
      else setNote(errorText(payload, "Could not load the email channel right now."));
    } catch {
      setNote("Could not load the email channel right now.");
    } finally {
      setLoaded(true);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function call(kind: "save" | "test" | "sync") {
    setBusy(kind);
    setNote("");
    try {
      const response =
        kind === "save"
          ? await fetch(API, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({
                ...form,
                imap_port: Number(form.imap_port),
                smtp_port: Number(form.smtp_port),
              }),
            })
          : await fetch(API + "/" + kind, { method: "POST", credentials: "same-origin" });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setNote(errorText(payload, "Could not reach the email channel right now. Try again shortly."));
        if (kind === "test") await load();
        return;
      }
      if (kind === "sync") {
        const run = payload as unknown as EmailChannelRun;
        setNote(
          run.error ||
            "Imported " + run.imported + " new email" + (run.imported === 1 ? "" : "s") + ", sent " + run.sent +
              " repl" + (run.sent === 1 ? "y" : "ies") + (run.failed ? ", " + run.failed + " will retry" : "") + "."
        );
        await load();
        return;
      }
      apply(payload as unknown as EmailChannelState);
      const next = payload as unknown as EmailChannelState;
      setNote(
        kind === "test"
          ? "Connected. New email will appear in the inbox; replies go out from " + next.address + "."
          : next.verified
            ? "Saved."
            : "Saved. Run Test connection to turn the channel on."
      );
    } catch {
      setNote("Could not reach the email channel right now. Try again shortly.");
    } finally {
      setBusy("");
    }
  }

  const canEdit = state?.can_edit === true;
  const connected = state?.enabled === true && state.verified;

  return (
    <div className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Email channel <span className="ml-1 text-[11px] font-normal text-brand">Early access</span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Customer emails arrive in the inbox like any chat, and replies (yours, approved drafts and AI answers under
            your autonomy settings) go back from this mailbox in the same email thread. Only email that arrives after
            connecting is imported. OmniFlow opens the mailbox read-only, so messages stay unread in your mail app;
            newsletters, bounces and auto-replies are skipped.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          disabled={!canEdit || !state?.verified}
          title={state?.verified ? undefined : "Run Test connection first"}
          onClick={() => set("enabled", !form.enabled)}
          className={
            "rounded-lg border inline-flex min-h-8 items-center px-2.5 py-1 text-[11px] disabled:opacity-60 " +
            (form.enabled ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
          }
        >
          {form.enabled ? "Channel on" : "Channel off"}
        </button>
      </div>

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading mailbox settings...</p>
      ) : state && !state.available ? (
        <p className="mt-4 text-xs text-ink-3">The email channel is turned off on this server.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-[11px] text-ink-2">
              <span className="mb-1 block">Email address</span>
              <input
                type="email"
                value={form.address}
                disabled={!canEdit}
                onChange={(event) => set("address", event.target.value)}
                placeholder="support@yourstore.pk"
                className={INPUT}
              />
            </label>
            <label className="block text-[11px] text-ink-2">
              <span className="mb-1 block">Sender name (optional)</span>
              <input
                value={form.display_name}
                maxLength={80}
                disabled={!canEdit}
                onChange={(event) => set("display_name", event.target.value)}
                placeholder="Your store name"
                className={INPUT}
              />
            </label>
            <label className="block text-[11px] text-ink-2">
              <span className="mb-1 block">Sign-in username (optional)</span>
              <input
                value={form.username}
                disabled={!canEdit}
                onChange={(event) => set("username", event.target.value)}
                placeholder="Same as the email address"
                className={INPUT}
              />
            </label>
            <label className="block text-[11px] text-ink-2">
              <span className="mb-1 block">Password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                disabled={!canEdit}
                onChange={(event) => set("password", event.target.value)}
                placeholder={state?.password_set ? "Saved - leave blank to keep" : "App password for Gmail / Outlook"}
                className={INPUT}
              />
            </label>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <label className="block text-[11px] text-ink-2">
                <span className="mb-1 block">IMAP server (incoming)</span>
                <input
                  value={form.imap_host}
                  disabled={!canEdit}
                  onChange={(event) => set("imap_host", event.target.value)}
                  placeholder="imap.yourmail.com"
                  className={INPUT}
                />
              </label>
              <label className="block text-[11px] text-ink-2">
                <span className="mb-1 block">Port</span>
                <input
                  inputMode="numeric"
                  value={form.imap_port}
                  disabled={!canEdit}
                  onChange={(event) => set("imap_port", event.target.value.replace(/\D/g, "").slice(0, 5))}
                  className={INPUT}
                />
              </label>
            </div>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <label className="block text-[11px] text-ink-2">
                <span className="mb-1 block">SMTP server (outgoing)</span>
                <input
                  value={form.smtp_host}
                  disabled={!canEdit}
                  onChange={(event) => set("smtp_host", event.target.value)}
                  placeholder="smtp.yourmail.com"
                  className={INPUT}
                />
              </label>
              <label className="block text-[11px] text-ink-2">
                <span className="mb-1 block">Port</span>
                <input
                  inputMode="numeric"
                  value={form.smtp_port}
                  disabled={!canEdit}
                  onChange={(event) => set("smtp_port", event.target.value.replace(/\D/g, "").slice(0, 5))}
                  className={INPUT}
                />
              </label>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Encrypted connections only: IMAP 993 (or STARTTLS), SMTP 465 (or STARTTLS on 587). Gmail and Outlook need
            2-step verification and an app password.
          </p>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canEdit ? (
          <>
            <button
              type="button"
              disabled={busy !== "" || !state}
              onClick={() => void call("save")}
              className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand/[0.12] disabled:opacity-50"
            >
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              disabled={busy !== "" || !state?.password_set}
              title={state?.password_set ? undefined : "Save the mailbox settings first"}
              onClick={() => void call("test")}
              className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
            >
              {busy === "test" ? "Testing..." : "Test connection"}
            </button>
          </>
        ) : state ? (
          <span className="text-[11px] text-ink-3">Only owners and admins can change the mailbox.</span>
        ) : null}
        <button
          type="button"
          disabled={busy !== "" || !connected}
          onClick={() => void call("sync")}
          className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
        >
          {busy === "sync" ? "Checking..." : "Check now"}
        </button>
        {note ? <span className="text-xs text-ink-2">{note}</span> : null}
      </div>

      {state && state.password_set ? (
        <div className="mt-4 space-y-1 text-[11px] text-ink-3">
          <p>
            <span className={connected ? "text-ok" : "text-ink-2"}>
              {connected ? "Connected" : state.verified ? "Connected, channel off" : "Not connected yet"}
            </span>
            {connected ? " \u00b7 checked about every " + Math.round(state.poll_seconds / 60) + " min while OmniFlow is in use" : ""}
          </p>
          {state.last_poll_at ? (
            <p>
              Last check: {when(state.last_poll_at)} {"\u00b7"} {state.imported_count} imported {"\u00b7"}{" "}
              {state.sent_count} sent
            </p>
          ) : null}
          {state.last_error ? <p className="text-danger">{state.last_error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
