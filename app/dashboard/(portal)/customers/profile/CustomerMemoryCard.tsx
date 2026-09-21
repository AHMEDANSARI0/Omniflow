"use client";

import { useCallback, useEffect, useState } from "react";

interface MemoryEntry {
  id: number;
  kind: "preference" | "note" | "fact";
  content: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

const KINDS: MemoryEntry["kind"][] = ["note", "preference", "fact"];

/**
 * Customer 360 -> structured memory: editable/deletable notes
 * (preference / note / fact) with a one-click "forget everything"
 * purge for data safety.
 */
export default function CustomerMemoryCard({ contact }: { contact: string }) {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<MemoryEntry["kind"]>("note");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState(0);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!contact) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/memory?contact=" + encodeURIComponent(contact),
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as { memory?: MemoryEntry[] };
        setMemory(payload.memory ?? []);
        setLoaded(true);
      }
    } catch {
      /* keep the last known state */
    }
  }, [contact]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(
    input: string,
    init?: RequestInit
  ): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(input, init);
      return response.ok;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const content = draft.trim();
    if (!content) return;
    const ok = await call("/api/omniflow/portal/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, kind, content }),
    });
    if (ok) {
      setDraft("");
      await load();
    }
  }

  async function saveEdit(id: number) {
    const content = editDraft.trim();
    if (!content) return;
    const ok = await call("/api/omniflow/portal/memory/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (ok) {
      setEditingId(0);
      await load();
    }
  }

  async function remove(id: number) {
    const ok = await call("/api/omniflow/portal/memory/" + id, {
      method: "DELETE",
    });
    if (ok) await load();
  }

  async function purge() {
    if (!window.confirm("Forget everything stored about this customer?")) {
      return;
    }
    const ok = await call(
      "/api/omniflow/portal/memory?contact=" + encodeURIComponent(contact),
      { method: "DELETE" }
    );
    if (ok) await load();
  }

  return (
    <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-white">Memory</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            What the business remembers about this customer - editable,
            deletable, purgable.
          </p>
        </div>
        {memory.length > 0 ? (
          <button
            onClick={() => void purge()}
            disabled={busy}
            className="rounded-lg border border-rose-400/20 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-400/[0.07] disabled:opacity-40"
          >
            Forget all
          </button>
        ) : null}
      </div>

      {loaded ? (
        <>
          {memory.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {memory.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  {editingId === entry.id ? (
                    <div className="flex gap-2">
                      <input
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 outline-none"
                      />
                      <button
                        onClick={() => void saveEdit(entry.id)}
                        disabled={busy}
                        className="text-[11px] text-emerald-300 hover:underline"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(0)}
                        className="text-[11px] text-slate-500 hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-300">
                          {entry.content}
                        </p>
                        <p className="mt-0.5 text-[10px] text-slate-600">
                          {entry.kind}
                          {entry.created_by !== "owner"
                            ? " \u00b7 " + entry.created_by
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2 text-[10px]">
                        <button
                          onClick={() => {
                            setEditingId(entry.id);
                            setEditDraft(entry.content);
                          }}
                          className="text-cyan-300 hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void remove(entry.id)}
                          className="text-slate-500 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              Nothing stored yet - add a preference or note the AI and
              automations should respect.
            </p>
          )}

          <div className="mt-2 flex gap-2">
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as MemoryEntry["kind"])
              }
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-xs text-slate-300 outline-none"
            >
              {KINDS.map((option) => (
                <option key={option} value={option} className="bg-[#101418]">
                  {option}
                </option>
              ))}
            </select>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="e.g. sirf evening me delivery mangta he"
              className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <button
              onClick={() => void add()}
              disabled={busy || !draft.trim()}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-slate-500">Loading&#8230;</p>
      )}
    </section>
  );
}
