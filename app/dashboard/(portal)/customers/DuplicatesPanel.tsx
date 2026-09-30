"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface IdentitySuggestion {
  contact_a: string;
  name_a: string;
  contact_b: string;
  name_b: string;
  reason: "same_phone" | "same_name";
  confidence: number;
}

interface DuplicatesPayload {
  suggestions: IdentitySuggestion[];
  scanned: number;
  linked_identities: number;
  total: number;
}

const REASON_LABELS: Record<IdentitySuggestion["reason"], string> = {
  same_phone: "Same phone number",
  same_name: "Same name",
};

function profileHref(contact: string): string {
  return "/dashboard/customers/profile?contact=" + encodeURIComponent(contact);
}

function pairKey(suggestion: IdentitySuggestion): string {
  return suggestion.contact_a + "|" + suggestion.contact_b;
}

/**
 * Customers -> "Possible duplicates": workspace-wide review of contacts
 * that look like the same person (same phone behind two ids, same name).
 * "Link" joins them into one identity (soft, reversible from the profile);
 * "Not the same" hides the pair for good. Neither moves conversations -
 * the hard merge on each customer row still does that.
 */
export default function DuplicatesPanel({ onLinked }: { onLinked?: () => void }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<DuplicatesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/identity/duplicates?limit=50",
        { cache: "no-store" }
      );
      if (response.ok) {
        setPayload((await response.json()) as DuplicatesPayload);
      } else {
        setNotice("Duplicate review is unavailable right now. Try again shortly.");
      }
    } catch {
      setNotice("Duplicate review is unavailable right now. Try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && payload === null && !loading) void load();
  }, [open, payload, loading, load]);

  async function act(
    suggestion: IdentitySuggestion,
    path: "merge" | "dismiss"
  ) {
    const key = pairKey(suggestion);
    setBusyKey(key);
    setNotice("");
    try {
      const response = await fetch("/api/omniflow/portal/identity/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          path === "merge"
            ? { keep: suggestion.contact_a, merge: suggestion.contact_b }
            : { contact_a: suggestion.contact_a, contact_b: suggestion.contact_b }
        ),
      });
      if (response.ok) {
        setPayload((current) =>
          current
            ? {
                ...current,
                suggestions: current.suggestions.filter(
                  (entry) => pairKey(entry) !== key
                ),
                total: Math.max(0, current.total - 1),
                linked_identities:
                  current.linked_identities + (path === "merge" ? 1 : 0),
              }
            : current
        );
        if (path === "merge") onLinked?.();
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setNotice(
        body?.error?.message ??
          (path === "merge"
            ? "Those contacts could not be linked."
            : "That pair could not be dismissed.")
      );
    } catch {
      setNotice("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusyKey("");
    }
  }

  const suggestions = payload?.suggestions ?? [];

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white shadow-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="text-xs font-semibold text-ink">Possible duplicates</span>
          <span className="mt-0.5 block text-[11px] text-ink-3">
            Contacts that look like the same person across numbers and channels.
            Linking is reversible and never moves conversations.
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-ink-3">
          {payload
            ? payload.total + " to review"
            : open
              ? "Loading\u2026"
              : "Review"}
          {" "}
          <span aria-hidden="true">{open ? "\u25bd" : "\u25b7"}</span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-line px-4 py-3">
          {loading && !payload ? (
            <p className="text-xs text-ink-3">Scanning contacts&#8230;</p>
          ) : suggestions.length === 0 ? (
            <p className="text-xs text-ink-3">
              {payload
                ? "No duplicates found across " +
                  payload.scanned +
                  " contacts" +
                  (payload.linked_identities > 0
                    ? " (" + payload.linked_identities + " already linked)."
                    : ".")
                : "Nothing to review yet."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {suggestions.map((suggestion) => {
                const key = pairKey(suggestion);
                return (
                  <li
                    key={key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white shadow-card px-3 py-2 text-xs"
                  >
                    <span className="min-w-0 text-ink-2">
                      <Link
                        href={profileHref(suggestion.contact_a)}
                        className="text-brand hover:underline"
                      >
                        {suggestion.name_a || suggestion.contact_a}
                      </Link>
                      <span className="text-ink-3">{" \u21c4 "}</span>
                      <Link
                        href={profileHref(suggestion.contact_b)}
                        className="text-brand hover:underline"
                      >
                        {suggestion.name_b || suggestion.contact_b}
                      </Link>
                      <span className="block text-[10px] text-ink-3">
                        {REASON_LABELS[suggestion.reason] +
                          " \u00b7 " +
                          Math.round(suggestion.confidence * 100) +
                          "% confidence \u00b7 " +
                          suggestion.contact_a +
                          " / " +
                          suggestion.contact_b}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-2 text-[10px]">
                      <button
                        type="button"
                        onClick={() => void act(suggestion, "merge")}
                        disabled={busyKey !== ""}
                        className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-1 text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
                      >
                        Link as same person
                      </button>
                      <button
                        type="button"
                        onClick={() => void act(suggestion, "dismiss")}
                        disabled={busyKey !== ""}
                        className="rounded-lg border border-line px-2 py-1 text-ink-3 hover:text-ink disabled:opacity-40"
                      >
                        Not the same
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            {notice ? <p className="text-xs text-danger">{notice}</p> : <span />}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="text-[10px] text-ink-3 hover:underline disabled:opacity-40"
            >
              Rescan
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
