// Omniflow batch 206-210 — night guard: quiet hours for sequence auto-sends.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_206_210.mjs
// CP:  lazy portal_sequence_settings (client_id PK, quiet_enabled FALSE, quiet_start 22,
//      quiet_end 8, utc_offset 5); GET/PUT /api/v1/portal/sequences/settings (human
//      guarded, hours 0-23 ints, offset -12..+14, upsert + audit sequence.quiet_updated);
//      deliver_due_sequence_steps skips the whole poll with ONE NOT EXISTS clause while
//      the merchant's local hour (UTC + offset, wrap-aware, start==end = no-op) is inside
//      the pause window - no worker changes, missed sends fire right after the window.
// Web: portal.ts SequenceSettings + get/saveSequenceSettings (snake on the wire);
//      BFF sequences/settings route (SIX ../) validating integers client-side; sequences
//      page "Night guard" card: On/Off checkbox, Pause-from/to hour dropdowns, UTC offset
//      dropdown defaulting to UTC+5 (Pakistan), Save.
// Tests (rig, not this patcher): test_quiet_hours.py (42 checks); the five sequences
// suites gained the settings DDL slot (pins shifted +1).
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b206210.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b206210.bak";
let applied = 0;
let already = 0;
let warnings = 0;

function compilePython(pathArg) {
  const { spawnSync } = require("child_process");
  for (const py of ["python3", "python", "py"]) {
    const probe = spawnSync(py, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const check = spawnSync(py, ["-c", "import sys;sys.exit(0 if sys.version_info[0]>=3 else 1)"], { encoding: "utf8" });
    if (check.status !== 0) continue;
    const result = spawnSync(py, ["-c", "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True);sys.exit(0)", pathArg], { encoding: "utf8" });
    return result.status === 0;
  }
  console.log("  (python not found — skipped compile guard)");
  return true;
}

function applySwaps(repoPath, marker, isCp, swaps) {
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
  if (isCp && !compilePython(repoPath)) {
    fs.copyFileSync(backup, repoPath);
    console.log("FAIL (compile failed, restored): " + repoPath);
    warnings++;
    return;
  }
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


applySwaps("OmniFlow-Control-Plane/portal_sequences.py", "update_sequence_settings", true, [
  ["ENROLLMENTS_TABLE = \"portal_sequence_enrollments\"\nMAX_STEPS = 5\n",
   "ENROLLMENTS_TABLE = \"portal_sequence_enrollments\"\nSETTINGS_TABLE = \"portal_sequence_settings\"\nMAX_STEPS = 5\n"],
  ["            \" ADD COLUMN IF NOT EXISTS trigger_keyword TEXT\"\n        )\n",
   "            \" ADD COLUMN IF NOT EXISTS trigger_keyword TEXT\"\n        )\n        cur.execute(\n            \"CREATE TABLE IF NOT EXISTS \" + portal_db._q(SETTINGS_TABLE) +\n            \" (client_id BIGINT PRIMARY KEY,\"\n            \" quiet_enabled BOOLEAN NOT NULL DEFAULT FALSE,\"\n            \" quiet_start INT NOT NULL DEFAULT 22,\"\n            \" quiet_end INT NOT NULL DEFAULT 8,\"\n            \" utc_offset INT NOT NULL DEFAULT 5)\"\n        )\n"],
  ["    return jsonify({\"sequences\": result}), 200\n\n",
   "    return jsonify({\"sequences\": result}), 200\n\n\n@bp.get(\"/sequences/settings\")\ndef get_sequence_settings():\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_seq_tables(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"SELECT quiet_enabled, quiet_start, quiet_end, utc_offset FROM \" +\n                    portal_db._q(SETTINGS_TABLE) +\n                    \" WHERE client_id = %s\",\n                    (principal[\"client_id\"],),\n                )\n                rows = portal_db.rows(cur)\n        finally:\n            conn.close()\n    except Exception as error:\n        return jsonify(portal_db.portal_unavailable(error, \"settings read\")[0]), 503\n    row = rows[0] if rows else {}\n    return jsonify({\n        \"quiet_enabled\": row.get(\"quiet_enabled\") is True,\n        \"quiet_start\": int(row.get(\"quiet_start\") if row.get(\"quiet_start\") is not None else 22),\n        \"quiet_end\": int(row.get(\"quiet_end\") if row.get(\"quiet_end\") is not None else 8),\n        \"utc_offset\": int(row.get(\"utc_offset\") if row.get(\"utc_offset\") is not None else 5),\n    }), 200\n\n\n@bp.put(\"/sequences/settings\")\ndef update_sequence_settings():\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    forbidden = ensure_human_principal(principal)\n    if forbidden is not None:\n        return forbidden\n    payload = request.get_json(silent=True) or {}\n    enabled = payload.get(\"quiet_enabled\")\n    if not isinstance(enabled, bool):\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"quiet_enabled must be true or false.\"}}), 400\n\n    def _hour(value):\n        if isinstance(value, bool) or not isinstance(value, int):\n            return None\n        return value if 0 <= value <= 23 else None\n\n    start = _hour(payload.get(\"quiet_start\"))\n    end = _hour(payload.get(\"quiet_end\"))\n    if start is None or end is None:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"Hours must be integers from 0 to 23.\"}}), 400\n    offset = payload.get(\"utc_offset\")\n    if isinstance(offset, bool) or not isinstance(offset, int) or not -12 <= offset <= 14:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"UTC offset must be between -12 and +14.\"}}), 400\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_seq_tables(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"INSERT INTO \" + portal_db._q(SETTINGS_TABLE) +\n                    \" (client_id, quiet_enabled, quiet_start, quiet_end, utc_offset)\"\n                    \" VALUES (%s, %s, %s, %s, %s)\"\n                    \" ON CONFLICT (client_id) DO UPDATE SET\"\n                    \" quiet_enabled = %s, quiet_start = %s, quiet_end = %s,\"\n                    \" utc_offset = %s\",\n                    (principal[\"client_id\"], enabled, start, end, offset,\n                     enabled, start, end, offset),\n                )\n                portal_db.log_action(\n                    cur,\n                    principal[\"client_id\"],\n                    \"sequence.quiet_updated\",\n                    \"customer_user\",\n                    principal.get(\"user_id\"),\n                    None,\n                    \"Night guard %s (%02d:00-%02d:00 UTC%+d).\" % (\n                        \"on\" if enabled else \"off\", start, end, offset),\n                )\n            conn.commit()\n        finally:\n            conn.close()\n    except Exception as error:\n        return jsonify(portal_db.portal_unavailable(error, \"settings update\")[0]), 503\n    return jsonify({\"ok\": True}), 200\n\n"],
  ["            \" ORDER BY e.next_at LIMIT 5\",\n            (client_id,),\n",
   "            \" AND NOT EXISTS (\"\n            \" SELECT 1 FROM \" + portal_db._q(SETTINGS_TABLE) + \" q\"\n            \" WHERE q.client_id = %s AND q.quiet_enabled IS TRUE\"\n            \" AND ((q.quiet_start < q.quiet_end\"\n            \" AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)\"\n            \" % 24 >= q.quiet_start\"\n            \" AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)\"\n            \" % 24 < q.quiet_end)\"\n            \" OR (q.quiet_start > q.quiet_end\"\n            \" AND ((EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)\"\n            \" % 24 >= q.quiet_start\"\n            \" OR (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)\"\n            \" % 24 < q.quiet_end)))\"\n            \" ORDER BY e.next_at LIMIT 5\",\n            (client_id, client_id),\n"]
]);


applySwaps("Omniflow/lib/omniflow/portal.ts", "saveSequenceSettings", false, [
  ["\nexport async function deleteSequence(\n",
   "\nexport interface SequenceSettings {\n  quietEnabled: boolean;\n  quietStart: number;\n  quietEnd: number;\n  utcOffset: number;\n}\n\nexport async function getSequenceSettings(\n  accessToken: string\n): Promise<SequenceSettings | null> {\n  let response: Response;\n  try {\n    response = await portalRequest(accessToken, \"api/v1/portal/sequences/settings\");\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 404 || response.status === 501) return null;\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return null;\n  const payload: unknown = await response.json().catch(() => null);\n  if (payload === null || typeof payload !== \"object\") return null;\n  const row = payload as Record<string, unknown>;\n  return {\n    quietEnabled: row.quiet_enabled === true,\n    quietStart: typeof row.quiet_start === \"number\" ? row.quiet_start : 22,\n    quietEnd: typeof row.quiet_end === \"number\" ? row.quiet_end : 8,\n    utcOffset: typeof row.utc_offset === \"number\" ? row.utc_offset : 5,\n  };\n}\n\nexport async function saveSequenceSettings(\n  accessToken: string,\n  settings: SequenceSettings\n): Promise<SequenceMutation> {\n  let response: Response;\n  try {\n    response = await portalRequest(accessToken, \"api/v1/portal/sequences/settings\", {\n      method: \"PUT\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({\n        quiet_enabled: settings.quietEnabled,\n        quiet_start: settings.quietStart,\n        quiet_end: settings.quietEnd,\n        utc_offset: settings.utcOffset,\n      }),\n    });\n  } catch (error) {\n    assertNotAuthError(error);\n    return { kind: \"unavailable\" };\n  }\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (response.status === 400) return { kind: \"invalid\" };\n  if (!response.ok) return { kind: \"unavailable\" };\n  return { kind: \"ok\" };\n}\n\nexport async function deleteSequence(\n"]
]);


applySwaps("Omniflow/app/dashboard/(portal)/sequences/page.tsx", "Night guard", false, [
  ["  const [editNote, setEditNote] = useState<string | null>(null);\n\n",
   "  const [editNote, setEditNote] = useState<string | null>(null);\n  const [quiet, setQuiet] = useState<{\n    enabled: boolean;\n    start: number;\n    end: number;\n    offset: number;\n  } | null>(null);\n  const [quietBusy, setQuietBusy] = useState(false);\n  const [quietNote, setQuietNote] = useState<string | null>(null);\n\n  const hourLabel = (hour: number) => {\n    const period = hour < 12 ? \"AM\" : \"PM\";\n    const display = hour % 12 === 0 ? 12 : hour % 12;\n    return display + \":00 \" + period;\n  };\n\n"],
  ["    }\n  }, []);\n",
   "    }\n    fetch(\"/api/omniflow/portal/sequences/settings\", { cache: \"no-store\" })\n      .then((response) => response.json().catch(() => null))\n      .then((payload) => {\n        const row =\n          payload !== null && typeof payload === \"object\"\n            ? (payload as {\n                settings?: {\n                  quiet_enabled?: boolean;\n                  quiet_start?: number;\n                  quiet_end?: number;\n                  utc_offset?: number;\n                } | null;\n              })\n            : null;\n        if (row && row.settings) {\n          setQuiet({\n            enabled: row.settings.quiet_enabled === true,\n            start:\n              typeof row.settings.quiet_start === \"number\"\n                ? row.settings.quiet_start\n                : 22,\n            end:\n              typeof row.settings.quiet_end === \"number\" ? row.settings.quiet_end : 8,\n            offset:\n              typeof row.settings.utc_offset === \"number\" ? row.settings.utc_offset : 5,\n          });\n        }\n      })\n      .catch(() => undefined);\n  }, []);\n"],
  ["    setNote(\"Template loaded \\u2014 edit anything, then Create series.\");\n  };\n\n  const create = useCallback(async () => {\n",
   "    setNote(\"Template loaded \\u2014 edit anything, then Create series.\");\n  };\n\n  const saveQuiet = useCallback(async () => {\n    if (quietBusy || !quiet) return;\n    setQuietBusy(true);\n    setQuietNote(null);\n    try {\n      const response = await fetch(\"/api/omniflow/portal/sequences/settings\", {\n        method: \"PUT\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({\n          quietEnabled: quiet.enabled,\n          quietStart: quiet.start,\n          quietEnd: quiet.end,\n          utcOffset: quiet.offset,\n        }),\n      });\n      setQuietNote(\n        response.ok\n          ? \"Send window saved.\"\n          : \"Could not save. Check the hours and offset.\"\n      );\n    } catch {\n      setQuietNote(\"Could not save. Try again.\");\n    } finally {\n      setQuietBusy(false);\n    }\n  }, [quietBusy, quiet]);\n\n  const create = useCallback(async () => {\n"],
  ["\n        {sequences === null ? (\n",
   "\n        <div className=\"rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5\">\n          <div className=\"flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between\">\n            <div>\n              <p className=\"text-sm font-medium text-slate-200\">Night guard</p>\n              <p className=\"mt-0.5 text-[11px] text-slate-500\">\n                Pause automatic series messages during these hours so nobody gets woken\n                up. Replies you send by hand are never blocked.\n              </p>\n            </div>\n            <label className=\"flex shrink-0 cursor-pointer items-center gap-2 text-xs text-slate-300\">\n              <input\n                type=\"checkbox\"\n                checked={quiet ? quiet.enabled : false}\n                onChange={(event) =>\n                  setQuiet((current) =>\n                    current ? { ...current, enabled: event.target.checked } : current\n                  )\n                }\n                className=\"h-4 w-4 accent-cyan-400\"\n              />\n              {quiet && quiet.enabled ? \"On\" : \"Off\"}\n            </label>\n          </div>\n          {quiet ? (\n            <div className=\"mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-300\">\n              <span className=\"text-slate-500\">Pause from</span>\n              <select\n                value={quiet.start}\n                onChange={(event) =>\n                  setQuiet((current) =>\n                    current ? { ...current, start: Number(event.target.value) } : current\n                  )\n                }\n                className=\"rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400/40\"\n              >\n                {Array.from({ length: 24 }, (_, hour) => (\n                  <option key={hour} value={hour} className=\"bg-slate-900\">\n                    {hourLabel(hour)}\n                  </option>\n                ))}\n              </select>\n              <span className=\"text-slate-500\">to</span>\n              <select\n                value={quiet.end}\n                onChange={(event) =>\n                  setQuiet((current) =>\n                    current ? { ...current, end: Number(event.target.value) } : current\n                  )\n                }\n                className=\"rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400/40\"\n              >\n                {Array.from({ length: 24 }, (_, hour) => (\n                  <option key={hour} value={hour} className=\"bg-slate-900\">\n                    {hourLabel(hour)}\n                  </option>\n                ))}\n              </select>\n              <span className=\"text-slate-500\">\\u00b7 your time zone</span>\n              <select\n                value={quiet.offset}\n                onChange={(event) =>\n                  setQuiet((current) =>\n                    current ? { ...current, offset: Number(event.target.value) } : current\n                  )\n                }\n                className=\"rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400/40\"\n              >\n                {Array.from({ length: 27 }, (_, index) => index - 12).map((offset) => (\n                  <option key={offset} value={offset} className=\"bg-slate-900\">\n                    UTC{offset >= 0 ? \"+\" : \"\"}\n                    {offset}\n                    {offset === 5 ? \" (Pakistan)\" : \"\"}\n                  </option>\n                ))}\n              </select>\n              <button\n                type=\"button\"\n                onClick={() => void saveQuiet()}\n                disabled={quietBusy}\n                className=\"rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50\"\n              >\n                {quietBusy ? \"Saving...\" : \"Save\"}\n              </button>\n              {quietNote ? <p className=\"text-xs text-amber-300\">{quietNote}</p> : null}\n            </div>\n          ) : (\n            <p className=\"mt-3 text-xs text-slate-600\">Loading window\\u2026</p>\n          )}\n        </div>\n\n        {sequences === null ? (\n"]
]);


writeNew("Omniflow/app/api/omniflow/portal/sequences/settings/route.ts", "saveSequenceSettings",
"import {\n  getSequenceSettings,\n  requirePortalAccessToken,\n  saveSequenceSettings,\n} from \"../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../lib/omniflow/control-plane\";\n\n\nexport async function GET() {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  try {\n    const settings = await getSequenceSettings(accessToken);\n    return safeJson({ settings }, 200);\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n\nexport async function PUT(request: Request) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const payload: unknown = await request.json().catch(() => null);\n  const input =\n    payload !== null && typeof payload === \"object\"\n      ? (payload as Record<string, unknown>)\n      : {};\n  const quietEnabled = input.quietEnabled === true;\n  const quietStart = Number(input.quietStart);\n  const quietEnd = Number(input.quietEnd);\n  const utcOffset = Number(input.utcOffset);\n  if (\n    !Number.isInteger(quietStart) ||\n    quietStart < 0 ||\n    quietStart > 23 ||\n    !Number.isInteger(quietEnd) ||\n    quietEnd < 0 ||\n    quietEnd > 23 ||\n    !Number.isInteger(utcOffset) ||\n    utcOffset < -12 ||\n    utcOffset > 14\n  ) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"Invalid send-window values.\" } },\n      400\n    );\n  }\n\n  try {\n    const result = await saveSequenceSettings(accessToken, {\n      quietEnabled,\n      quietStart,\n      quietEnd,\n      utcOffset,\n    });\n    if (result.kind === \"ok\") {\n      return safeJson({ ok: true }, 200);\n    }\n    if (result.kind === \"invalid\") {\n      return safeJson(\n        { error: { code: \"bad_request\", message: \"Invalid send-window values.\" } },\n        400\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");