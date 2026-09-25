// Omniflow batch 201-205 — sequences v2.3: completion stats + enrollment CSV export.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_201_205.mjs
// CP:  list payload gains completed_enrollments per sequence (COUNT status='completed');
//      NEW GET /api/v1/portal/sequences/<id>/enrollments/export — client-scoped CSV
//      attachment (contact_name, contact_id, status, current_step, enrolled_at, <=2000),
//      404 for unknown sequences, csv.writer quoting.
// Web: portal.ts SequenceRow.completedEnrollments + listSequences mapping +
//      exportEnrollmentsCsv client (not_found mapping); NEW BFF
//      sequences/[id]/enrollments/export route (EIGHT ../ per the depth law);
//      sequences page: "N done" in the row subtitle + "People in <name>" header with an
//      Export CSV download link in the People log.
// Tests (rig, not this patcher): test_sequence_stats.py (33 checks); test_sequences list
// script gained the completed-count slot + pin.
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b201205.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b201205.bak";
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


applySwaps("OmniFlow-Control-Plane/portal_sequences.py", "export_sequence_enrollments", true, [
  ["import logging\nfrom typing import Any, Dict, Optional\n\nfrom flask import Blueprint, jsonify, request\n",
   "import csv\nimport io\nimport logging\nfrom typing import Any, Dict, Optional\n\nfrom flask import Blueprint, Response, jsonify, request\n"],
  ["def _sequence_public(row: Dict[str, Any], steps, active_count: int) -> dict:\n",
   "def _sequence_public(row: Dict[str, Any], steps, active_count: int,\n                     completed_count: int = 0) -> dict:\n"],
  ["        \"active_enrollments\": active_count,\n        \"trigger_keyword\": row.get(\"trigger_keyword\") or None,\n",
   "        \"active_enrollments\": active_count,\n        \"completed_enrollments\": completed_count,\n        \"trigger_keyword\": row.get(\"trigger_keyword\") or None,\n"],
  ["                    result.append(_sequence_public(row, steps, active_count))\n",
   "                    cur.execute(\n                        \"SELECT COUNT(*) AS total FROM \" + portal_db._q(ENROLLMENTS_TABLE) +\n                        \" WHERE client_id = %s AND sequence_id = %s AND status = 'completed'\",\n                        (principal[\"client_id\"], row.get(\"id\")),\n                    )\n                    dones = portal_db.rows(cur)\n                    completed_count = int(dones[0].get(\"total\") or 0) if dones else 0\n                    result.append(_sequence_public(row, steps, active_count,\n                                                   completed_count))\n"],
  ["    ]}), 200\n\n",
   "    ]}), 200\n\n\n@bp.get(\"/sequences/<int:sequence_id>/enrollments/export\")\ndef export_sequence_enrollments(sequence_id: int):\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_seq_tables(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"SELECT id, name FROM \" + portal_db._q(SEQUENCES_TABLE) +\n                    \" WHERE id = %s AND client_id = %s\",\n                    (sequence_id, principal[\"client_id\"]),\n                )\n                if not portal_db.rows(cur):\n                    return jsonify({\"error\": {\"code\": \"not_found\",\n                                              \"message\": \"Sequence not found.\"}}), 404\n                cur.execute(\n                    \"SELECT contact_name, contact_id, status, current_step, enrolled_at\"\n                    \" FROM \" + portal_db._q(ENROLLMENTS_TABLE) +\n                    \" WHERE client_id = %s AND sequence_id = %s\"\n                    \" ORDER BY id DESC LIMIT 2000\",\n                    (principal[\"client_id\"], sequence_id),\n                )\n                found = portal_db.rows(cur)\n        finally:\n            conn.close()\n    except Exception as error:\n        return jsonify(portal_db.portal_unavailable(error, \"enrollments export\")[0]), 503\n    buffer = io.StringIO()\n    writer = csv.writer(buffer)\n    writer.writerow([\"contact_name\", \"contact_id\", \"status\", \"current_step\",\n                     \"enrolled_at\"])\n    for row in found:\n        writer.writerow([\n            row.get(\"contact_name\") or \"\",\n            row.get(\"contact_id\") or \"\",\n            row.get(\"status\") or \"active\",\n            int(row.get(\"current_step\") or 0),\n            _iso(row.get(\"enrolled_at\")) or \"\",\n        ])\n    return Response(\n        buffer.getvalue(),\n        mimetype=\"text/csv\",\n        headers={\"Content-Disposition\":\n                 \"attachment; filename=sequence-%d-enrollments.csv\" % sequence_id},\n    )\n\n"]
]);


