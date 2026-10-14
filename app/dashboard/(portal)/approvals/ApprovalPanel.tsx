"use client";

import { useEffect, useMemo, useState } from "react";

type Cell = string | number | boolean;

interface Field {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "items";
  value: unknown;
  columns?: { key: string; type: "text" | "number" | "boolean" }[];
}

interface Detail {
  id: number;
  status: string;
  refCode: string;
  kind: string;
  impact: { effect: string; onReject: string; money: Record<string, number> };
  edits: Record<string, unknown>;
  decisionNote: string | null;
  customerReply: string | null;
  canReply: boolean;
  canDecide: boolean;
  editable: Field[];
  evidence: Record<string, unknown>;
}

export interface DecisionResult {
  ok: boolean;
  text: string;
}

const MONEY_LABELS: Record<string, string> = {
  subtotal: "Subtotal",
  discount: "Discount",
  total: "Total",
  amount: "Amount",
  refund_amount: "Refund",
};

export function moneyLine(money: Record<string, number>): string {
  return Object.entries(money)
    .map(([key, value]) => (MONEY_LABELS[key] || key) + " Rs " + value.toLocaleString("en-PK"))
    .join(" · ");
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

const inputClass =
  "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40";

function CellInput({
  type,
  value,
  onChange,
  label,
}: {
  type: "text" | "number" | "boolean";
  value: unknown;
  onChange: (value: Cell) => void;
  label: string;
}) {
  if (type === "boolean") {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  return (
    <input
      aria-label={label}
      type={type === "number" ? "number" : "text"}
      value={text(value)}
      onChange={(event) =>
        onChange(type === "number" ? Number(event.target.value) : event.target.value)
      }
      className={inputClass}
    />
  );
}

export default function ApprovalPanel({
  approvalId,
  onDecided,
}: {
  approvalId: number;
  onDecided: (result: DecisionResult) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/omniflow/portal/approvals/" + approvalId, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!active) return;
        if (!response.ok || !payload?.approval) {
          setLoadError(payload?.error?.message || "Details could not be loaded.");
          return;
        }
        const loaded = payload.approval as Detail;
        setDetail(loaded);
        setDraft(Object.fromEntries(loaded.editable.map((field) => [field.key, field.value])));
      })
      .catch(() => active && setLoadError("Details could not be loaded."));
    return () => {
      active = false;
    };
  }, [approvalId]);

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const field of detail?.editable ?? []) {
      if (JSON.stringify(draft[field.key]) !== JSON.stringify(field.value)) {
        out[field.key] = draft[field.key];
      }
    }
    return out;
  }, [draft, detail]);

  async function decide(decision: "approve" | "reject") {
    if (!detail || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/approvals/" + detail.id + "/decide",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            note: note.trim() || undefined,
            reply: detail.canReply && reply.trim() ? reply.trim() : undefined,
            args: decision === "approve" && Object.keys(changed).length ? changed : undefined,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message || "The decision was not saved. Try again.");
        return;
      }
      const failed = payload?.outcome === "failed";
      onDecided({
        ok: !failed,
        text:
          detail.refCode +
          (decision === "approve" ? " approved" : " rejected") +
          (failed
            ? " - but the action failed: " + (payload?.outcomeDetail || "unknown error") +
              ". Use Retry once fixed."
            : payload?.outcomeDetail
              ? " - " + payload.outcomeDetail
              : "."),
      });
    } catch {
      setError("Network problem - try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="mt-4 text-xs text-danger">{loadError}</p>;
  if (!detail) return <p className="mt-4 text-xs text-ink-3">Loading details...</p>;

  const evidence = detail.evidence;
  const trigger = (evidence.trigger ?? {}) as Record<string, unknown>;
  const orders = evidence.orders as Record<string, unknown> | undefined;
  const pending = detail.status === "pending";
  const money = moneyLine(detail.impact.money);
  const setField = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-ok/25 bg-ok-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ok">If you approve</p>
          <p className="mt-1 text-xs text-ink-2">{detail.impact.effect}</p>
          {money ? <p className="mt-1.5 text-xs font-medium text-ink">{money}</p> : null}
        </div>
        <div className="rounded-xl border border-line bg-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">If you reject</p>
          <p className="mt-1 text-xs text-ink-2">{detail.impact.onReject}</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-ink">Why this needs you</p>
        <ul className="mt-1.5 space-y-1 text-xs text-ink-2">
          <li>
            Raised by{" "}
            {trigger.source === "agent"
              ? "an AI agent" + (trigger.actor ? " (" + text(trigger.actor) + ")" : "")
              : trigger.source === "workflow"
                ? "workflow #" + text(trigger.workflowId) + ", step " + text(trigger.stepNo)
                : "the AI assistant"}
            {trigger.detectedFrom ? " - detected from: " + text(trigger.detectedFrom) : ""}
          </li>
          {orders ? (
            <li>
              Orders: {text(orders.delivered)} delivered, {text(orders.returned)} returned,{" "}
              {text(orders.cancelled)} cancelled, {text(orders.open)} open
            </li>
          ) : null}
        </ul>
      </div>

      {list(evidence.recentMessages).length ? (
        <div>
          <p className="text-xs font-semibold text-ink">Recent messages</p>
          <div className="mt-1.5 space-y-1">
            {list(evidence.recentMessages).map((message, index) => (
              <p
                key={index}
                className={
                  "rounded-lg px-2.5 py-1.5 text-xs " +
                  (message.direction === "in" ? "bg-soft text-ink-2" : "bg-brand-soft text-ink-2")
                }
              >
                <span className="font-medium text-ink">
                  {message.direction === "in" ? "Customer: " : "Business: "}
                </span>
                {text(message.body)}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {list(evidence.policies).length ? (
        <div>
          <p className="text-xs font-semibold text-ink">Your policies</p>
          {list(evidence.policies).map((policy, index) => (
            <p key={index} className="mt-1 text-xs text-ink-2">
              <span className="font-medium text-ink">{text(policy.label) || text(policy.kind)}:</span>{" "}
              {text(policy.content)}
            </p>
          ))}
        </div>
      ) : null}

      {list(evidence.customerNotes).length ? (
        <div>
          <p className="text-xs font-semibold text-ink">Customer notes</p>
          {list(evidence.customerNotes).map((item, index) => (
            <p key={index} className="mt-1 text-xs text-ink-2">{text(item.content)}</p>
          ))}
        </div>
      ) : null}

      {list(evidence.earlierDecisions).length ? (
        <div>
          <p className="text-xs font-semibold text-ink">Earlier decisions for this customer</p>
          {list(evidence.earlierDecisions).map((item, index) => (
            <p key={index} className="mt-1 text-xs text-ink-2">
              <span className="capitalize">{text(item.status)}</span> - {text(item.summary)}
            </p>
          ))}
        </div>
      ) : null}

      {!pending ? (
        <div className="space-y-1 text-xs text-ink-2">
          {Object.keys(detail.edits).length ? (
            <p>Approved with changes to: {Object.keys(detail.edits).join(", ")}</p>
          ) : null}
          {detail.decisionNote ? <p>Note: {detail.decisionNote}</p> : null}
          {detail.customerReply ? <p>Reply to customer: {detail.customerReply}</p> : null}
        </div>
      ) : !detail.canDecide ? (
        <p className="text-xs text-ink-3">Only the workspace owner or an admin can decide this.</p>
      ) : (
        <div className="space-y-3">
          {detail.editable.length ? (
            <div>
              <p className="text-xs font-semibold text-ink">Change before approving (optional)</p>
              <div className="mt-2 space-y-2">
                {detail.editable.map((field) =>
                  field.type === "items" ? (
                    <div key={field.key}>
                      <p className="mb-1 text-[11px] text-ink-3">{field.label}</p>
                      {list(draft[field.key]).map((row, index, rows) => (
                        <div key={index} className="mb-1 flex items-center gap-2">
                          {(field.columns ?? []).map((column) => (
                            <CellInput
                              key={column.key}
                              type={column.type}
                              label={field.label + " " + column.key + " " + (index + 1)}
                              value={row[column.key]}
                              onChange={(value) =>
                                setField(
                                  field.key,
                                  rows.map((item, at) =>
                                    at === index ? { ...item, [column.key]: value } : item
                                  )
                                )
                              }
                            />
                          ))}
                          {rows.length > 1 ? (
                            <button
                              type="button"
                              onClick={() => setField(field.key, rows.filter((_, at) => at !== index))}
                              className="shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-3 hover:text-danger"
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <label key={field.key} className="block">
                      <span className="mb-1 block text-[11px] text-ink-3">{field.label}</span>
                      <CellInput
                        type={field.type}
                        label={field.label}
                        value={draft[field.key]}
                        onChange={(value) => setField(field.key, value)}
                      />
                    </label>
                  )
                )}
              </div>
            </div>
          ) : null}
          {detail.canReply ? (
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-3">
                Reply to the customer (optional - sent on their channel)
              </span>
              <textarea
                value={reply}
                maxLength={1000}
                rows={2}
                onChange={(event) => setReply(event.target.value)}
                className={inputClass}
              />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-3">Internal note (optional)</span>
            <input
              value={note}
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
              className={inputClass}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("approve")}
              className="rounded-xl border border-ok/30 bg-ok-soft px-4 py-2 text-xs font-semibold text-ok hover:opacity-90 disabled:opacity-50"
            >
              {Object.keys(changed).length ? "Approve with changes" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("reject")}
              className="rounded-xl border border-danger/30 bg-soft px-4 py-2 text-xs font-semibold text-danger hover:opacity-90 disabled:opacity-50"
            >
              Reject
            </button>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
