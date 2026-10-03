"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminVaultReport } from "../../../../lib/omniflow/admin-control-plane";

// §223 Secrets vault: shows whether stored provider credentials are encrypted
// at rest and lets the admin encrypt legacy plaintext rows. The encryption key
// itself is env-only (OF_SECRETS_KEY on the Control Plane) and never sent here.

const ENDPOINT = "/api/omniflow/admin/security/vault";

function problemText(report: AdminVaultReport): string {
  const s = report.status;
  if (s.problem === "library_missing") {
    return "The Control Plane is missing its encryption library. Redeploy it so requirements.txt (cryptography) is installed.";
  }
  if (s.problem === "key_too_short") {
    return "OF_SECRETS_KEY is shorter than " + s.min_key_chars + " characters, so encryption is off. Replace it with a longer key and redeploy.";
  }
  if (s.problem === "key_missing") {
    return "Stored keys are not encrypted yet. Add OF_SECRETS_KEY (" + s.min_key_chars + "+ characters) to the Control Plane environment, redeploy, then press Encrypt stored secrets.";
  }
  return "";
}

function newKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = "";
  bytes.forEach((b) => {
    raw += String.fromCharCode(b);
  });
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function SecretsVaultCard() {
  const [report, setReport] = useState<AdminVaultReport | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [generated, setGenerated] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setLoadError(payload?.error?.message || "Could not read the encryption status.");
        return;
      }
      setReport(payload as AdminVaultReport);
    } catch {
      setLoadError("Could not read the encryption status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function encrypt() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT + "/migrate", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice({ ok: false, text: payload?.error?.message || "Could not encrypt — try again." });
        return;
      }
      const next = payload as AdminVaultReport;
      setReport(next);
      const done = next.totals.resealed;
      setNotice({
        ok: true,
        text:
          (done ? done + " stored secret(s) encrypted." : "Nothing left to encrypt.") +
          (next.remaining > 0 ? " " + next.remaining + " remaining — press again." : ""),
      });
    } catch {
      setNotice({ ok: false, text: "Could not encrypt — try again." });
    } finally {
      setBusy(false);
    }
  }

  const status = report?.status;
  const totals = report?.totals;
  const pending = totals ? totals.plain + totals.old_key : 0;
  const areas = (report?.areas || []).filter(
    (a) => a.present && (a.error !== "" || a.plain + a.sealed + a.old_key + a.unreadable > 0)
  );
  const badge = !report
    ? { text: "Checking", cls: "border-line bg-soft text-ink-3" }
    : !status?.configured
      ? { text: "Not encrypted", cls: "border-warn/30 bg-warn-soft text-ink-2" }
      : pending > 0 || (totals?.unreadable || 0) > 0
        ? { text: "Action needed", cls: "border-warn/30 bg-warn-soft text-ink-2" }
        : { text: "Encrypted at rest", cls: "border-ok/25 bg-ok-soft text-ok" };

  return (
    <div className="mb-6 rounded-2xl border border-line bg-white p-6 shadow-card">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Secrets encryption</h2>
        <span className={"rounded-md border px-2 py-0.5 text-[10px] " + badge.cls}>{badge.text}</span>
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Provider keys, tokens and webhook secrets are stored encrypted (AES-256-GCM) with a key that
        lives only in the Control Plane environment. Values are never shown here.
      </p>

      {loadError ? <p className="text-xs text-danger">{loadError}</p> : null}

      {report && status ? (
        <>
          {status.configured ? (
            <p className="text-xs text-ink-2">
              Active key <span className="font-mono">{status.key_id}</span>
              {status.old_key_ids.length
                ? " · previous key(s) " + status.old_key_ids.join(", ") + " still accepted for reading"
                : ""}
              .
            </p>
          ) : (
            <p className="text-xs text-ink-2">{problemText(report)}</p>
          )}

          {areas.length ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-line">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-soft text-ink-3">
                  <tr>
                    <th className="px-3 py-2 font-medium">Area</th>
                    <th className="px-3 py-2 font-medium">Encrypted</th>
                    <th className="px-3 py-2 font-medium">Not encrypted</th>
                    <th className="px-3 py-2 font-medium">Old key</th>
                    <th className="px-3 py-2 font-medium">Unreadable</th>
                  </tr>
                </thead>
                <tbody>
                  {areas.map((a) => (
                    <tr key={a.table} className="border-t border-line text-ink-2">
                      <td className="px-3 py-2">
                        {a.label}
                        {a.error ? <span className="ml-1 text-danger">(could not read)</span> : null}
                      </td>
                      <td className="px-3 py-2">{a.sealed}</td>
                      <td className="px-3 py-2">{a.plain}</td>
                      <td className="px-3 py-2">{a.old_key}</td>
                      <td className={"px-3 py-2 " + (a.unreadable ? "text-danger" : "")}>{a.unreadable}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-ink-3">No stored secrets yet.</p>
          )}

          {totals && totals.unreadable > 0 ? (
            <p className="mt-3 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2 text-[11px] text-danger">
              {totals.unreadable} stored secret(s) cannot be opened with the current key. If the key was
              changed, put the previous one in OF_SECRETS_KEY_OLD and redeploy; otherwise re-enter those
              credentials.
            </p>
          ) : null}
        </>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void encrypt()}
          disabled={busy || !status?.configured || pending === 0}
          className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors disabled:opacity-50"
        >
          {busy ? "Encrypting…" : "Encrypt stored secrets"}
        </button>
        <button
          onClick={() => setGenerated(newKey())}
          className="rounded-xl border border-line bg-white px-4 py-2 text-xs text-ink-2 shadow-card transition-colors hover:bg-soft"
        >
          Generate a key
        </button>
        <button
          onClick={() => void load()}
          className="rounded-xl border border-line bg-white px-4 py-2 text-xs text-ink-2 shadow-card transition-colors hover:bg-soft"
        >
          Refresh
        </button>
        {notice ? (
          <span className={"text-[11px] " + (notice.ok ? "text-ok" : "text-danger")}>{notice.text}</span>
        ) : null}
      </div>

      {generated ? (
        <div className="mt-4 rounded-xl border border-line bg-soft p-3">
          <span className="mb-1 block text-[11px] font-medium text-ink-2">
            New key (made in this browser, not sent anywhere)
          </span>
          <input
            readOnly
            value={generated}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink"
          />
          <span className="mt-2 block text-[10px] text-ink-3">
            Set it as OF_SECRETS_KEY on the Control Plane and keep a copy in your password manager. If
            this key is lost, encrypted credentials cannot be recovered and must be re-entered. To
            rotate, move the current key to OF_SECRETS_KEY_OLD first.
          </span>
        </div>
      ) : null}
    </div>
  );
}
