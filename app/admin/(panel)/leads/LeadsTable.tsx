"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadStatus, deleteLead } from "./actions";
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

function LeadRow({ lead }: { lead: Lead }) {
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
      </td>
    </tr>
  );
}

export default function LeadsTable({ leads }: { leads: Lead[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-white/[0.015]">
      <table className="w-full min-w-[560px] text-left">
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
            <LeadRow key={lead.id} lead={lead} />
          ))}
        </tbody>
      </table>
    </div>
  );
}