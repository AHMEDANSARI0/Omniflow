"use client";

import { useCallback, useEffect, useState } from "react";

interface TemplateRow {
  title: string;
  description?: string;
}

interface TemplateEntry {
  id: number | null;
  name: string;
  kind: string;
  header: string;
  body: string;
  footer: string;
  rows: TemplateRow[];
  listLabel: string;
}

const EMPTY_BUILDER: TemplateEntry = {
  id: null,
  name: "",
  kind: "buttons",
  header: "",
  body: "",
  footer: "",
  rows: [{ title: "" }],
  listLabel: "Choose one",
};

export default function InteractiveCard({
  conversationId,
}: {
  conversationId: number;
}) {
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builder, setBuilder] = useState<TemplateEntry>(EMPTY_BUILDER);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/interactive/templates",
        { cache: "no-store" }
      );
      const payload = await response.json().catch(() => null);
      if (payload && Array.isArray(payload.templates)) {
        setTemplates(payload.templates);
      }
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(templateId: number | null) {
    if (busy || templateId === null) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/interactive/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          template_id: templateId,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not send.");
        return;
      }
      setNote("Sent - it lands in the chat on the next bridge poll.");
    } catch {
      setNote("Could not send - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    if (busy) return;
    const rows = builder.rows
      .map((row) => ({
        title: row.title.trim(),
        description: (row.description || "").trim() || undefined,
      }))
      .filter((row) => row.title !== "");
    if (!builder.name.trim() || rows.length === 0 || !builder.body.trim()) {
      setNote("Name, body and at least one option are required.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/interactive/templates",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: builder.name.trim(),
            kind: builder.kind,
            header: builder.header.trim(),
            body: builder.body.trim(),
            footer: builder.footer.trim(),
            list_label:
              builder.kind === "list" ? builder.listLabel.trim() : "",
            rows,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not save.");
        return;
      }
      setBuilder(EMPTY_BUILDER);
      setShowBuilder(false);
      setNote("Template saved.");
      await load();
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(templateId: number | null) {
    if (busy || templateId === null) return;
    setBusy(true);
    setNote("");
    try {
      await fetch(
        "/api/omniflow/portal/interactive/templates/" + templateId,
        { method: "DELETE" }
      );
      await load();
    } catch {
      setNote("Could not delete - try again.");
    } finally {
      setBusy(false);
    }
  }

  const maxRows = builder.kind === "buttons" ? 3 : 10;

  return (
    <section className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-slate-200">
            Interactive message
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Send WhatsApp buttons or a list menu into this chat.
          </p>
        </div>
        <button
          onClick={() => setShowBuilder((value) => !value)}
          className="shrink-0 rounded-lg border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.06]"
        >
          {showBuilder ? "Close" : "New template"}
        </button>
      </div>

      {showBuilder ? (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={builder.name}
              onChange={(event) =>
                setBuilder({ ...builder, name: event.target.value })
              }
              placeholder="Template name"
              className="w-40 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
            />
            <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
              {["buttons", "list"].map((kind) => (
                <button
                  key={kind}
                  onClick={() => setBuilder({ ...builder, kind })}
                  className={
                    "px-2.5 py-1 text-[11px] "
                    + (builder.kind === kind
                      ? "bg-cyan-400/[0.15] text-cyan-200"
                      : "text-slate-400 hover:bg-white/[0.05]")
                  }
                >
                  {kind === "buttons" ? "Buttons (3)" : "List (10)"}
                </button>
              ))}
            </div>
          </div>
          <input
            value={builder.body}
            onChange={(event) =>
              setBuilder({ ...builder, body: event.target.value })
            }
            placeholder="Message body (required)"
            className="mt-2 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={builder.header}
              onChange={(event) =>
                setBuilder({ ...builder, header: event.target.value })
              }
              placeholder="Header (optional)"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
            />
            <input
              value={builder.footer}
              onChange={(event) =>
                setBuilder({ ...builder, footer: event.target.value })
              }
              placeholder="Footer (optional)"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
            />
          </div>
          {builder.kind === "list" ? (
            <input
              value={builder.listLabel}
              onChange={(event) =>
                setBuilder({ ...builder, listLabel: event.target.value })
              }
              placeholder="List button label"
              className="mt-2 w-48 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
            />
          ) : null}
          <div className="mt-2 space-y-1.5">
            {builder.rows.map((row, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  value={row.title}
                  onChange={(event) =>
                    setBuilder({
                      ...builder,
                      rows: builder.rows.map((entry, at) =>
                        at === index
                          ? { ...entry, title: event.target.value }
                          : entry
                      ),
                    })
                  }
                  placeholder={
                    builder.kind === "buttons"
                      ? "Button " + (index + 1) + " (max 20 chars)"
                      : "Option " + (index + 1) + " (max 24 chars)"
                  }
                  className="w-44 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                />
                {builder.kind === "list" ? (
                  <input
                    value={row.description || ""}
                    onChange={(event) =>
                      setBuilder({
                        ...builder,
                        rows: builder.rows.map((entry, at) =>
                          at === index
                            ? { ...entry, description: event.target.value }
                            : entry
                        ),
                      })
                    }
                    placeholder="Description (optional)"
                    className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                  />
                ) : null}
                <button
                  onClick={() =>
                    setBuilder({
                      ...builder,
                      rows: builder.rows.filter((_, at) => at !== index),
                    })
                  }
                  className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400 hover:bg-white/[0.06]"
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() =>
                setBuilder({
                  ...builder,
                  rows: [...builder.rows, { title: "" }],
                })
              }
              disabled={builder.rows.length >= maxRows}
              className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.06] disabled:opacity-40"
            >
              + Add option
            </button>
            <button
              onClick={() => void saveTemplate()}
              disabled={busy}
              className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.08] px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-400/[0.15] disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save template"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {!loaded ? (
          <p className="text-xs text-slate-500">Loading templates...</p>
        ) : templates.length === 0 ? (
          <p className="text-xs text-slate-500">
            No templates yet - create one to send buttons or a menu.
          </p>
        ) : (
          templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-200">
                  {template.name}
                </p>
                <p className="text-[10px] text-slate-500">
                  {template.kind === "list"
                    ? "List - " + template.rows.length + " options"
                    : "Buttons - " + template.rows.length}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void send(template.id)}
                  disabled={busy}
                  className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-50"
                >
                  {busy ? "Sending..." : "Send"}
                </button>
                <button
                  onClick={() => void removeTemplate(template.id)}
                  disabled={busy}
                  className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400 hover:bg-white/[0.06] disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {note ? <p className="mt-2 text-[11px] text-slate-400">{note}</p> : null}
    </section>
  );
}
