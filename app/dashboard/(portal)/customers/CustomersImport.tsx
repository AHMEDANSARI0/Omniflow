"use client";

import { useCallback, useRef, useState } from "react";

interface ImportResult {
  created: number;
  merged: number;
  invalid: { row: number; reason: string }[];
  invalid_count: number;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      current.push(field);
      field = "";
    } else if (ch === "\n") {
      current.push(field.replace(/\r$/, ""));
      field = "";
      if (current.some((cell) => cell.trim().length > 0)) rows.push(current);
      current = [];
    } else {
      field += ch;
    }
  }
  current.push(field.replace(/\r$/, ""));
  if (current.some((cell) => cell.trim().length > 0)) rows.push(current);
  return rows;
}

export default function CustomersImport({
  onImported,
}: {
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ name: string; phone: string }[]>([]);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setNote("");
    setResult(null);
    setFileName(file.name);
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setNoteTone("amber");
      setNote("The file needs a header row plus at least one customer.");
      setPreview([]);
      return;
    }
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    let phoneIdx = header.findIndex((cell) => /phone|number|mobile|whats/.test(cell));
    let nameIdx = header.findIndex((cell) => /name|naam/.test(cell));
    if (phoneIdx === -1 && header.length >= 2) {
      nameIdx = 0;
      phoneIdx = 1;
    } else if (phoneIdx === -1) {
      phoneIdx = 0;
      nameIdx = -1;
    }
    const mapped = rows
      .slice(1)
      .map((row) => ({
        name: nameIdx >= 0 ? (row[nameIdx] || "").trim() : "",
        phone: (row[phoneIdx] || "").trim(),
      }))
      .filter((row) => row.phone.length > 0);
    if (mapped.length === 0) {
      setNoteTone("amber");
      setNote("No phone numbers found in the file.");
      setPreview([]);
      return;
    }
    if (mapped.length > 300) {
      setNoteTone("amber");
      setNote(mapped.length + " rows found - only the first 300 import per request.");
    }
    setPreview(mapped.slice(0, 300));
  }, []);

  const submit = useCallback(async () => {
    if (preview.length === 0) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/customers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customers: preview }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || payload === null || typeof payload !== "object") {
        setNoteTone("amber");
        setNote("Import failed. Try again shortly.");
        return;
      }
      const summary = payload as ImportResult;
      setResult(summary);
      setNoteTone("emerald");
      setNote(
        "Imported: " + summary.created + " new, " + summary.merged + " merged"
        + (summary.invalid_count > 0 ? ", " + summary.invalid_count + " invalid" : "")
        + "."
      );
      onImported?.();
    } catch {
      setNoteTone("amber");
      setNote("Import failed. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }, [preview, onImported]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setNote("");
          setResult(null);
          setPreview([]);
          setFileName("");
          if (fileRef.current) fileRef.current.value = "";
        }}
        className="ml-auto rounded-lg border border-line bg-soft px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors duration-300 hover:text-ink"
      >
        Import CSV
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-soft p-4"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-5">
            <h2 className="text-sm font-semibold text-ink">Import customers</h2>
            <p className="mt-1 text-xs text-ink-3">
              Pick a CSV with name and phone columns. Pakistani numbers in any
              format work (0300…, 92 300…, +92 300…). Up to 300 per import.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
              className="mt-3 block w-full cursor-pointer rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink-2 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-cyan-400/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-brand"
            />
            {fileName ? (
              <p className="mt-1.5 text-[11px] text-ink-3">
                {fileName} - {preview.length} customer{preview.length === 1 ? "" : "s"} ready.
              </p>
            ) : null}

            {preview.length > 0 ? (
              <ul className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-line bg-soft p-2.5">
                {preview.slice(0, 8).map((row, index) => (
                  <li key={String(index)} className="flex justify-between gap-2 text-[11px] text-ink-3">
                    <span className="truncate">{row.name || "(no name)"}</span>
                    <span className="shrink-0 font-mono">{row.phone}</span>
                  </li>
                ))}
                {preview.length > 8 ? (
                  <li className="text-[11px] text-ink-3">
                    + {preview.length - 8} more
                  </li>
                ) : null}
              </ul>
            ) : null}

            {note ? (
              <p
                className={
                  "mt-3 text-xs " +
                  (noteTone === "emerald" ? "text-ok" : "text-amber-600")
                }
              >
                {note}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || preview.length === 0}
                className="rounded-lg bg-cyan-400/15 px-4 py-1.5 text-xs font-medium text-brand transition hover:bg-cyan-400/25 disabled:opacity-40"
              >
                {busy ? "Importing\u2026" : "Import " + preview.length}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
