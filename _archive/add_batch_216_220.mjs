// Omniflow batch 216-220 — "Add to series" from the conversation thread.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_216_220.mjs
// WEBSITE ONLY (the enrollments POST endpoint from 176-180 is reused as-is; the INSERT
// already pulls the display name from the conversation row via the join, so the card
// just sends the bare jid).
// NEW AddToSequenceCard.tsx (thread sidebar, after CustomerCard): self-fetches the
// sequences list, keeps only ENABLED series, renders nothing when there are none,
// pick + Add -> POST /api/omniflow/portal/sequences/<id>/enrollments with
// { contacts: [contactId] }; notes: "Added. Step 1 lands per the series' first delay.",
// duplicate -> "Already in a series - no duplicate added.", 400 -> "is the series
// turned on?", stale-response guard, busy state.
// ThreadClient.tsx: dynamic import + guarded render (same !expired && !notFound pattern).
// Tests (rig, not this patcher): test_add_to_series.py (24 checks) - endpoint contract
// pins (jid enroll, name via conv join, dedupe, 404/400) + component/thread/BFF pins.
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b216220.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b216220.bak";
let applied = 0;
let already = 0;
let warnings = 0;

function applySwaps(repoPath, marker, swaps) {
  if (!fs.existsSync(repoPath)) {
    console.log("SKIP (file not found): " + repoPath);
    warnings++;
    return;
  }
  const original = fs.readFileSync(repoPath, "utf8").replace(/\r\n/g, "\n");
  if (original.includes(marker)) {
    console.log("= " + repoPath + " (already patched)");
    already++;
    return;
  }
  const backup = repoPath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
  let updated = original;
  let ok = true;
  for (const [frm, to] of swaps) {
    if (!updated.includes(frm)) {
      console.log("  ? " + repoPath + " :: anchor NOT FOUND — report this");
      ok = false;
      warnings++;
      break;
    }
    updated = updated.replace(frm, to);
  }
  if (!ok) return;
  fs.writeFileSync(repoPath, updated, "utf8");
  console.log("+ " + repoPath + " (" + swaps.length + ")");
  applied++;
}

function writeNew(repoPath, marker, content) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(repoPath, content, "utf8");
    console.log("+ " + repoPath + " (new file)");
    applied++;
    return;
  }
  const original = fs.readFileSync(repoPath, "utf8").replace(/\r\n/g, "\n");
  if (original.includes(marker)) {
    console.log("= " + repoPath + " (already patched)");
    already++;
    return;
  }
  console.log("  ? " + repoPath + " exists WITHOUT marker — report this");
  warnings++;
}


applySwaps("Omniflow/app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx", "AddToSequenceCard", [
  ["const CustomerCard = dynamic(() => import(\"./CustomerCard\"));\nconst SavedRepliesPicker = dynamic(() => import(\"./SavedRepliesPicker\"));\n",
   "const CustomerCard = dynamic(() => import(\"./CustomerCard\"));\nconst AddToSequenceCard = dynamic(() => import(\"./AddToSequenceCard\"));\nconst SavedRepliesPicker = dynamic(() => import(\"./SavedRepliesPicker\"));\n"],
  ["      )}\n      {!expired && !notFound && conversation?.channel !== \"website\" && (\n",
   "      )}\n      {!expired && !notFound && (\n        <AddToSequenceCard contactId={conversation?.contactId ?? null} />\n      )}\n      {!expired && !notFound && conversation?.channel !== \"website\" && (\n"]
]);


