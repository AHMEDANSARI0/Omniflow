"use client";

import { useCallback, useEffect, useState } from "react";

type FactKind = "policy" | "sop" | "pricing" | "refund" | "escalation" | "hours";

const KINDS: { value: FactKind; label: string }[] = [
  { value: "policy", label: "Policy" },
  { value: "sop", label: "SOP / Process" },
  { value: "pricing", label: "Pricing" },
  { value: "refund", label: "Refund rule" },
  { value: "escalation", label: "Escalation" },
  { value: "hours", label: "Working hours" },
];

interface Fact {
  id: number;
  kind: FactKind;
  label: string;
  content: string;
  keywords: string;
  isActive: boolean;
  updatedAt: string;
}

const EMPTY_FORM = {
  id: 0,
  kind: "policy" as FactKind,
  label: "",
  content: "",
  keywords: "",
};

/**
 * Configure AI -> Business facts (Brain v2). Structured rules the AI
 * answers from — policies, SOPs, pricing, refund and escalation rules,
 * working hours — stored as queryable data instead of one giant prompt.
 * Identity basics (name, address, phone) stay in Business profile.
 */
export default function FactsCard() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/brain/facts", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as { facts?: Fact[] };
        setFacts(payload.facts ?? []);
        setLoaded(true);
      } else {
        setNote("Could not load business facts.");
      }
    } catch {
      setNote("Could not load business facts.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!form.label.trim() || !form.content.trim()) {
      setNote("A label and the rule text are both required.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/brain/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: form.id,
          kind: form.kind,
          label: form.label,
          content: form.content,
          keywords: form.keywords,
          is_active: true,
        }),
      });
      if (response.ok) {
        setNote(form.id > 0 ? "Fact updated." : "Fact added.");
        setForm({ ...EMPTY_FORM });
        await load();
      } else {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setNote(payload?.error?.message ?? "Could not save. Try again shortly.");
      }
    } catch {
      setNote("Could not save. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: number) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/brain/facts?id=" + encodeURIComponent(String(id)),
        { method: "DELETE" }
      );
      if (response.ok) {
        setNote("Fact archived. The AI no longer uses it.");
        await load();
      } else {
        setNote("Could not archive. Try again shortly.");
      }
    } catch {
      setNote("Could not archive. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(fact: Fact) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/brain/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fact.id,
          kind: fact.kind,
          label: fact.label,
          content: fact.content,
          keywords: fact.keywords,
          is_active: true,
        }),
      });
      if (response.ok) {
        setNote("Fact is active again.");
        await load();
      } else {
        setNote("Could not re-activate. Try again shortly.");
      }
    } catch {
      setNote("Could not re-activate. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  const activeCount = facts.filter((fact) => fact.isActive).length;

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Business facts</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            The rules the AI answers from — policies, SOPs, pricing, refund
            and escalation rules, working hours. Stored as structured data
            (not one giant prompt), matched per customer message. Identity
            basics stay in Business profile.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-line inline-flex min-h-8 items-center px-2.5 py-1 text-[11px] text-ink-2 hover:bg-line/60 disabled:opacity-50"
        >
          {busy ? "Loading..." : "Refresh"}
        </button>
      </div>

      {loaded ? (
        <>
          <p className="mt-2 text-[11px] text-ink-3">
            {activeCount} active {activeCount === 1 ? "fact" : "facts"}
            {facts.length - activeCount > 0
              ? ` · ${facts.length - activeCount} archived`
              : ""}
          </p>

          <div className="mt-2 space-y-2">
            {facts.map((fact) => (
              <div
                key={fact.id}
                className={
                  "rounded-xl border px-3 py-2 " +
                  (fact.isActive
                    ? "border-line"
                    : "border-line opacity-60")
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-3">
                    {KINDS.find((k) => k.value === fact.kind)?.label ??
                      fact.kind}
                  </span>
                  <span className="text-xs font-semibold text-ink">
                    {fact.label}
                  </span>
                  <span
                    className={
                      "ml-auto text-[10px] " +
                      (fact.isActive ? "text-ok" : "text-ink-3")
                    }
                  >
                    {fact.isActive ? "Active" : "Archived"}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[11px] text-ink-2">
                  {fact.content.length > 220
                    ? fact.content.slice(0, 220) + "…"
                    : fact.content}
                </p>
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() =>
                      setForm({
                        id: fact.id,
                        kind: fact.kind,
                        label: fact.label,
                        content: fact.content,
                        keywords: fact.keywords,
                      })
                    }
                    disabled={busy}
                    className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-line/60 disabled:opacity-50"
                  >
                    Edit
                  </button>
                  {fact.isActive ? (
                    <button
                      onClick={() => void archive(fact.id)}
                      disabled={busy}
                      className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-line/60 disabled:opacity-50"
                    >
                      Archive
                    </button>
                  ) : (
                    <button
                      onClick={() => void reactivate(fact)}
                      disabled={busy}
                      className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-line/60 disabled:opacity-50"
                    >
                      Re-activate
                    </button>
                  )}
                  {form.id === fact.id ? (
                    <span className="self-center text-[10px] text-ink-3">
                      editing…
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            {facts.length === 0 ? (
              <p className="text-xs text-ink-3">
                No facts yet. Add the rules you want the AI to follow — for
                example your refund window, delivery areas, or exchange
                process.
              </p>
            ) : null}
          </div>

          <div className="mt-3 space-y-2 rounded-xl border border-line p-3">
            <p className="text-[11px] font-semibold text-ink-2">
              {form.id > 0 ? "Edit fact" : "Add a fact"}
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={form.kind}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value as FactKind })
                }
                className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/50"
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <input
                value={form.label}
                onChange={(event) =>
                  setForm({ ...form, label: event.target.value })
                }
                placeholder="Short label, e.g. Refund window"
                maxLength={120}
                className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-brand/50"
              />
            </div>
            <textarea
              value={form.content}
              onChange={(event) =>
                setForm({ ...form, content: event.target.value })
              }
              placeholder="The rule itself, e.g. Refunds within 7 days of delivery if the product is unused."
              maxLength={2000}
              rows={3}
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-brand/50"
            />
            <input
              value={form.keywords}
              onChange={(event) =>
                setForm({ ...form, keywords: event.target.value })
              }
              placeholder="Match words (optional), e.g. refund, wapas, return"
              maxLength={200}
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-brand/50"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy}
                className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
              >
                {form.id > 0 ? "Save changes" : "Add fact"}
              </button>
              {form.id > 0 ? (
                <button
                  onClick={() => setForm({ ...EMPTY_FORM })}
                  disabled={busy}
                  className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 hover:bg-line/60 disabled:opacity-50"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </div>

          {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-3">Loading…</p>
      )}
    </section>
  );
}
