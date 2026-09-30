"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface IdentityHandle {
  id: number;
  identity_id: number;
  channel: string;
  handle: string;
  raw_handle: string;
  confidence: number;
  source: string;
  created_at: string | null;
}

interface IdentitySuggestion {
  contact_a: string;
  name_a: string;
  contact_b: string;
  name_b: string;
  reason: "same_phone" | "same_name";
  confidence: number;
}

interface CustomerIdentity {
  id: number;
  display_name: string;
  primary_contact: string;
  status: string;
  handles: IdentityHandle[];
  contacts: string[];
  linked: { contact_id: string; name: string }[];
}

interface IdentityPayload {
  identity: CustomerIdentity;
  suggestions: IdentitySuggestion[];
  channels: string[];
  limits: { max_handles: number };
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  phone: "Phone",
  email: "Email",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  web: "Web visitor",
  other: "Other",
};

const REASON_LABELS: Record<IdentitySuggestion["reason"], string> = {
  same_phone: "Same phone number",
  same_name: "Same name",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function profileHref(contact: string): string {
  return "/dashboard/customers/profile?contact=" + encodeURIComponent(contact);
}

/**
 * Customer 360 -> identity: every handle this person is known by across
 * channels (WhatsApp ids, phone, email, social usernames), the other
 * contacts linked to the same person, and duplicate hints. Linking is
 * soft and reversible (Unlink) - conversations are never moved.
 */
export default function CustomerIdentityCard({ contact }: { contact: string }) {
  const [payload, setPayload] = useState<IdentityPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [channel, setChannel] = useState("phone");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<{ contact: string; message: string } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!contact) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/identity?contact=" + encodeURIComponent(contact),
        { cache: "no-store" }
      );
      if (response.ok) {
        setPayload((await response.json()) as IdentityPayload);
      }
      setLoaded(true);
    } catch {
      /* keep the last known state */
    }
  }, [contact]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(input: string, init?: RequestInit): Promise<Response | null> {
    setBusy(true);
    setNotice("");
    try {
      return await fetch(input, init);
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addHandle() {
    const handle = draft.trim();
    if (!handle) return;
    setConflict(null);
    const response = await call("/api/omniflow/portal/identity/handles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, channel, handle }),
    });
    if (!response) {
      setNotice("Could not reach the workspace. Try again shortly.");
      return;
    }
    if (response.ok) {
      setDraft("");
      await load();
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
      other_contact?: string;
    } | null;
    if (response.status === 409 && body?.error?.code === "identity_conflict") {
      setConflict({
        contact: body.other_contact ?? "",
        message: body.error.message ?? "That handle belongs to another customer.",
      });
      return;
    }
    setNotice(body?.error?.message ?? "That handle could not be added.");
  }

  async function removeHandle(id: number) {
    const response = await call("/api/omniflow/portal/identity/handles/" + id, {
      method: "DELETE",
    });
    if (response?.ok) {
      await load();
      return;
    }
    const body = (await response?.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    setNotice(body?.error?.message ?? "That handle could not be removed.");
  }

  async function link(other: string) {
    if (!other) return;
    const response = await call("/api/omniflow/portal/identity/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: contact, merge: other }),
    });
    if (response?.ok) {
      setConflict(null);
      setDraft("");
      await load();
      return;
    }
    const body = (await response?.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    setNotice(body?.error?.message ?? "Those contacts could not be linked.");
  }

  async function unlink(other: string) {
    if (
      !window.confirm(
        "Unlink this contact? Its conversations stay where they are; only the shared identity is separated."
      )
    ) {
      return;
    }
    const response = await call("/api/omniflow/portal/identity/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact: other }),
    });
    if (response?.ok) {
      await load();
      return;
    }
    const body = (await response?.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    setNotice(body?.error?.message ?? "That contact could not be unlinked.");
  }

  async function dismiss(suggestion: IdentitySuggestion) {
    const response = await call("/api/omniflow/portal/identity/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_a: suggestion.contact_a,
        contact_b: suggestion.contact_b,
      }),
    });
    if (response?.ok) await load();
  }

  const identity = payload?.identity ?? null;
  const channels = payload?.channels ?? ["phone", "email"];
  const maxHandles = payload?.limits?.max_handles ?? 0;
  const atCap = identity ? maxHandles > 0 && identity.handles.length >= maxHandles : false;
  const linked = identity?.linked ?? [];
  const suggestions = payload?.suggestions ?? [];

  return (
    <section className="mt-4 rounded-2xl border border-line bg-white shadow-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-ink">Identity</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Every handle this person is known by across channels. Linking is
            reversible and never moves conversations.
          </p>
        </div>
        {identity ? (
          <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-3">
            {linked.length > 0
              ? linked.length + 1 + " contacts linked"
              : "Single contact"}
          </span>
        ) : null}
      </div>

      {!loaded ? (
        <p className="mt-2 text-xs text-ink-3">Loading&#8230;</p>
      ) : !identity ? (
        <p className="mt-2 text-xs text-ink-3">
          Identity details are unavailable right now. Try again shortly.
        </p>
      ) : (
        <>
          {identity.handles.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {identity.handles.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-start justify-between gap-2 rounded-xl border border-line bg-white shadow-card px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-ink-2">
                      <span className="text-ink-3">{channelLabel(entry.channel)}</span>
                      {" \u00b7 "}
                      {entry.handle}
                    </p>
                    <p className="mt-0.5 text-[10px] text-ink-3">
                      {[
                        entry.source !== "system" ? "added by " + entry.source : null,
                        typeof entry.confidence === "number" && entry.confidence < 1
                          ? Math.round(entry.confidence * 100) + "% confidence"
                          : null,
                        entry.raw_handle && entry.raw_handle !== entry.handle
                          ? "from " + entry.raw_handle
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" \u00b7 ")}
                    </p>
                  </div>
                  {entry.channel !== "whatsapp" ? (
                    <button
                      onClick={() => void removeHandle(entry.id)}
                      disabled={busy}
                      className="shrink-0 text-[10px] text-ink-3 hover:underline disabled:opacity-40"
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {linked.length > 0 ? (
            <div className="mt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Linked contacts
              </p>
              <ul className="mt-1 space-y-1">
                {linked.map((entry) => (
                  <li
                    key={entry.contact_id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <Link
                      href={profileHref(entry.contact_id)}
                      className="truncate text-brand hover:underline"
                    >
                      {entry.name || entry.contact_id}
                    </Link>
                    <button
                      onClick={() => void unlink(entry.contact_id)}
                      disabled={busy}
                      className="shrink-0 text-[10px] text-ink-3 hover:underline disabled:opacity-40"
                    >
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Possibly the same person
              </p>
              <ul className="mt-1 space-y-1">
                {suggestions.map((suggestion) => {
                  const other =
                    suggestion.contact_a === contact
                      ? { id: suggestion.contact_b, name: suggestion.name_b }
                      : { id: suggestion.contact_a, name: suggestion.name_a };
                  return (
                    <li
                      key={suggestion.contact_a + "|" + suggestion.contact_b}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-ink-2">
                        <Link
                          href={profileHref(other.id)}
                          className="text-brand hover:underline"
                        >
                          {other.name || other.id}
                        </Link>
                        <span className="text-ink-3">
                          {" \u00b7 " +
                            REASON_LABELS[suggestion.reason] +
                            " \u00b7 " +
                            Math.round(suggestion.confidence * 100) +
                            "% confidence"}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-2 text-[10px]">
                        <button
                          onClick={() => void link(other.id)}
                          disabled={busy}
                          className="text-ok hover:underline disabled:opacity-40"
                        >
                          Link as same person
                        </button>
                        <button
                          onClick={() => void dismiss(suggestion)}
                          disabled={busy}
                          className="text-ink-3 hover:underline disabled:opacity-40"
                        >
                          Not the same person
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <select
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              className="rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink-2 outline-none"
            >
              {channels.map((option) => (
                <option key={option} value={option} className="bg-white">
                  {channelLabel(option)}
                </option>
              ))}
            </select>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                channel === "email"
                  ? "name@example.com"
                  : channel === "phone"
                    ? "+92 300 1234567"
                    : "username or id"
              }
              className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <button
              onClick={() => void addHandle()}
              disabled={busy || atCap || !draft.trim()}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Add handle
            </button>
          </div>
          {atCap ? (
            <p className="mt-1 text-[10px] text-ink-3">
              This customer already has the maximum of {maxHandles} handles.
            </p>
          ) : null}

          {conflict ? (
            <div className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-xs text-ink-2">
              <p>{conflict.message}</p>
              {conflict.contact ? (
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  <Link
                    href={profileHref(conflict.contact)}
                    className="text-brand hover:underline"
                  >
                    Open {conflict.contact}
                  </Link>
                  <button
                    onClick={() => void link(conflict.contact)}
                    disabled={busy}
                    className="text-ok hover:underline disabled:opacity-40"
                  >
                    Link as same person
                  </button>
                  <button
                    onClick={() => setConflict(null)}
                    className="text-ink-3 hover:underline"
                  >
                    Cancel
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}

          {notice ? <p className="mt-2 text-xs text-danger">{notice}</p> : null}
        </>
      )}
    </section>
  );
}