writeNew("Omniflow/app/dashboard/(portal)/conversations/[id]/AddToSequenceCard.tsx", "Add to series",
"\"use client\";\n\nimport { useCallback, useEffect, useState } from \"react\";\n\ninterface SequenceOption {\n  id: number;\n  name: string;\n  enabled: boolean;\n}\n\nexport default function AddToSequenceCard({ contactId }: { contactId: string | null }) {\n  const [options, setOptions] = useState<SequenceOption[] | null>(null);\n  const [picked, setPicked] = useState<number | null>(null);\n  const [busy, setBusy] = useState(false);\n  const [message, setMessage] = useState<string | null>(null);\n  const [tone, setTone] = useState(\"neutral\");\n\n  useEffect(() => {\n    if (!contactId) return;\n    let alive = true;\n    fetch(\"/api/omniflow/portal/sequences\", { cache: \"no-store\" })\n      .then((response) => response.json().catch(() => null))\n      .then((payload) => {\n        if (!alive) return;\n        const list =\n          payload !== null && typeof payload === \"object\"\n            ? (payload as { sequences?: SequenceOption[] }).sequences\n            : null;\n        const enabled = (Array.isArray(list) ? list : []).filter(\n          (row) => row && row.enabled === true\n        );\n        setOptions(enabled);\n        setPicked(enabled.length > 0 ? enabled[0].id : null);\n      })\n      .catch(() => {\n        if (alive) setOptions([]);\n      });\n    return () => {\n      alive = false;\n    };\n  }, [contactId]);\n\n  const enroll = useCallback(async () => {\n    if (busy || !contactId || picked === null) return;\n    setBusy(true);\n    setMessage(null);\n    try {\n      const response = await fetch(\n        \"/api/omniflow/portal/sequences/\" + String(picked) + \"/enrollments\",\n        {\n          method: \"POST\",\n          headers: { \"Content-Type\": \"application/json\" },\n          // The endpoint takes bare jids and pulls the display name from the\n          // conversation row itself (contact_name rides the join).\n          body: JSON.stringify({ contacts: [contactId] }),\n        }\n      );\n      const payload = (await response.json().catch(() => null)) as {\n        enrolled?: number;\n        skipped?: string[];\n      } | null;\n      if (response.ok && payload && typeof payload.enrolled === \"number\") {\n        const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;\n        setTone(\"emerald\");\n        setMessage(\n          skipped > 0\n            ? \"Already in a series \\u2014 no duplicate added.\"\n            : \"Added. Step 1 lands per the series' first delay.\"\n        );\n      } else if (response.status === 400) {\n        setTone(\"amber\");\n        setMessage(\"Could not add \\u2014 is the series turned on?\");\n      } else {\n        setTone(\"amber\");\n        setMessage(\"Could not add. Try again.\");\n      }\n    } catch {\n      setTone(\"amber\");\n      setMessage(\"Could not add. Try again.\");\n    } finally {\n      setBusy(false);\n    }\n  }, [busy, contactId, picked]);\n\n  if (!contactId || options === null || options.length === 0) return null;\n\n  return (\n    <div className=\"rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5\">\n      <div className=\"flex items-center justify-between gap-3\">\n        <h2 className=\"text-xs font-semibold text-white\">Add to series</h2>\n      </div>\n      <p className=\"mt-1 text-[11px] text-slate-500\">\n        Start one of your enabled series for this customer right from the chat.\n      </p>\n      <div className=\"mt-3 flex flex-col gap-2 sm:flex-row sm:items-center\">\n        <select\n          value={picked ?? \"\"}\n          onChange={(event) => setPicked(Number(event.target.value) || null)}\n          className=\"w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-xs text-white outline-none focus:border-cyan-400/40 sm:w-auto sm:flex-1\"\n        >\n          {options.map((option) => (\n            <option key={option.id} value={option.id} className=\"bg-slate-900\">\n              {option.name}\n            </option>\n          ))}\n        </select>\n        <button\n          type=\"button\"\n          onClick={() => void enroll()}\n          disabled={busy || picked === null}\n          className=\"shrink-0 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50\"\n        >\n          {busy ? \"Adding...\" : \"Add\"}\n        </button>\n      </div>\n      {message ? (\n        <p\n          className={\n            \"mt-2 text-[11px] \" +\n            (tone === \"emerald\" ? \"text-emerald-300\" : \"text-amber-300\")\n          }\n        >\n          {message}\n        </p>\n      ) : null}\n    </div>\n  );\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");