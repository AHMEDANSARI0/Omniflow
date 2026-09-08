"use client";

import { useCallback, useMemo, useState } from "react";
import type { KnowledgeBaseData } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

const ghostBtn =
  "rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50";

const chipClass =
  "rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500";

interface KbFormState {
  id: number | null;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
}

const EMPTY_FORM: KbFormState = {
  id: null,
  title: "",
  category: "general",
  keywords: "",
  content: "",
  isActive: true,
};

export default function KnowledgeBaseClient({
  initial,
}: {
  initial: KnowledgeBaseData;
}) {
  const [autoReply, setAutoReply] = useState(initial.settings.autoReply);
  const [entries, setEntries] = useState(initial.entries);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<KbFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | (KnowledgeBaseData & { error?: unknown })
        | null;
      if (payload && Array.isArray(payload.entries)) {
        setEntries(payload.entries);
        setAutoReply(payload.settings?.autoReply === true);
      }
    } catch {
      // Transient network issue — the next action retries.
    }
  }, []);

  async function toggleAutoReply(next: boolean) {
    if (busy) return;
    setAutoReply(next);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ settings: { autoReply: next } }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: next
            ? "Automatic replies are on."
            : "Automatic replies are off.",
        });
      } else {
        setAutoReply(!next);
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setAutoReply(!next);
      setMessage({ kind: "error", text: "Network error — try again." });
    }
  }

  async function saveForm() {
    if (busy || !form) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setMessage({ kind: "error", text: "Title and answer are required." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        form.id === null
          ? "/api/omniflow/portal/kb"
          : "/api/omniflow/portal/kb/" + String(form.id),
        {
          method: form.id === null ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            entry: {
              title,
              category: form.category.trim() || "general",
              keywords: form.keywords.trim(),
              content,
              isActive: form.isActive,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: form.id === null ? "Entry added." : "Entry updated.",
        });
        setForm(null);
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(entryId: number) {
    if (busy) return;
    if (
      !window.confirm(
        "Delete this entry? Customers will no longer receive this answer."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/kb/" + String(entryId),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Entry deleted." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not delete. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        entry.category.toLowerCase().includes(query) ||
        entry.keywords.toLowerCase().includes(query) ||
        entry.content.toLowerCase().includes(query)
    );
  }, [entries, search]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Automatic replies
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              When a customer message matches an entry keyword, the assistant
              sends that answer instantly on WhatsApp. Fires for general,
              shipping, order-tracking and appointment questions. Complaints,
              refund requests and requests for a human are never
              auto-answered.
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleAutoReply(!autoReply)}
            aria-pressed={autoReply}
            className={"relative h-6 w-11 shrink-0 rounded-full transition-colors " +
              (autoReply ? "bg-cyan-400" : "bg-white/[0.1]")}
          >
            <span
              className={"absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all " +
                (autoReply ? "left-[22px]" : "left-0.5")}
            />
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {autoReply
            ? "Automatic replies are ON — matching entries are sent instantly."
            : "Automatic replies are OFF — entries are a reference library only until you switch them on."}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search entries..."
          className={inputClass + " sm:flex-1"}
        />
        <button
          type="button"
          onClick={() => {
            setForm({ ...EMPTY_FORM });
            setMessage(null);
          }}
          className={primaryBtn}
        >
          Add entry
        </button>
      </div>

      {message && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-xs leading-relaxed " +
            (message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/90"
              : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
          }
        >
          {message.text}
        </div>
      )}

      {form && (
        <div className="rounded-2xl border border-cyan-400/15 bg-white/[0.02] p-6">
          <h3 className="text-sm font-semibold text-white">
            {form.id === null ? "New entry" : "Edit entry"}
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="kbTitle" className={labelClass}>
                Question title
              </label>
              <input
                id="kbTitle"
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Delivery time"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="kbCategory" className={labelClass}>
                Category
              </label>
              <input
                id="kbCategory"
                type="text"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="general"
                className={inputClass}
              />
            </div>
          </div>
          <div className="mt-4">
            <label htmlFor="kbKeywords" className={labelClass}>
              Trigger keywords
            </label>
            <input
              id="kbKeywords"
              type="text"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              placeholder="delivery, delivery time, kitne din"
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              Comma separated. A customer message containing any keyword can
              receive this answer automatically.
            </p>
          </div>
          <div className="mt-4">
            <label htmlFor="kbContent" className={labelClass}>
              Answer
            </label>
            <textarea
              id="kbContent"
              rows={5}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Hi {name}! We deliver in 2-3 working days across Karachi..."
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              {"{name}"} becomes the customer&apos;s first name.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm({ ...form, isActive: e.target.checked })
                }
                className="h-4 w-4 rounded border-white/20 bg-white/[0.03]"
              />
              Active
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                className={ghostBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveForm()}
                disabled={busy}
                className={primaryBtn}
              >
                {busy ? "Saving..." : "Save entry"}
              </button>
            </div>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-slate-400">No entries yet</p>
          <p className="mt-1 text-xs text-slate-600">
            Add your first answer — delivery times, prices, policies, hours.
          </p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-xs text-slate-500">No entries match your search.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">
                      {entry.title}
                    </h3>
                    <span className={chipClass}>{entry.category}</span>
                    {!entry.isActive && (
                      <span className="rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300/80">
                        Hidden
                      </span>
                    )}
                  </div>
                  {entry.keywords && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Keywords: {entry.keywords}
                    </p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                    {entry.content}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-600">
                    Sent {entry.usageCount}{" "}
                    {entry.usageCount === 1 ? "time" : "times"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setForm({
                        id: entry.id,
                        title: entry.title,
                        category: entry.category,
                        keywords: entry.keywords,
                        content: entry.content,
                        isActive: entry.isActive,
                      });
                      setMessage(null);
                    }}
                    className={ghostBtn}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id)}
                    disabled={busy}
                    className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-red-300/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
