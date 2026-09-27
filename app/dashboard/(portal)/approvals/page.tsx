"use client";

import { useCallback, useEffect, useState } from "react";

interface Approval {
  id: number;
  contactId: string;
  contactName: string | null;
  action: string;
  summary: string;
  customerQuery: string | null;
  status: string;
  refCode: string;
  decidedBy: string | null;
  decidedVia: string | null;
  createdAt: string | null;
}

interface ApprovalsConfig {
  approvalNumber: string;
  autoExpireHours: number;
  selfChatAvailable: boolean;
}

const TABS = ["pending", "approved", "rejected", "all"] as const;
type Tab = (typeof TABS)[number];

const STATUS_CHIP: Record<string, string> = {
  pending: "border-amber-400/30 bg-amber-400/10 text-amber-600",
  approved: "border-emerald-400/30 bg-emerald-400/10 text-ok",
  rejected: "border-rose-400/30 bg-rose-400/10 text-danger",
  expired: "border-line-2 bg-soft text-ink-3",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "abhi";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min pehle";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " ghantay pehle";
  return Math.floor(seconds / 86400) + " din pehle";
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string; ok: boolean } | null>(null);

  const [config, setConfig] = useState<ApprovalsConfig | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("24");
  const [savingConfig, setSavingConfig] = useState(false);
  const [configNotice, setConfigNotice] = useState("");

  const load = useCallback(async (which: Tab) => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/approvals?status=" + which,
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as { approvals?: Approval[] };
        setApprovals(payload.approvals ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    setApprovals(null);
    void load(tab);
  }, [tab, load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/approvals/config",
          { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as ApprovalsConfig;
          setConfig(payload);
          setNumberDraft(payload.approvalNumber || "");
          setHoursDraft(String(payload.autoExpireHours || 24));
        }
      } catch {
        /* config card stays hidden-ish; list still works */
      }
    })();
  }, []);

  useEffect(() => {
    if (tab !== "pending") return;
    const timer = setInterval(() => void load(tab), 25000);
    return () => clearInterval(timer);
  }, [tab, load]);

  async function decide(approval: Approval, decision: "approve" | "reject") {
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
      if (response.ok) {
        setNotice({
          id: approval.id,
          text: decision === "approve"
            ? approval.refCode + " approve ho gayi."
            : approval.refCode + " reject ho gayi.",
          ok: true,
        });
        void load(tab);
      } else {
        const payload = (await response.json().catch(() => null)) as
          { error?: { message?: string } } | null;
        setNotice({
          id: approval.id,
          text: payload?.error?.message || "Decision save nahi hui — dobara karein.",
          ok: false,
        });
      }
    } catch {
      setNotice({ id: approval.id, text: "Network masla — dobara karein.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    setConfigNotice("");
    try {
      const response = await fetch("/api/omniflow/portal/approvals/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalNumber: numberDraft.trim(),
          autoExpireHours: Number(hoursDraft) || 24,
        }),
      });
      if (response.ok) {
        setConfigNotice("Save ho gaya — ab approvals yahan aayengi.");
        setConfig({ ...config, approvalNumber: numberDraft.trim(),
          autoExpireHours: Number(hoursDraft) || 24,
          selfChatAvailable: config?.selfChatAvailable ?? false });
      } else {
        const payload = (await response.json().catch(() => null)) as
          { error?: { message?: string } } | null;
        setConfigNotice(payload?.error?.message || "Save nahi hua — dobara karein.");
      }
    } catch {
      setConfigNotice("Network masla — dobara karein.");
    } finally {
      setSavingConfig(false);
    }
  }

  const pendingCount = tab === "pending"
    ? (approvals?.length ?? 0)
    : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Approvals
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          High-risk requests (refund, order cancel, bara discount) aapki
          tasdeeq ke baghair aage nahi barhti. WhatsApp par{" "}
          <span className="font-medium text-ink">1</span> = approve,{" "}
          <span className="font-medium text-ink">0</span> = reject — ya
          yahin se decide karein.
        </p>
      </div>

      {/* where approvals land */}
      {config !== null ? (
        <div className="mb-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
          <p className="text-sm font-semibold text-ink">
            Approval kahan jayengi?
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Number khali chhorein = aapke business WhatsApp ki khud ki chat
            (self-chat). Koi aur number likhein to wahan jayengi.
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
                placeholder={config.selfChatAvailable
                  ? "Self-chat (default)"
                  : "923001234567"}
                className="w-64 rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink placeholder-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
              />
            </div>
            <div>
              <label htmlFor="approval_hours" className="mb-1 block text-xs font-medium text-ink-3">
                Expiry (ghantay)
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
          {configNotice ? (
            <p className="mt-3 text-xs text-ink-2">{configNotice}</p>
          ) : null}
        </div>
      ) : null}

      {/* tabs */}
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
        {pendingCount !== null && pendingCount > 0 ? (
          <span className="ml-auto text-xs text-ink-3">
            {pendingCount} pending · khud-ba-khud refresh hota hai
          </span>
        ) : null}
      </div>

      {/* list */}
      {approvals === null && !loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-3 shadow-card">
          Load ho raha hai...
        </div>
      ) : null}
      {loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-2 shadow-card">
          Approvals load nahi hui — page refresh karke dobara koshish karein.
        </div>
      ) : null}
      {approvals !== null && approvals.length === 0 && !loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center shadow-card">
          <p className="text-sm font-medium text-ink">
            {tab === "pending" ? "Koi pending approval nahi." : "Koi record nahi."}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Jab koi customer refund / cancel / bara discount maangega, request
            yahan aur aapke WhatsApp par aayegi.
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        {(approvals ?? []).map((approval) => (
          <div
            key={approval.id}
            className="rounded-xl2 border border-line bg-white p-5 shadow-card"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-brand/25 bg-brand-soft px-2.5 py-0.5 text-[11px] font-semibold text-brand">
                {approval.refCode}
              </span>
              <span
                className={
                  "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize " +
                  (STATUS_CHIP[approval.status] || STATUS_CHIP.expired)
                }
              >
                {approval.status}
              </span>
              <span className="text-[11px] text-ink-3">
                {timeAgo(approval.createdAt)}
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">
              {approval.contactName || approval.contactId}
              {approval.contactName ? (
                <span className="ml-2 text-xs font-normal text-ink-3">
                  {approval.contactId.replace(/@.*$/, "")}
                </span>
              ) : null}
            </p>
            <p className="mt-1 text-sm text-ink-2">{approval.summary}</p>
            {approval.customerQuery ? (
              <p className="mt-2 border-l-2 border-line-2 pl-3 text-[13px] italic text-ink-2">
                “{approval.customerQuery}”
              </p>
            ) : null}
            {approval.status === "pending" ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === approval.id}
                  onClick={() => void decide(approval, "approve")}
                  className="rounded-xl border border-ok/30 bg-ok-soft px-4 py-2 text-xs font-semibold text-ok transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
                >
                  Approve (1)
                </button>
                <button
                  type="button"
                  disabled={busyId === approval.id}
                  onClick={() => void decide(approval, "reject")}
                  className="rounded-xl border border-danger/30 bg-soft px-4 py-2 text-xs font-semibold text-danger transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
                >
                  Reject (0)
                </button>
                {notice && notice.id === approval.id ? (
                  <span className={"text-xs " + (notice.ok ? "text-ok" : "text-danger")}>
                    {notice.text}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-3">
                {approval.decidedBy
                  ? "Decided via " + approval.decidedVia + " · " + approval.decidedBy
                  : ""}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