applySwaps("Omniflow/lib/omniflow/portal.ts", "exportEnrollmentsCsv", false, [
  ["\nexport interface SetupStatus {\n",
   "\nexport type EnrollmentExport =\n  | { kind: \"ok\"; csv: string }\n  | { kind: \"not_found\" }\n  | { kind: \"unavailable\" };\n\nexport async function exportEnrollmentsCsv(\n  accessToken: string,\n  id: number\n): Promise<EnrollmentExport> {\n  let response: Response;\n  try {\n    response = await portalRequest(\n      accessToken,\n      \"api/v1/portal/sequences/\" + String(id) + \"/enrollments/export\"\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return { kind: \"unavailable\" };\n  }\n  if (response.status === 404 || response.status === 501) return { kind: \"not_found\" };\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return { kind: \"unavailable\" };\n  const csv = await response.text().catch(() => null);\n  if (csv === null) return { kind: \"unavailable\" };\n  return { kind: \"ok\", csv };\n}\n\nexport interface SetupStatus {\n"],
  ["  activeEnrollments: number;\n  triggerKeyword: string | null;\n",
   "  activeEnrollments: number;\n  completedEnrollments: number;\n  triggerKeyword: string | null;\n"],
  ["      activeEnrollments: typeof row.active_enrollments === \"number\" ? row.active_enrollments : 0,\n      triggerKeyword: typeof row.trigger_keyword === \"string\" ? row.trigger_keyword : null,\n",
   "      activeEnrollments: typeof row.active_enrollments === \"number\" ? row.active_enrollments : 0,\n      completedEnrollments:\n        typeof row.completed_enrollments === \"number\" ? row.completed_enrollments : 0,\n      triggerKeyword: typeof row.trigger_keyword === \"string\" ? row.trigger_keyword : null,\n"]
]);


applySwaps("Omniflow/app/dashboard/(portal)/sequences/page.tsx", "Export CSV", false, [
  ["  activeEnrollments: number;\n  triggerKeyword: string | null;\n",
   "  activeEnrollments: number;\n  completedEnrollments: number;\n  triggerKeyword: string | null;\n"],
  ["                      {row.activeEnrollments} active\n                      {row.enabled ? \" \\u00b7 enrolling\" : \"\"}\n",
   "                      {row.activeEnrollments} active\n                      {\" \\u00b7 \"}\n                      {row.completedEnrollments} done\n                      {row.enabled ? \" \\u00b7 enrolling\" : \"\"}\n"],
  ["                  <div className=\"mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3\">\n                    {enrollments.length === 0 ? (\n",
   "                  <div className=\"mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3\">\n                    <div className=\"flex items-center justify-between gap-2\">\n                      <p className=\"text-[11px] uppercase tracking-wider text-slate-500\">\n                        People in {row.name}\n                      </p>\n                      <a\n                        href={\n                          \"/api/omniflow/portal/sequences/\" +\n                          String(row.id) +\n                          \"/enrollments/export\"\n                        }\n                        className=\"text-[11px] text-cyan-300 transition hover:text-cyan-200\"\n                      >\n                        Export CSV\n                      </a>\n                    </div>\n                    <div className=\"mt-2\">\n                    {enrollments.length === 0 ? (\n"],
  ["                    )}\n                  </div>\n",
   "                    )}\n                    </div>\n                  </div>\n"]
]);


writeNew("Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/export/route.ts", "exportEnrollmentsCsv",
"import {\n  exportEnrollmentsCsv,\n  requirePortalAccessToken,\n} from \"../../../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n} from \"../../../../../../../../lib/omniflow/request-security\";\n\n\nexport async function GET(\n  _request: Request,\n  { params }: { params: Promise<{ id: string }> }\n) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return new Response(JSON.stringify({ error: \"unauthorized\" }), {\n      status: 401,\n      headers: { ...noStoreHeaders(), \"Content-Type\": \"application/json\" },\n    });\n  }\n\n  const { id } = await params;\n  const sequenceId = Number.parseInt(id, 10);\n  if (!Number.isFinite(sequenceId)) {\n    return new Response(JSON.stringify({ error: \"bad_request\" }), {\n      status: 400,\n      headers: { ...noStoreHeaders(), \"Content-Type\": \"application/json\" },\n    });\n  }\n\n  try {\n    const result = await exportEnrollmentsCsv(accessToken, sequenceId);\n    if (result.kind === \"not_found\") {\n      return new Response(JSON.stringify({ error: \"not_found\" }), {\n        status: 404,\n        headers: { ...noStoreHeaders(), \"Content-Type\": \"application/json\" },\n      });\n    }\n    if (result.kind !== \"ok\") {\n      return new Response(JSON.stringify({ error: \"unavailable\" }), {\n        status: 503,\n        headers: { ...noStoreHeaders(), \"Content-Type\": \"application/json\" },\n      });\n    }\n    return new Response(result.csv, {\n      status: 200,\n      headers: {\n        ...noStoreHeaders(),\n        \"Content-Type\": \"text/csv; charset=utf-8\",\n        \"Content-Disposition\":\n          \"attachment; filename=sequence-\" + String(sequenceId) + \"-enrollments.csv\",\n      },\n    });\n  } catch {\n    return new Response(JSON.stringify({ error: \"unavailable\" }), {\n      status: 503,\n      headers: { ...noStoreHeaders(), \"Content-Type\": \"application/json\" },\n    });\n  }\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");