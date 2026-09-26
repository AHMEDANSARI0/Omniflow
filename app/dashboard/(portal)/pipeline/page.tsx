"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface PipelineContact {
  contactId: string;
  name: string;
  leadTemp: string;
  chats: number;
  lastAt: string | null;
}

interface Column {
  stage: string;
  count: number;
  contacts: PipelineContact[];
}

const STAGES = [
  { value: "new", label: "New", dot: "bg-slate-400", text: "text-ink-2" },
  {
    value: "interested",
    label: "Interested",
    dot: "bg-cyan-400",
    text: "text-brand",
  },
  {
    value: "negotiating",
    label: "Negotiating",
    dot: "bg-amber-400",
    text: "text-amber-600",
  },
  { value: "won", label: "Won", dot: "bg-emerald-400", text: "text-ok" },
  { value: "lost", label: "Lost", dot: "bg-rose-400", text: "text-danger" },
];

const EMPTY_BOARD: Column[] = STAGES.map((stage) => ({
  stage: stage.value,
  count: 0,
  contacts: [],
}));

function stageLabel(stage: string): string {
  return STAGES.find((item) => item.value === stage)?.label ?? stage;
}

export default function PipelinePage() {
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/pipeline", {
        cache: "no-store",
      });
      if (!response.ok) {
        setColumns(null);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      const stages =
        payload !== null && typeof payload === "object"
          ? (payload as Record<string, unknown>).stages
          : null;
      if (!Array.isArray(stages)) {
        setColumns(null);
        return;
      }
      const byStage = new Map<string, Column>();
      for (const item of stages) {
        if (item === null || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (typeof row.stage !== "string") continue;
        const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];
        const contacts: PipelineContact[] = [];
        for (const entry of rawContacts) {
          if (entry === null || typeof entry !== "object") continue;
          const contact = entry as Record<string, unknown>;
          if (typeof contact.contact_id !== "string") continue;
          contacts.push({
            contactId: contact.contact_id,
            name: typeof contact.name === "string" ? contact.name : "",
            leadTemp: typeof contact.lead_temp === "string" ? contact.lead_temp : "cold",
            chats: typeof contact.chats === "number" ? contact.chats : 0,
            lastAt: typeof contact.last_at === "string" ? contact.last_at : null,
          });
        }
        byStage.set(row.stage, {
          stage: row.stage,
          count: typeof row.count === "number" ? row.count : contacts.length,
          contacts,
        });
      }
      setColumns(
        STAGES.map((stage) => byStage.get(stage.value) ?? {
          stage: stage.value,
          count: 0,
          contacts: [],
        })
      );
    } catch {
      setColumns(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(contactId: string, stage: string) {
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/pipeline/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: contactId, stage }),
      });
      if (!response.ok) {
        setNote("Could not move that contact. Try again.");
        return;
      }
      await load();
    } catch {
      setNote("Could not move that contact. Try again.");
    }
  }

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink">Pipeline</h1>
            <p className="mt-0.5 text-xs text-ink-3">
              Move customers through New, Interested, Negotiating, Won or Lost.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:bg-soft hover:text-ink"
          >
            Refresh
          </button>
        </div>

        {note ? (
          <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-200">
            {note}
          </p>
        ) : null}

        {columns === null ? (
          <p className="mt-6 text-sm text-ink-3">
            Pipeline is not available right now.
          </p>
        ) : (
          <div className="mt-4 flex gap-3 overflow-x-auto pb-4">
            {columns.map((column) => {
              const meta =
                STAGES.find((item) => item.value === column.stage) ??
                STAGES[0];
              return (
                <section
                  key={column.stage}
                  className="flex w-60 shrink-0 flex-col rounded-2xl border border-line bg-soft"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
                    <span className="flex items-center gap-2 text-xs font-semibold text-ink">
                      <span
                        className={"h-1.5 w-1.5 rounded-full " + meta.dot}
                      />
                      {meta.label}
                    </span>
                    <span
                      className={
                        "rounded-md border border-line px-1.5 py-0.5 text-[10px] " +
                        meta.text
                      }
                    >
                      {column.count}
                    </span>
                  </div>
                  {column.contacts.length === 0 ? (
                    <p className="px-3 py-4 text-[11px] text-ink-3">
                      No contacts here yet.
                    </p>
                  ) : (
                    <ul className="space-y-1.5 p-2">
                      {column.contacts.map((contact) => (
                        <li
                          key={contact.contactId}
                          className="rounded-xl border border-line bg-white/[0.01] p-2"
                        >
                          <Link
                            prefetch={false}
                            href={
                              "/dashboard/customers/profile?contact=" +
                              encodeURIComponent(contact.contactId)
                            }
                            className="block truncate text-xs font-medium text-ink transition hover:text-brand"
                          >
                            {contact.name || contact.contactId}
                          </Link>
                          <p className="mt-0.5 text-[10px] text-ink-3">
                            {contact.chats} chat{contact.chats === 1 ? "" : "s"}
                            {" \\u00b7 "}{contact.leadTemp} lead
                          </p>
                          <select
                            value={column.stage}
                            onChange={(event) =>
                              void move(contact.contactId, event.target.value)
                            }
                            className="mt-1.5 w-full rounded-lg border border-line bg-white px-1.5 py-1 text-[10px] text-ink-2 outline-none"
                          >
                            {STAGES.map((stage) => (
                              <option key={stage.value} value={stage.value}>
                                {stageLabel(stage.value)}
                              </option>
                            ))}
                          </select>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
