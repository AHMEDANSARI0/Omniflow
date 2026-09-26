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
  const [watiTemplates, setWatiTemplates] = useState<{ name: string }[]>([]);
  const [watiParams, setWatiParams] = useState<Record<string, string>>({});
  const [watiBusy, setWatiBusy] = useState(false);
  const [watiNote, setWatiNote] = useState("");
  const [cloudTemplates, setCloudTemplates] = useState<
    { name: string; language: string }[]
  >([]);
  const [cloudParams, setCloudParams] = useState<Record<string, string>>({});
  const [cloudLangs, setCloudLangs] = useState<Record<string, string>>({});
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudNote, setCloudNote] = useState("");

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
      const watiResponse = await fetch(
        "/api/omniflow/portal/wati/templates",
        { cache: "no-store" }
      );
      const watiPayload = await watiResponse.json().catch(() => null);
      if (watiPayload && Array.isArray(watiPayload.templates)) {
        setWatiTemplates(watiPayload.templates);
      }
      const cloudResponse = await fetch(
        "/api/omniflow/portal/cloud/templates",
        { cache: "no-store" }
      );
      const cloudPayload = await cloudResponse.json().catch(() => null);
      if (cloudPayload && Array.isArray(cloudPayload.templates)) {
        setCloudTemplates(cloudPayload.templates);
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

  async function sendWati(name: string) {
    if (watiBusy) return;
    setWatiBusy(true);
    setWatiNote("");
    try {
      const values = (watiParams[name] || "")
        .split("|")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      const response = await fetch("/api/omniflow/portal/wati/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          template_name: name,
          parameters: values,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setWatiNote(payload.error.message || "Could not send.");
        return;
      }
      setWatiNote("Sent - " + name + " WATI se chala gaya.");
    } catch {
      setWatiNote("Could not send - try again.");
    } finally {
      setWatiBusy(false);
    }
  }

  async function sendCloud(name: string) {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudNote("");
    try {
      const values = (cloudParams[name] || "")
        .split("|")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      const response = await fetch("/api/omniflow/portal/cloud/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          template_name: name,
          language_code: cloudLangs[name] || "en",
          parameters: values,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setCloudNote(payload.error.message || "Could not send.");
        return;
      }
      setCloudNote(
        "Queued - the connector sends it on its next poll."
      );
    } catch {
      setCloudNote("Could not send - try again.");
    } finally {
      setCloudBusy(false);
    }
  }

  const maxRows = builder.kind === "buttons" ? 3 : 10;

  return (
    <section className="mt-3 rounded-2xl border border-line bg-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-ink">
            Interactive message
          </h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Send WhatsApp buttons or a list menu into this chat.
          </p>
        </div>
        <button
          onClick={() => setShowBuilder((value) => !value)}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-white/[0.06]"
        >
          {showBuilder ? "Close" : "New template"}
        </button>
      </div>

      {showBuilder ? (
        <div className="mt-3 rounded-xl border border-line bg-soft p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={builder.name}
              onChange={(event) =>
                setBuilder({ ...builder, name: event.target.value })
              }
              placeholder="Template name"
              className="w-40 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
            />
            <div className="flex overflow-hidden rounded-lg border border-line">
              {["buttons", "list"].map((kind) => (
                <button
                  key={kind}
                  onClick={() => setBuilder({ ...builder, kind })}
                  className={
                    "px-2.5 py-1 text-[11px] "
                    + (builder.kind === kind
                      ? "bg-brand-soft text-brand"
                      : "text-ink-3 hover:bg-soft")
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
            className="mt-2 w-full rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={builder.header}
              onChange={(event) =>
                setBuilder({ ...builder, header: event.target.value })
              }
              placeholder="Header (optional)"
              className="w-full rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
            />
            <input
              value={builder.footer}
              onChange={(event) =>
                setBuilder({ ...builder, footer: event.target.value })
              }
              placeholder="Footer (optional)"
              className="w-full rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
            />
          </div>
          {builder.kind === "list" ? (
            <input
              value={builder.listLabel}
              onChange={(event) =>
                setBuilder({ ...builder, listLabel: event.target.value })
              }
              placeholder="List button label"
              className="mt-2 w-48 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
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
                  className="w-44 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
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
                    className="flex-1 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
                  />
                ) : null}
                <button
                  onClick={() =>
                    setBuilder({
                      ...builder,
                      rows: builder.rows.filter((_, at) => at !== index),
                    })
                  }
                  className="rounded-lg border border-line px-2 py-1 text-[10px] text-ink-3 hover:bg-white/[0.06]"
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
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-white/[0.06] disabled:opacity-40"
            >
              + Add option
            </button>
            <button
              onClick={() => void saveTemplate()}
              disabled={busy}
              className="rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1 text-[11px] text-brand hover:bg-brand-soft disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save template"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {!loaded ? (
          <p className="text-xs text-ink-3">Loading templates...</p>
        ) : templates.length === 0 ? (
          <p className="text-xs text-ink-3">
            No templates yet - create one to send buttons or a menu.
          </p>
        ) : (
          templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-line bg-soft px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {template.name}
                </p>
                <p className="text-[10px] text-ink-3">
                  {template.kind === "list"
                    ? "List - " + template.rows.length + " options"
                    : "Buttons - " + template.rows.length}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void send(template.id)}
                  disabled={busy}
                  className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
                >
                  {busy ? "Sending..." : "Send"}
                </button>
                <button
                  onClick={() => void removeTemplate(template.id)}
                  disabled={busy}
                  className="rounded-lg border border-line px-2 py-1 text-[10px] text-ink-3 hover:bg-white/[0.06] disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {watiTemplates.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-sm font-medium text-ink">WATI templates</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Approved WATI templates - separate parameters with the |
            separator.
          </p>
          <div className="mt-2 space-y-1.5">
            {watiTemplates.map((template) => (
              <div
                key={template.name}
                className="rounded-xl border border-line bg-soft px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm text-ink">
                    {template.name}
                  </p>
                  <button
                    onClick={() => void sendWati(template.name)}
                    disabled={watiBusy}
                    className="shrink-0 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
                  >
                    {watiBusy ? "Sending..." : "Send"}
                  </button>
                </div>
                <input
                  value={watiParams[template.name] || ""}
                  onChange={(event) =>
                    setWatiParams({
                      ...watiParams,
                      [template.name]: event.target.value,
                    })
                  }
                  placeholder="Parameters (Value1 | Value2 | ...)"
                  className="mt-1.5 w-full rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
                />
              </div>
            ))}
          </div>
          {watiNote ? (
            <p className="mt-2 text-[11px] text-ink-3">{watiNote}</p>
          ) : null}
        </div>
      ) : null}
      {cloudTemplates.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-sm font-medium text-ink">
            Cloud API templates
          </h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Meta-approved templates synced by the connector - separate
            parameters with the | separator.
          </p>
          <div className="mt-2 space-y-1.5">
            {cloudTemplates.map((template) => (
              <div
                key={template.name}
                className="rounded-xl border border-line bg-soft px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm text-ink">
                    {template.name}
                    {template.language ? (
                      <span className="ml-1.5 text-[10px] text-ink-3">
                        {template.language}
                      </span>
                    ) : null}
                  </p>
                  <button
                    onClick={() => void sendCloud(template.name)}
                    disabled={cloudBusy}
                    className="shrink-0 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
                  >
                    {cloudBusy ? "Sending..." : "Send"}
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    value={cloudParams[template.name] || ""}
                    onChange={(event) =>
                      setCloudParams({
                        ...cloudParams,
                        [template.name]: event.target.value,
                      })
                    }
                    placeholder="Parameters (Value1 | Value2 | ...)"
                    className="w-full rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
                  />
                  <input
                    value={cloudLangs[template.name] || ""}
                    onChange={(event) =>
                      setCloudLangs({
                        ...cloudLangs,
                        [template.name]: event.target.value,
                      })
                    }
                    placeholder="en"
                    className="w-16 shrink-0 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink focus:border-white/20 focus:outline-none"
                  />
                </div>
              </div>
            ))}
          </div>
          {cloudNote ? (
            <p className="mt-2 text-[11px] text-ink-3">{cloudNote}</p>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}
    </section>
  );
}
