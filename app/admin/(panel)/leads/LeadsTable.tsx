"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateLeadStatus,
  deleteLead,
  inviteLead,
  type InviteResult,
} from "./actions";
import type { Lead, LeadStatus } from "./types";

const statusStyles: Record<LeadStatus, string> = {
  new: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
  contacted: "border-violet-400/20 bg-violet-400/[0.06] text-violet-300",
  closed: "border-white/[0.08] bg-white/[0.02] text-slate-500",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function LeadRow({
  lead,
  onInvited,
}: {
  lead: Lead;
  onInvited: (result: InviteResult) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleStatusChange(status: LeadStatus) {
    startTransition(async () => {
      await updateLeadStatus(lead.id, status);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!window.confirm(`Delete lead "${lead.name}"? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      await deleteLead(lead.id);
      router.refresh();
    });
  }

  function handleInvite() {
    if (
      !window.confirm(
        `Create a client account for "${lead.email}"? You'll get a temporary password to share with them.`
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await inviteLead(lead.id, lead.email);
      onInvited(result);
      router.refresh();
    });
  }

  return (
    <tr
      className={`border-b border-white/[0.04] transition-opacity ${
        pending ? "opacity-40" : ""
      }`}
    >
      <td className="px-4 py-3.5">
        <p className="text-sm font-medium text-white">{lead.name}</p>
        <p className="text-xs text-slate-500">{lead.email}</p>
      </td>
      <td className="hidden px-4 py-3.5 text-sm text-slate-400 md:table-cell">
        {lead.company ?? <span className="text-slate-600">—</span>}
      </td>
      <td className="hidden px-4 py-3.5 text-xs text-slate-500 sm:table-cell">
        {formatDate(lead.created_at)}
      </td>
      <td className="px-4 py-3.5">
        <select
          value={lead.status}
          disabled={pending}
          onChange={(e) => handleStatusChange(e.target.value as LeadStatus)}
          className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs outline-none transition-colors ${statusStyles[lead.status]} bg-transparent`}
        >
          <option value="new" className="bg-[#081522] text-slate-200">
            New
          </option>
          <option value="contacted" className="bg-[#081522] text-slate-200">
            Contacted
          </option>
          <option value="closed" className="bg-[#081522] text-slate-200">
            Closed
          </option>
        </select>
      </td>
      <td className="px-4 py-3.5 text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleInvite}
            disabled={pending}
            title="Create client account"
            className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] px-3 py-1.5 text-xs font-medium text-cyan-300 transition-colors duration-200 hover:border-cyan-400/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Invite
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={pending}
            title="Delete lead"
            aria-label={`Delete lead ${lead.name}`}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-500 transition-colors duration-200 hover:border-red-400/30 hover:text-red-300 disabled:cursor-not-allowed"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function LeadsTable({ leads }: { leads: Lead[] }) {
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

  return (
    <div className="space-y-4">
      {/* Invite result — credentials shown ONCE */}
      {inviteResult && (
        <div
          className={`rounded-2xl border p-5 ${
            inviteResult.success
              ? "border-emerald-400/20 bg-emerald-400/[0.05]"
              : "border-red-400/20 bg-red-400/[0.05]"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p
                className={`text-xs font-medium ${
                  inviteResult.success ? "text-emerald-300" : "text-red-300"
                }`}
              >
                {inviteResult.success ? "✓ " : "✕ "}
                {inviteResult.message}
              </p>

              {inviteResult.success && inviteResult.tempPassword && (
                <div className="mt-3 space-y-2">
                  <code className="block select-all break-all rounded-lg border border-white/[0.08] bg-[#060f1b] px-3 py-2 font-mono text-xs text-slate-300">
                    Login: https://omniflow-bice.vercel.app/dashboard/login
                    <br />
                    Email: {inviteResult.email}
                    <br />
                    Password: {inviteResult.tempPassword}
                  </code>
                  <p className="text-[11px] text-slate-500">
                    ⚠ Ye password dobara nahi dikhega — abhi copy kar ke client
                    ko securely bhej dein.
                  </p>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setInviteResult(null)}
              aria-label="Dismiss"
              className="shrink-0 rounded-lg border border-white/[0.08] px-2 py-1 text-xs text-slate-500 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-white/[0.015]">
        <table className="w-full min-w-[640px] text-left">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                Lead
              </th>
              <th className="hidden px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500 md:table-cell">
                Company
              </th>
              <th className="hidden px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500 sm:table-cell">
                Date
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                Status
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onInvited={setInviteResult} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
