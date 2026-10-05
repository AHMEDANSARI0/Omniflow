"use client";

import { useState } from "react";

import type {
  SalesOverview,
  SalesPlaybookEntry,
  SalesQualifier,
  SalesSettings,
  SalesSettingsView,
} from "../../../../lib/omniflow/portal";

const card = "rounded-2xl border border-line bg-white p-5 shadow-card";
const ghostBtn =
  "rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors duration-300 hover:text-ink disabled:opacity-50";
const LABEL_TONE: Record<string, string> = {
  hot: "text-emerald-600",
  warm: "text-amber-600",
  cold: "text-ink-3",
};

async function send(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

function errorOf(data: Record<string, unknown> | null, fallback: string): string {
  const error = data?.error as { message?: string } | undefined;
  return error?.message || fallback;
}

/** §237 Sales desk: settings, approved answers, concern stats, leads. */
export default function SalesDeskClient({
  initialSettings,
  initialOverview,
}: {
  initialSettings: SalesSettingsView | null;
  initialOverview: SalesOverview | null;
}) {
  const [view, setView] = useState<SalesSettingsView | null>(initialSettings);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view) {
    return <p className="text-sm text-ink-3">The Sales desk could not be loaded. Try again shortly.</p>;
  }
  const canEdit = view.canEdit;

  async function saveSettings(change: Partial<SalesSettings>) {
    if (!view || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await send("/api/omniflow/portal/sales/settings", change);
    if (result.ok && result.data?.settings) {
      setView({ ...view, settings: result.data.settings as SalesSettings });
      setNotice("Saved.");
    } else {
      setNotice(errorOf(result.data, "Saving failed. Try again shortly."));
    }
    setBusy(false);
  }

  function toggleQualifier(key: SalesQualifier) {
    if (!view) return;
    const current = view.settings.qualifiers;
    void saveSettings({
      qualifiers: current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    });
  }

  const overview = initialOverview;
  const totals = overview?.totals;

  return (
    <div className="space-y-6">
      {notice ? <p className="text-xs text-ink-3">{notice}</p> : null}

      <section className={card}>
        <h2 className="text-sm font-semibold text-ink">How the assistant sells</h2>
        <div className="mt-3 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={view.settings.brainContext}
              disabled={!canEdit || busy}
              onChange={(event) => void saveSettings({ brainContext: event.target.checked })}
              className="mt-1"
            />
            <span>
              <span className="text-ink">Give the assistant sales notes</span>
              <span className="block text-xs text-ink-3">
                What the customer already said, one detail to ask next, and your approved answer when they raise a
                concern. Prices still come only from your catalog; the assistant never offers discounts.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={view.settings.autoStage}
              disabled={!canEdit || busy}
              onChange={(event) => void saveSettings({ autoStage: event.target.checked })}
              className="mt-1"
            />
            <span>
              <span className="text-ink">Move leads in the pipeline automatically</span>
              <span className="block text-xs text-ink-3">
                Forward only: New to Interested when they name a product, to Negotiating on a price question or a quote.
                Won and Lost stay yours.
              </span>
            </span>
          </label>
          <div>
            <p className="text-ink">Details to collect, in order</p>
            <p className="text-xs text-ink-3">The assistant asks for at most one missing detail per reply.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {view.qualifiers.map((item) => {
                const position = view.settings.qualifiers.indexOf(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={!canEdit || busy}
                    onClick={() => toggleQualifier(item.key)}
                    className={
                      "rounded-full border px-3 py-1 text-xs transition-colors duration-300 disabled:opacity-60 " +
                      (position >= 0 ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-3 hover:text-ink")
                    }
                  >
                    {(position >= 0 ? position + 1 + ". " : "") + item.label}
                  </button>
                );
              })}
            </div>
          </div>
          {!canEdit ? <p className="text-xs text-ink-3">Only owners and admins can change these settings.</p> : null}
        </div>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-ink">Approved answers to common concerns</h2>
        <p className="mt-1 text-xs text-ink-3">
          Your team can copy these from a chat, and the assistant uses an answer only after you save it. Write in the
          language your customers use.
        </p>
        <div className="mt-4 space-y-3">
          {view.playbook.map((entry) => (
            <PlaybookRow
              key={entry.kind}
              entry={entry}
              canEdit={canEdit}
              stat={overview?.concerns.find((item) => item.kind === entry.kind) ?? null}
              onSaved={(playbook) => setView((current) => (current ? { ...current, playbook } : current))}
            />
          ))}
        </div>
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Leads</h2>
          {overview && totals ? (
            <p className="text-xs text-ink-3">
              {"Last " + overview.days + " days \u00b7 "}
              <span className={LABEL_TONE.hot}>{totals.hot.chats + " hot"}</span>
              {" \u00b7 "}
              <span className={LABEL_TONE.warm}>{totals.warm.chats + " warm"}</span>
              {" \u00b7 " + totals.cold.chats + " cold \u00b7 "}
              {totals.hot.bought + totals.warm.bought + totals.cold.bought + " bought"}
            </p>
          ) : null}
        </div>
        {!overview ? (
          <p className="mt-3 text-sm text-ink-3">Leads could not be loaded. Try again shortly.</p>
        ) : overview.leads.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">No sales chats yet. Leads appear as customers message you.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {overview.leads.map((lead) => (
              <li key={lead.conversationId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <a
                    href={"/dashboard/conversations/" + String(lead.conversationId)}
                    className="font-medium text-ink hover:underline"
                  >
                    {lead.contactName || "Customer"}
                  </a>
                  <p className="text-xs text-ink-3">
                    {[lead.product, lead.concerns.join(", ")].filter(Boolean).join(" \u00b7 ") || "No details yet"}
                  </p>
                </div>
                <p className="text-xs">
                  {lead.bought ? (
                    <span className="text-emerald-600">{"\u2713 bought"}</span>
                  ) : (
                    <>
                      <span className={LABEL_TONE[lead.label]}>{lead.label + " " + lead.score}</span>
                      <span className="text-ink-3">{" \u00b7 " + lead.stageHint.replace(/_/g, " ")}</span>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlaybookRow({
  entry,
  canEdit,
  stat,
  onSaved,
}: {
  entry: SalesPlaybookEntry;
  canEdit: boolean;
  stat: SalesOverview["concerns"][number] | null;
  onSaved: (playbook: SalesPlaybookEntry[]) => void;
}) {
  const [reply, setReply] = useState(entry.reply);
  const [enabled, setEnabled] = useState(entry.enabled || !entry.reply);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = reply.trim() !== entry.reply || (Boolean(entry.reply) && enabled !== entry.enabled);

  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await send(
      "/api/omniflow/portal/sales/playbook/" + encodeURIComponent(entry.kind),
      { reply: reply.trim(), enabled }
    );
    if (result.ok && Array.isArray(result.data?.playbook)) {
      onSaved(result.data.playbook as SalesPlaybookEntry[]);
      setMessage("Saved.");
    } else {
      setMessage(errorOf(result.data, "Saving failed. Try again shortly."));
    }
    setBusy(false);
  }

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink">{entry.label}</p>
        {stat ? (
          <p className="text-[11px] text-ink-3">
            {stat.chats + (stat.chats === 1 ? " chat" : " chats") + " \u00b7 " + stat.rate + "% still bought"}
          </p>
        ) : null}
      </div>
      <textarea
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        disabled={!canEdit || busy}
        rows={2}
        maxLength={600}
        placeholder={entry.suggestion}
        className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-3"
      />
      {canEdit ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!reply && entry.suggestion ? (
            <button type="button" onClick={() => setReply(entry.suggestion)} className={ghostBtn}>
              Use suggestion
            </button>
          ) : null}
          <label className="flex items-center gap-1 text-xs text-ink-3">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Active for team and assistant
          </label>
          <button type="button" onClick={() => void save()} disabled={busy || !dirty} className={ghostBtn}>
            {busy ? "Saving\u2026" : "Save"}
          </button>
          {message ? <span className="text-xs text-ink-3">{message}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
