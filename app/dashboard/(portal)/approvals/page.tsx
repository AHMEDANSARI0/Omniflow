"use client";

import { useCallback, useEffect, useState } from "react";
import ApprovalPanel, { moneyLine, type DecisionResult } from "./ApprovalPanel";

interface Approval {
  id: number;
  contactId: string;
  contactName: string | null;
  summary: string;
  customerQuery: string | null;
  status: string;
  refCode: string;
  decidedBy: string | null;
  decidedVia: string | null;
  createdAt: string | null;
  kind: string;
  kindLabel: string;
  risk: string;
  impact: { effect: string; money: Record<string, number> };
  outcome: string | null;
  outcomeDetail: string | null;
}

interface ApprovalsConfig {
  approvalNumber: string;
  autoExpireHours: number;
  selfChatAvailable: boolean;
}

const TABS = ["pending", "approved", "rejected", "expired", "all"] as const;
type Tab = (typeof TABS)[number];

const STATUS_CHIP: Record<string, string> = {
  pending: "border-amber-400/30 bg-amber-400/10 text-amber-600",
  approved: "border-emerald-400/30 bg-emerald-400/10 text-ok",
  rejected: "border-rose-400/30 bg-rose-400/10 text-danger",
  expired: "border-line-2 bg-soft text-ink-3",
};

