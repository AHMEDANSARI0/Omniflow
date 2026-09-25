"use client";

import { useCallback, useEffect, useState } from "react";

interface CouponRow {
  id: number;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  minTotal: number;
  usageLimit: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
}

function couponValue(row: CouponRow): string {
  return row.kind === "percent" ? row.value + "%" : "Rs " + row.value;
}

function expiryLabel(row: CouponRow): string {
  if (!row.expiresAt) return "No expiry";
  try {
    return "Until " + new Date(row.expiresAt).toLocaleDateString();
  } catch {
    return "Until " + row.expiresAt;
  }
}

export default function CouponsCard() {
  const [rows, setRows] = useState<CouponRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/coupons", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as {
        coupons?: CouponRow[];
      } | null;
      if (payload && Array.isArray(payload.coupons)) setRows(payload.coupons);
    } catch {
      // transient - the list can be reloaded
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (busy) return;
    const parsedValue = parseFloat(value);
    if (!code.trim() || !Number.isFinite(parsedValue)) {
      setNote("Enter a code (3-24 letters/numbers) and a numeric value.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          kind,
          value: parsedValue,
          min_total: minTotal.trim() ? parseFloat(minTotal) : 0,
          usage_limit: usageLimit.trim() ? parseInt(usageLimit, 10) : null,
          expires_in_days: expiresDays.trim() ? parseInt(expiresDays, 10) : null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(payload?.error?.message || "Could not create the coupon.");
        return;
      }
      setCode("");
      setValue("");
      setMinTotal("");
      setUsageLimit("");
      setExpiresDays("");
      setNote("Coupon created.");
      await load();
    } catch {
      setNote("Could not create the coupon - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(row: CouponRow, isActive: boolean) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/coupons/" + String(row.id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: isActive }),
        }
      );
      if (!response.ok) {
        setNote("Could not update the coupon.");
        return;
      }
      await load();
    } catch {
      setNote("Could not update the coupon - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: CouponRow) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/coupons/" + String(row.id),
        { method: "DELETE" }
      );
      if (!response.ok) {
        setNote("Could not remove the coupon.");
        return;
      }
      setNote("Coupon removed.");
      await load();
    } catch {
      setNote("Could not remove the coupon - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-soft p-5">
      <h2 className="text-sm font-semibold text-ink">Coupon codes</h2>
      <p className="mt-1 text-xs text-ink-3">
        Discount codes your customers apply on the order page. Percent codes
        take 1-90%; fixed codes are rupee amounts. Usage counts update every
        time a customer applies one.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_8rem_8rem]">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="CODE (e.g. EID25)"
          maxLength={24}
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs uppercase text-ink outline-none focus:border-brand/40"
        />
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === "fixed" ? "fixed" : "percent")
          }
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
        >
          <option value="percent">% off</option>
          <option value="fixed">Rs off</option>
        </select>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={kind === "percent" ? "Value (1-90)" : "Amount"}
          inputMode="decimal"
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
        />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem_8rem_auto]">
        <input
          value={minTotal}
          onChange={(event) => setMinTotal(event.target.value)}
          placeholder="Min order (optional)"
          inputMode="decimal"
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
        />
        <input
          value={usageLimit}
          onChange={(event) => setUsageLimit(event.target.value)}
          placeholder="Max uses"
          inputMode="numeric"
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
        />
        <input
          value={expiresDays}
          onChange={(event) => setExpiresDays(event.target.value)}
          placeholder="Days valid"
          inputMode="numeric"
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="rounded-xl bg-cyan-400 px-4 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Create coupon
        </button>
      </div>

      {note ? <p className="mt-2 text-[11px] text-amber-600">{note}</p> : null}

      <div className="mt-4">
        {loaded && rows.length === 0 ? (
          <p className="text-xs text-ink-3">
            No coupons yet — create your first code above.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-line bg-soft px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-ink">
                    <span className="font-semibold">{row.code}</span> ·{" "}
                    {couponValue(row)}
                    {row.minTotal > 0 ? " · min " + row.minTotal : ""}
                  </p>
                  <p className="truncate text-[10px] text-ink-3">
                    {expiryLabel(row)} · used {row.usedCount}
                    {row.usageLimit !== null ? "/" + row.usageLimit : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span
                    className={
                      "rounded-md border px-1.5 py-0.5 text-[10px] " +
                      (row.isActive
                        ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                        : "border-line bg-soft text-ink-3")
                    }
                  >
                    {row.isActive ? "Active" : "Paused"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void setActive(row, !row.isActive)}
                    disabled={busy}
                    className="rounded-lg border border-line px-2 py-1 text-[10px] text-ink-2 hover:bg-white/[0.06] disabled:opacity-50"
                  >
                    {row.isActive ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={busy}
                    className="rounded-lg border border-line px-2 py-1 text-[10px] text-ink-3 hover:border-rose-400/40 hover:text-danger disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
