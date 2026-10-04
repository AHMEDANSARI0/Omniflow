"use client";

import { useCallback, useEffect, useState } from "react";

interface Snapshot {
  id: number;
  label: string;
  reason: string;
  reasonLabel: string;
  createdBy: string | null;
  createdAt: string | null;
  areas: string[];
}

interface CompareArea {
  key: string;
  label: string;
  inSnapshot: boolean;
  changes: { field: string; current: string; snapshot: string }[];
}

interface ListPayload {
  snapshots: Snapshot[];
  areas: { key: string; label: string }[];
  autoMinutes: number;
  canRestore: boolean;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }) : "";
}

const button =
  "rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50";

export default function ConfigHistoryCard() {
  const [data, setData] = useState<ListPayload | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [compare, setCompare] = useState<CompareArea[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/omniflow/portal/snapshots", { cache: "no-store" }).catch(
      () => null
    );
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload && Array.isArray(payload.snapshots)) setData(payload as ListPayload);
    else setNote(payload?.error?.message || "Configuration history is unavailable right now.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setNote(payload?.error?.message || "That did not work - try again.");
        return null;
      }
      return payload ?? {};
    } catch {
      setNote("Network problem - try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const payload = await call("/api/omniflow/portal/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim() }),
    });
    if (!payload) return;
    setLabel("");
    setNote("Snapshot saved.");
    void load();
  }

  async function open(snapshot: Snapshot) {
    if (openId === snapshot.id) {
      setOpenId(null);
      return;
    }
    setOpenId(snapshot.id);
    setCompare(null);
    setConfirming(false);
    const payload = await call("/api/omniflow/portal/snapshots/" + snapshot.id, { method: "GET" });
    const areas = (payload?.snapshot as { compare?: CompareArea[] } | undefined)?.compare ?? [];
    setCompare(areas);
    setChosen(areas.filter((area) => area.inSnapshot && area.changes.length).map((area) => area.key));
  }

  async function restore(snapshot: Snapshot) {
    const payload = await call("/api/omniflow/portal/snapshots/" + snapshot.id + "/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ areas: chosen }),
    });
    setConfirming(false);
    if (!payload) return;
    const areas = (payload.areas as { label: string; status: string }[] | undefined) ?? [];
    setNote(
      "Restored: " +
        (areas.filter((area) => area.status === "restored").map((area) => area.label).join(", ") ||
          "nothing changed") +
        ". A backup of the previous settings was saved, so this can be undone."
    );
    setOpenId(null);
    void load();
  }

  async function remove(snapshot: Snapshot) {
    const payload = await call("/api/omniflow/portal/snapshots/" + snapshot.id, {
      method: "DELETE",
    });
    if (!payload) return;
    setOpenId(null);
    void load();
  }

  const labels = Object.fromEntries((data?.areas ?? []).map((area) => [area.key, area.label]));

  return (
    <section id="config-history" className="mt-6 scroll-mt-6 rounded-2xl border border-line bg-white p-5 shadow-card">
      <h2 className="text-sm font-medium text-ink">Configuration history</h2>
      <p className="mt-0.5 text-xs text-ink-3">
        A snapshot of your bot, business profile, AI brain, facts and approval
        settings is saved automatically before changes
        {data ? " (at most one every " + data.autoMinutes + " min)" : ""}. Compare
        any snapshot with today and restore it if a change went wrong. API keys
        and passwords are never stored in snapshots.
      </p>

      {data?.canRestore ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name (optional), e.g. Before Eid sale"
            aria-label="Snapshot name"
            className="w-72 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className={button + " border-brand/30 bg-brand-soft text-brand"}
          >
            Save snapshot now
          </button>
        </div>
      ) : null}
      {note ? <p className="mt-2 text-[11px] text-ink-2">{note}</p> : null}

      {data && data.snapshots.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          No snapshots yet - the first one is taken the next time you save a setting.
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-line">
        {(data?.snapshots ?? []).map((snapshot) => (
          <li key={snapshot.id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-ink">
                {snapshot.label || "Snapshot #" + snapshot.id}
              </span>
              <span className="rounded-full border border-line bg-soft px-2 py-0.5 text-[10px] text-ink-3">
                {snapshot.reasonLabel}
              </span>
              <span className="text-[11px] text-ink-3">
                {when(snapshot.createdAt)}
                {snapshot.createdBy ? " · " + snapshot.createdBy : ""}
              </span>
              <button
                type="button"
                onClick={() => void open(snapshot)}
                className="ml-auto text-[11px] font-medium text-brand hover:underline"
              >
                {openId === snapshot.id ? "Close" : "Compare"}
              </button>
            </div>

            {openId === snapshot.id ? (
              <div className="mt-2 rounded-xl border border-line bg-soft p-3">
                {compare === null ? (
                  <p className="text-[11px] text-ink-3">Comparing with your current settings...</p>
                ) : (
                  <>
                    {compare.filter((area) => area.inSnapshot).map((area) => (
                      <div key={area.key} className="mb-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-ink">
                          {data?.canRestore ? (
                            <input
                              type="checkbox"
                              disabled={!area.changes.length}
                              checked={chosen.includes(area.key)}
                              onChange={(event) =>
                                setChosen((current) =>
                                  event.target.checked
                                    ? [...current, area.key]
                                    : current.filter((key) => key !== area.key)
                                )
                              }
                            />
                          ) : null}
                          {labels[area.key] || area.label}
                          <span className="font-normal text-ink-3">
                            {area.changes.length
                              ? area.changes.length + " difference" + (area.changes.length > 1 ? "s" : "")
                              : "same as now"}
                          </span>
                        </label>
                        {area.changes.slice(0, 8).map((change, index) => (
                          <p key={index} className="ml-6 mt-0.5 text-[11px] text-ink-2">
                            <span className="text-ink">{change.field}</span>: now &ldquo;
                            {change.current || "empty"}&rdquo; ◈ snapshot &ldquo;
                            {change.snapshot || "empty"}&rdquo;
                          </p>
                        ))}
                        {area.changes.length > 8 ? (
                          <p className="ml-6 text-[11px] text-ink-3">
                            and {area.changes.length - 8} more
                          </p>
                        ) : null}
                      </div>
                    ))}
                    {data?.canRestore ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {confirming ? (
                          <>
                            <span className="text-[11px] text-ink-2">
                              Restore {chosen.map((key) => labels[key] || key).join(", ")}? Your
                              current settings are backed up first.
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void restore(snapshot)}
                              className={button + " border-danger/30 bg-white text-danger"}
                            >
                              Yes, restore
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(false)}
                              className={button + " border-line text-ink-2"}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busy || chosen.length === 0}
                            onClick={() => setConfirming(true)}
                            className={button + " border-brand/30 bg-brand-soft text-brand"}
                          >
                            Restore selected
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(snapshot)}
                          className="ml-auto text-[11px] text-ink-3 hover:text-danger"
                        >
                          Delete snapshot
                        </button>
                      </div>
                    ) : (
                      <p className="text-[11px] text-ink-3">
                        Only the workspace owner or an admin can restore.
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