const OUTCOME_LABEL: Record<string, string> = {
  executed: "Action ran",
  reply_sent: "Reply sent to customer",
  recorded: "Decision recorded",
  failed: "Action failed",
  retrying: "Retrying",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
  return Math.floor(seconds / 86400) + " d ago";
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [kind, setKind] = useState("");
  const [kinds, setKinds] = useState<{ key: string; label: string }[]>([]);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string; ok: boolean } | null>(null);

  const [config, setConfig] = useState<ApprovalsConfig | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("24");
  const [savingConfig, setSavingConfig] = useState(false);
  const [configNotice, setConfigNotice] = useState("");

  const load = useCallback(async (which: Tab, kindFilter: string) => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/approvals?status=" + which +
          (kindFilter ? "&kind=" + encodeURIComponent(kindFilter) : ""),
        { cache: "no-store" }
      );
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload = (await response.json()) as {
        approvals?: Approval[];
        kinds?: { key: string; label: string }[];
      };
      setApprovals(payload.approvals ?? []);
      if (payload.kinds?.length) setKinds(payload.kinds);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    setApprovals(null);
    void load(tab, kind);
  }, [tab, kind, load]);

  useEffect(() => {
    if (tab !== "pending" || openId !== null) return;
    const timer = setInterval(() => void load(tab, kind), 25000);
    return () => clearInterval(timer);
  }, [tab, kind, openId, load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/approvals/config", {
          cache: "no-store",
        });
        if (response.ok) {
          const payload = (await response.json()) as ApprovalsConfig;
          setConfig(payload);
          setNumberDraft(payload.approvalNumber || "");
          setHoursDraft(String(payload.autoExpireHours || 24));
        }
      } catch {
        /* the list still works without the config card */
      }
    })();
  }, []);

  function decided(id: number, result: DecisionResult) {
    setOpenId(null);
    setNotice({ id, ...result });
    void load(tab, kind);
  }

  async function quickDecide(approval: Approval, decision: "approve" | "reject") {
    setBusyId(approval.id);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/approvals/" + approval.id + "/decide",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice({
          id: approval.id,
          text: payload?.error?.message || "The decision was not saved. Try again.",
          ok: false,
        });
        return;
      }
      const failed = payload?.outcome === "failed";
      decided(approval.id, {
        ok: !failed,
        text:
          approval.refCode + (decision === "approve" ? " approved" : " rejected") +
          (failed ? " - but the action failed. Use Retry once fixed." : "."),
      });
    } catch {
      setNotice({ id: approval.id, text: "Network problem - try again.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function retry(approval: Approval) {
    setBusyId(approval.id);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/approvals/" + approval.id + "/retry",
        { method: "POST" }
      );
      const payload = await response.json().catch(() => null);
      const ok = response.ok && payload?.outcome !== "failed";
      setNotice({
        id: approval.id,
        text: !response.ok
          ? payload?.error?.message || "Retry failed. Try again."
          : ok
            ? "Done - " + (OUTCOME_LABEL[payload?.outcome] || "action ran") + "."
            : "Still failing: " + (payload?.outcomeDetail || "unknown error"),
        ok,
      });
      void load(tab, kind);
    } catch {
      setNotice({ id: approval.id, text: "Network problem - try again.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    setConfigNotice("");
    const hours = Number(hoursDraft) || 24;
    try {
      const response = await fetch("/api/omniflow/portal/approvals/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalNumber: numberDraft.trim(), autoExpireHours: hours }),
      });
      if (response.ok) {
        setConfigNotice("Saved. New approvals will be sent here.");
        setConfig({
          approvalNumber: numberDraft.trim(),
          autoExpireHours: hours,
          selfChatAvailable: config?.selfChatAvailable ?? false,
        });
      } else {
        const payload = await response.json().catch(() => null);
        setConfigNotice(payload?.error?.message || "Could not save. Try again.");
      }
    } catch {
      setConfigNotice("Network problem - try again.");
    } finally {
      setSavingConfig(false);
    }
  }

  const chip = "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold";

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Approvals</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          High-risk requests (refunds, cancellations, discounts, AI actions and
          workflow steps) wait for your decision. Reply{" "}
          <span className="font-medium text-ink">1</span> to approve or{" "}
          <span className="font-medium text-ink">0</span> to reject on WhatsApp,
          or review the details and decide here.
        </p>
      </div>

      {config !== null ? (
        <div className="mb-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
          <p className="text-sm font-semibold text-ink">Where should approvals go?</p>
          <p className="mt-1 text-xs text-ink-3">
            Leave the number empty to use your business WhatsApp self-chat, or
            enter another number.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="approval_number" className="mb-1 block text-xs font-medium text-ink-3">
                Owner WhatsApp number (optional)
              </label>
              <input
                id="approval_number"
                value={numberDraft}
                onChange={(event) => setNumberDraft(event.target.value)}
                placeholder={config.selfChatAvailable ? "Self-chat (default)" : "923001234567"}
                className="w-64 rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink placeholder-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
              />
            </div>
            <div>
              <label htmlFor="approval_hours" className="mb-1 block text-xs font-medium text-ink-3">
                Expires after (hours)
              </label>
              <input
                id="approval_hours"
                type="number"
                min={1}
                max={168}
                value={hoursDraft}
                onChange={(event) => setHoursDraft(event.target.value)}
                className="w-28 rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-colors duration-300 focus:border-brand/40"
              />
            </div>
            <button
              type="button"
              onClick={() => void saveConfig()}
              disabled={savingConfig}
              className="rounded-xl bg-brand px-4 py-2.5 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
            >
              {savingConfig ? "Saving..." : "Save"}
            </button>
          </div>
          {configNotice ? <p className="mt-3 text-xs text-ink-2">{configNotice}</p> : null}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={
              "rounded-full border px-3.5 py-1.5 text-xs font-medium capitalize transition-colors duration-300 " +
              (tab === item
                ? "border-brand/30 bg-brand-soft text-brand"
                : "border-line bg-white text-ink-3 hover:text-ink-2")
            }
          >
            {item}
          </button>
        ))}
        {kinds.length ? (
          <select
            aria-label="Type"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-xs text-ink-2 outline-none"
          >
            <option value="">All types</option>
            {kinds.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        ) : null}
        {tab === "pending" && approvals?.length ? (
          <span className="ml-auto text-xs text-ink-3">
            {approvals.length} pending · refreshes automatically
          </span>
        ) : null}
      </div>

      {notice && approvals !== null && !approvals.some((item) => item.id === notice.id) ? (
        <div
          role="status"
          className={
            "mb-4 rounded-xl border px-4 py-3 text-xs " +
            (notice.ok ? "border-ok/30 bg-ok-soft text-ok" : "border-danger/30 bg-soft text-danger")
          }
        >
          {notice.text}
          {notice.ok ? null : " See it under the Approved tab."}
        </div>
      ) : null}
      {approvals === null && !loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-3 shadow-card">
          Loading...
        </div>
      ) : null}
      {loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-2 shadow-card">
          Approvals could not be loaded. Refresh the page and try again.
        </div>
      ) : null}
      {approvals !== null && approvals.length === 0 && !loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center shadow-card">
          <p className="text-sm font-medium text-ink">
            {tab === "pending" ? "Nothing waiting for you." : "No records yet."}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            When a customer asks for a refund, a cancellation or a discount, or
            an AI action needs your OK, it shows up here and on your WhatsApp.
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        {(approvals ?? []).map((approval) => {
          const money = moneyLine(approval.impact.money);
          const open = openId === approval.id;
          return (
            <div key={approval.id} className="rounded-xl2 border border-line bg-white p-5 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className={chip + " border-brand/25 bg-brand-soft text-brand"}>
                  {approval.refCode}
                </span>
                <span className={chip + " capitalize " + (STATUS_CHIP[approval.status] || STATUS_CHIP.expired)}>
                  {approval.status}
                </span>
                <span className={chip + " border-line bg-soft text-ink-2"}>{approval.kindLabel}</span>
                {approval.risk === "high" ? (
                  <span className={chip + " border-rose-400/30 bg-rose-400/10 text-danger"}>High risk</span>
                ) : null}
                <span className="text-[11px] text-ink-3">{timeAgo(approval.createdAt)}</span>
              </div>
              <p className="mt-3 text-sm font-semibold text-ink">
                {approval.contactName || approval.contactId.replace(/@.*$/, "")}
                {approval.contactName ? (
                  <span className="ml-2 text-xs font-normal text-ink-3">
                    {approval.contactId.replace(/@.*$/, "")}
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-sm text-ink-2">{approval.summary}</p>
              {money ? <p className="mt-1 text-xs font-medium text-ink">{money}</p> : null}
              {approval.customerQuery ? (
                <p className="mt-2 border-l-2 border-line-2 pl-3 text-[13px] italic text-ink-2">
                  &ldquo;{approval.customerQuery}&rdquo;
                </p>
              ) : null}

              {approval.status !== "pending" && approval.status !== "expired" ? (
                <p className="mt-3 text-xs text-ink-3">
                  {approval.decidedBy
                    ? "Decided via " + approval.decidedVia + " by " + approval.decidedBy
                    : ""}
                  {approval.outcome ? (
                    <span className={approval.outcome === "failed" ? " text-danger" : " text-ink-2"}>
                      {" · " + (OUTCOME_LABEL[approval.outcome] || approval.outcome)}
                      {approval.outcomeDetail ? ": " + approval.outcomeDetail : ""}
                    </span>
                  ) : null}
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {approval.status === "pending" && !open ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === approval.id}
                      onClick={() => void quickDecide(approval, "approve")}
                      className="rounded-xl border border-ok/30 bg-ok-soft px-4 py-2 text-xs font-semibold text-ok transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === approval.id}
                      onClick={() => void quickDecide(approval, "reject")}
                      className="rounded-xl border border-danger/30 bg-soft px-4 py-2 text-xs font-semibold text-danger transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                ) : null}
                {approval.status === "approved" && approval.outcome === "failed" ? (
                  <button
                    type="button"
                    disabled={busyId === approval.id}
                    onClick={() => void retry(approval)}
                    className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-semibold text-brand hover:opacity-90 disabled:opacity-50"
                  >
                    Retry action
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : approval.id)}
                  className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-ink-2 hover:text-ink"
                >
                  {open ? "Close" : approval.status === "pending" ? "Review details" : "Details"}
                </button>
                {notice && notice.id === approval.id ? (
                  <span className={"text-xs " + (notice.ok ? "text-ok" : "text-danger")}>
                    {notice.text}
                  </span>
                ) : null}
              </div>

              {open ? (
                <ApprovalPanel
                  approvalId={approval.id}
                  onDecided={(result) => decided(approval.id, result)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
