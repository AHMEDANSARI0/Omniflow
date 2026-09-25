// Omniflow batch 266-280 — CRM PIPELINE: deterministic deal stages on a kanban board.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_266_280.mjs
// CP:  NEW portal_pipeline.py — lazy portal_contact_stage(client_id, contact_id,
//      stage, updated_at, UNIQUE(client_id, contact_id)); GET /portal/pipeline board
//      (one GROUP BY query over conversations LEFT JOIN stages, COALESCE default 'new',
//      five fixed columns always returned, count + <=50 contacts each, board cap 400);
//      POST /portal/pipeline/stage (human-only, allow-list stage, upsert — or DELETE
//      when moving back to 'new' — plus pipeline.stage_changed audit). app.py registers
//      the blueprint on the portal_segments single-line anchors. SEGMENTS UPGRADE:
//      stage filter joins portal_pipeline's table (allow-list validated in
//      _parse_filters, to_regclass probe keeps old segments safe on DBs that never
//      opened the pipeline).
// Web: portal.ts PipelineStage/PIPELINE_STAGES/PipelineContact/PipelineColumn +
//      getPipelineBoard + setContactStage clients, SegmentFilters.stage +
//      normalize passthrough; TWO BFF routes (pipeline 5 ups, pipeline/stage 6 ups
//      with the five-value stage whitelist); segments BFF create whitelist gains
//      stage; NEW /dashboard/pipeline kanban page (five color-coded columns,
//      per-contact stage select, counts, 360 deep links, empty + error states);
//      segments page gains a Stage dropdown (state, payload, describe label);
//      sidebar "Pipeline" nav item.
// Tests (rig, not this patcher): test_pipeline.py 50, test_pipeline_ui.py 55.
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b266280.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b251265.bak";
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

function writeNew(repoPath, marker, isCp, content) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(repoPath, content, "utf8");
    if (isCp && !compilePython(repoPath)) {
      console.log("FAIL (compile failed): " + repoPath);
      warnings++;
      return;
    }
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


writeNew("OmniFlow-Control-Plane/portal_pipeline.py", "portal_pipeline", true,
"\"\"\"CRM pipeline: deterministic deal stages for contacts (kanban board data).\"\"\"\n\nimport logging\nfrom typing import Any, Dict, Optional, Tuple\n\nfrom flask import Blueprint, jsonify, request\n\nfrom portal_auth import (\n    PortalAuthUnavailable,\n    authenticate_portal_request,\n    ensure_human_principal,\n)\nimport portal_db\n\nbp = Blueprint(\"portal_pipeline\", __name__, url_prefix=\"/api/v1/portal\")\n\nlogger = logging.getLogger(__name__)\n\nSTAGE_TABLE = \"portal_contact_stage\"\nMAX_CONTACT = 100\nBOARD_LIMIT = 400\nCOLUMN_CAP = 50\nVALID_STAGE: Tuple[str, ...] = (\"new\", \"interested\", \"negotiating\", \"won\", \"lost\")\n\n_PIPE_DDL_READY = False\n\n\ndef _principal_or_error():\n    try:\n        principal = authenticate_portal_request()\n    except PortalAuthUnavailable as error:\n        return None, (jsonify({\"error\": {\"code\": \"portal_unavailable\",\n                                         \"message\": str(error)}}), 503)\n    if principal is None:\n        return None, (jsonify({\"error\": {\"code\": \"unauthorized\",\n                                         \"message\": \"Sign in required.\"}}), 401)\n    return principal, None\n\n\ndef _iso(value: Any) -> Optional[str]:\n    if value is None:\n        return None\n    try:\n        return value.isoformat()\n    except AttributeError:\n        return None\n\n\ndef _ensure_stage_table(conn) -> None:\n    global _PIPE_DDL_READY\n    if _PIPE_DDL_READY:\n        return\n    with conn.cursor() as cur:\n        cur.execute(\n            \"CREATE TABLE IF NOT EXISTS \" + portal_db._q(STAGE_TABLE) +\n            \" (id BIGSERIAL PRIMARY KEY,\"\n            \" client_id BIGINT NOT NULL,\"\n            \" contact_id TEXT NOT NULL,\"\n            \" stage TEXT NOT NULL DEFAULT 'new',\"\n            \" updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\"\n            \" UNIQUE (client_id, contact_id))\"\n        )\n    conn.commit()\n    _PIPE_DDL_READY = True\n\n\ndef _board_rows(cur, client_id: int) -> list:\n    sql = (\n        \"SELECT COALESCE(s.stage, 'new') AS stage,\"\n        \" c.contact_id,\"\n        \" MAX(c.contact_name) AS name,\"\n        \" MAX(c.lead_temp) AS lead_temp,\"\n        \" COUNT(*) AS chats,\"\n        \" MAX(c.last_message_at) AS last_at\"\n        \" FROM \" + portal_db._q(portal_db.CONV_TABLE) + \" c\"\n        \" LEFT JOIN \" + portal_db._q(STAGE_TABLE) + \" s\"\n        \" ON s.client_id = c.client_id\"\n        \" AND s.contact_id = c.contact_id\"\n        \" WHERE c.client_id = %s\"\n        \" GROUP BY c.contact_id, COALESCE(s.stage, 'new')\"\n        \" ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id\"\n        \" LIMIT %s\"\n    )\n    cur.execute(sql, (client_id, BOARD_LIMIT))\n    return portal_db.rows(cur)\n\n\n@bp.get(\"/pipeline\")\ndef board():\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_stage_table(conn)\n            with conn.cursor() as cur:\n                rows = _board_rows(cur, principal[\"client_id\"])\n            columns: Dict[str, list] = {stage: [] for stage in VALID_STAGE}\n            counts: Dict[str, int] = {stage: 0 for stage in VALID_STAGE}\n            for row in rows:\n                stage = row.get(\"stage\")\n                if stage not in columns:\n                    stage = \"new\"\n                counts[stage] += 1\n                if len(columns[stage]) < COLUMN_CAP:\n                    columns[stage].append(\n                        {\n                            \"contact_id\": row.get(\"contact_id\"),\n                            \"name\": row.get(\"name\") or \"\",\n                            \"lead_temp\": row.get(\"lead_temp\") or \"cold\",\n                            \"chats\": int(row.get(\"chats\") or 0),\n                            \"last_at\": _iso(row.get(\"last_at\")),\n                        }\n                    )\n            result = [\n                {\"stage\": stage, \"count\": counts[stage],\n                 \"contacts\": columns[stage]}\n                for stage in VALID_STAGE\n            ]\n        finally:\n            conn.close()\n    except Exception as error:\n        logger.warning(\"pipeline read failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error, \"pipeline read\")[0]), 503\n    return jsonify({\"stages\": result}), 200\n\n\n@bp.post(\"/pipeline/stage\")\ndef set_stage():\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    forbidden = ensure_human_principal(principal)\n    if forbidden is not None:\n        return forbidden\n    payload = request.get_json(silent=True) or {}\n    contact = str(payload.get(\"contact\") or \"\").strip()[:MAX_CONTACT]\n    stage = payload.get(\"stage\")\n    if not contact:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"A contact is required.\"}}), 400\n    if stage not in VALID_STAGE:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"Pick a valid stage\"\n                                             \" (new/interested/negotiating/\"\n                                             \"won/lost).\"}}), 400\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_stage_table(conn)\n            with conn.cursor() as cur:\n                if stage == \"new\":\n                    cur.execute(\n                        \"DELETE FROM \" + portal_db._q(STAGE_TABLE) +\n                        \" WHERE client_id = %s AND contact_id = %s\",\n                        (principal[\"client_id\"], contact),\n                    )\n                else:\n                    cur.execute(\n                        \"INSERT INTO \" + portal_db._q(STAGE_TABLE) +\n                        \" (client_id, contact_id, stage)\"\n                        \" VALUES (%s, %s, %s)\"\n                        \" ON CONFLICT (client_id, contact_id)\"\n                        \" DO UPDATE SET stage = EXCLUDED.stage,\"\n                        \" updated_at = NOW()\",\n                        (principal[\"client_id\"], contact, stage),\n                    )\n                portal_db.log_action(\n                    cur,\n                    principal[\"client_id\"],\n                    \"pipeline.stage_changed\",\n                    \"customer_user\",\n                    principal.get(\"user_id\"),\n                    None,\n                    \"Contact moved to '\" + str(stage) + \"': \" + contact + \".\",\n                )\n            conn.commit()\n        finally:\n            conn.close()\n    except Exception as error:\n        logger.warning(\"pipeline stage failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error, \"pipeline stage\")[0]), 503\n    return jsonify({\"ok\": True, \"contact\": contact, \"stage\": stage}), 200\n");


applySwaps("OmniFlow-Control-Plane/portal_segments.py", "portal_pipeline", true, [
  ["import portal_growth\n",
   "import portal_growth\nimport portal_pipeline\n"],
  ["        clean[\"status\"] = value\n",
   "        clean[\"status\"] = value\n    if \"stage\" in raw:\n        value = raw[\"stage\"]\n        if value not in portal_pipeline.VALID_STAGE:\n            return None\n        clean[\"stage\"] = value\n"],
  ["                 limit: int) -> list:\n",
   "                 limit: int) -> list:\n    join_sql = \"\"\n    if \"stage\" in filters:\n        cur.execute(\"SELECT to_regclass(%s)\",\n                    (portal_pipeline.STAGE_TABLE,))\n        found = portal_db.rows(cur)\n        if not found or not found[0].get(\"to_regclass\"):\n            return []\n        join_sql = (\n            \" LEFT JOIN \" + portal_db._q(portal_pipeline.STAGE_TABLE) + \" s\"\n            \" ON s.client_id = c.client_id\"\n            \" AND s.contact_id = c.contact_id\"\n        )\n"],
  ["        \" FROM \" + portal_db._q(portal_db.CONV_TABLE) + \" c\"\n",
   "        \" FROM \" + portal_db._q(portal_db.CONV_TABLE) + \" c\"\n        + join_sql +\n"],
  ["        params.append(filters[\"status\"])\n",
   "        params.append(filters[\"status\"])\n    if \"stage\" in filters:\n        sql += \" AND COALESCE(s.stage, 'new') = %s\"\n        params.append(filters[\"stage\"])\n"]
]
);


applySwaps("OmniFlow-Control-Plane/app.py", "portal_pipeline_bp", true, [
  ["from portal_segments import bp as portal_segments_bp  # noqa: E402\n",
   "from portal_segments import bp as portal_segments_bp  # noqa: E402\nfrom portal_pipeline import bp as portal_pipeline_bp  # noqa: E402\n"],
  ["aux_app.register_blueprint(portal_segments_bp)\n",
   "aux_app.register_blueprint(portal_segments_bp)\naux_app.register_blueprint(portal_pipeline_bp)\n"]
]
);


applySwaps("Omniflow/lib/omniflow/portal.ts", "getPipelineBoard", false, [
  ["  status?: \"open\" | \"closed\";\n",
   "  status?: \"open\" | \"closed\";\n  stage?: PipelineStage;\n"],
  ["    out.status = input.status;\n",
   "    out.status = input.status;\n  }\n  if (\n    input.stage === \"new\" ||\n    input.stage === \"interested\" ||\n    input.stage === \"negotiating\" ||\n    input.stage === \"won\" ||\n    input.stage === \"lost\"\n  ) {\n    out.stage = input.stage;\n"],
  ["    notes,\n  };\n",
   "    notes,\n  };\n}\n\nexport type PipelineStage =\n  | \"new\"\n  | \"interested\"\n  | \"negotiating\"\n  | \"won\"\n  | \"lost\";\n\nexport const PIPELINE_STAGES: PipelineStage[] = [\n  \"new\",\n  \"interested\",\n  \"negotiating\",\n  \"won\",\n  \"lost\",\n];\n\nexport interface PipelineContact {\n  contactId: string;\n  name: string;\n  leadTemp: string;\n  chats: number;\n  lastAt: string | null;\n}\n\nexport interface PipelineColumn {\n  stage: PipelineStage;\n  count: number;\n  contacts: PipelineContact[];\n}\n\nexport async function getPipelineBoard(\n  accessToken: string\n): Promise<PipelineColumn[] | null> {\n  let response: Response;\n  try {\n    response = await portalRequest(accessToken, \"api/v1/portal/pipeline\");\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 404 || response.status === 501) return null;\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return null;\n  const payload: unknown = await response.json().catch(() => null);\n  if (payload === null || typeof payload !== \"object\") return null;\n  const rawStages = (payload as Record<string, unknown>).stages;\n  if (!Array.isArray(rawStages)) return null;\n  const columns: PipelineColumn[] = [];\n  for (const item of rawStages) {\n    if (item === null || typeof item !== \"object\") continue;\n    const row = item as Record<string, unknown>;\n    if (typeof row.stage !== \"string\") continue;\n    const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];\n    const contacts: PipelineContact[] = [];\n    for (const entry of rawContacts) {\n      if (entry === null || typeof entry !== \"object\") continue;\n      const contact = entry as Record<string, unknown>;\n      if (typeof contact.contact_id !== \"string\") continue;\n      contacts.push({\n        contactId: contact.contact_id,\n        name: typeof contact.name === \"string\" ? contact.name : \"\",\n        leadTemp: typeof contact.lead_temp === \"string\" ? contact.lead_temp : \"cold\",\n        chats: typeof contact.chats === \"number\" ? contact.chats : 0,\n        lastAt: typeof contact.last_at === \"string\" ? contact.last_at : null,\n      });\n    }\n    columns.push({\n      stage: row.stage as PipelineStage,\n      count: typeof row.count === \"number\" ? row.count : contacts.length,\n      contacts,\n    });\n  }\n  return columns;\n}\n\nexport type StageMutation =\n  | { kind: \"ok\" }\n  | { kind: \"invalid\" }\n  | { kind: \"unavailable\" };\n\nexport async function setContactStage(\n  accessToken: string,\n  contact: string,\n  stage: PipelineStage\n): Promise<StageMutation> {\n  let response: Response;\n  try {\n    response = await portalRequest(accessToken, \"api/v1/portal/pipeline/stage\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ contact, stage }),\n    });\n  } catch (error) {\n    assertNotAuthError(error);\n    return { kind: \"unavailable\" };\n  }\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (response.status === 400) return { kind: \"invalid\" };\n  if (!response.ok) return { kind: \"unavailable\" };\n  return { kind: \"ok\" };\n"]
]
);


applySwaps("Omniflow/app/api/omniflow/portal/segments/route.ts", "rawFilters.stage === \"negotiating\"", false, [
  ["  }\n  if (\n",
   "  }\n  if (\n    rawFilters.stage === \"new\" ||\n    rawFilters.stage === \"interested\" ||\n    rawFilters.stage === \"negotiating\" ||\n    rawFilters.stage === \"won\" ||\n    rawFilters.stage === \"lost\"\n  ) {\n    filters.stage = rawFilters.stage;\n  }\n  if (\n"]
]
);


applySwaps("Omniflow/app/dashboard/(portal)/segments/page.tsx", "STAGE_OPTIONS", false, [
  ["  status?: string;\n",
   "  status?: string;\n  stage?: string;\n"],
  ["  { value: \"closed\", label: \"Only closed chats\" },\n];\n\n",
   "  { value: \"closed\", label: \"Only closed chats\" },\n];\n\nconst STAGE_OPTIONS = [\n  { value: \"\", label: \"Any pipeline stage\" },\n  { value: \"new\", label: \"Stage: New\" },\n  { value: \"interested\", label: \"Stage: Interested\" },\n  { value: \"negotiating\", label: \"Stage: Negotiating\" },\n  { value: \"won\", label: \"Stage: Won\" },\n  { value: \"lost\", label: \"Stage: Lost\" },\n];\n\n"],
  ["  if (filters.status === \"closed\") parts.push(\"closed chats\");\n",
   "  if (filters.status === \"closed\") parts.push(\"closed chats\");\n  if (filters.stage) parts.push(\"stage: \" + filters.stage);\n"],
  ["  const [status, setStatus] = useState(\"\");\n",
   "  const [status, setStatus] = useState(\"\");\n  const [stage, setStage] = useState(\"\");\n"],
  ["    if (status) filters.status = status;\n",
   "    if (status) filters.status = status;\n    if (stage) filters.stage = stage;\n"],
  ["              {STATUS_OPTIONS.map((option) => (\n                <option key={option.value} value={option.value} className=\"bg-slate-900\">\n                  {option.label}\n                </option>\n              ))}\n            </select>\n",
   "              {STATUS_OPTIONS.map((option) => (\n                <option key={option.value} value={option.value} className=\"bg-slate-900\">\n                  {option.label}\n                </option>\n              ))}\n            </select>\n            <select\n              value={stage}\n              onChange={(event) => setStage(event.target.value)}\n              className=\"rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40\"\n            >\n              {STAGE_OPTIONS.map((option) => (\n                <option key={option.value} value={option.value} className=\"bg-slate-900\">\n                  {option.label}\n                </option>\n              ))}\n            </select>\n"]
]
);


applySwaps("Omniflow/app/dashboard/components/DashSidebar.tsx", "\"/dashboard/pipeline\"", false, [
  ["  { label: \"Segments\", href: \"/dashboard/segments\", icon: \"\\u25ce\", enabled: true },\n",
   "  { label: \"Segments\", href: \"/dashboard/segments\", icon: \"\\u25ce\", enabled: true },\n  { label: \"Pipeline\", href: \"/dashboard/pipeline\", icon: \"\\u25c8\", enabled: true },\n"]
]
);


writeNew("Omniflow/app/api/omniflow/portal/pipeline/route.ts", "getPipelineBoard", false,
"import {\n  getPipelineBoard,\n  requirePortalAccessToken,\n} from \"../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../lib/omniflow/control-plane\";\n\n\nexport async function GET() {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  try {\n    const stages = await getPipelineBoard(accessToken);\n    if (stages === null) {\n      return safeJson(\n        { error: { code: \"not_found\", message: \"Pipeline unavailable.\" } },\n        404\n      );\n    }\n    return safeJson({ stages }, 200);\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");


writeNew("Omniflow/app/api/omniflow/portal/pipeline/stage/route.ts", "STAGE_VALUES", false,
"import {\n  requirePortalAccessToken,\n  setContactStage,\n  type PipelineStage,\n} from \"../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../lib/omniflow/control-plane\";\n\nconst STAGE_VALUES: PipelineStage[] = [\n  \"new\",\n  \"interested\",\n  \"negotiating\",\n  \"won\",\n  \"lost\",\n];\n\n\nexport async function POST(request: Request) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const payload: unknown = await request.json().catch(() => null);\n  const input =\n    payload !== null && typeof payload === \"object\"\n      ? (payload as Record<string, unknown>)\n      : {};\n  const contact = typeof input.contact === \"string\" ? input.contact.trim() : \"\";\n  const stage = input.stage;\n  if (!contact || contact.length > 100) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"contact is required.\" } },\n      400\n    );\n  }\n  if (\n    typeof stage !== \"string\" ||\n    !STAGE_VALUES.includes(stage as PipelineStage)\n  ) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"Pick a valid stage.\" } },\n      400\n    );\n  }\n\n  try {\n    const result = await setContactStage(\n      accessToken,\n      contact,\n      stage as PipelineStage\n    );\n    if (result.kind === \"ok\") {\n      return safeJson({ ok: true }, 200);\n    }\n    if (result.kind === \"invalid\") {\n      return safeJson(\n        { error: { code: \"bad_request\", message: \"Pick a valid stage.\" } },\n        400\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");


writeNew("Omniflow/app/dashboard/(portal)/pipeline/page.tsx", "STAGES", false,
"\"use client\";\n\nimport Link from \"next/link\";\nimport { useCallback, useEffect, useState } from \"react\";\n\ninterface PipelineContact {\n  contactId: string;\n  name: string;\n  leadTemp: string;\n  chats: number;\n  lastAt: string | null;\n}\n\ninterface Column {\n  stage: string;\n  count: number;\n  contacts: PipelineContact[];\n}\n\nconst STAGES = [\n  { value: \"new\", label: \"New\", dot: \"bg-slate-400\", text: \"text-slate-300\" },\n  {\n    value: \"interested\",\n    label: \"Interested\",\n    dot: \"bg-cyan-400\",\n    text: \"text-cyan-300\",\n  },\n  {\n    value: \"negotiating\",\n    label: \"Negotiating\",\n    dot: \"bg-amber-400\",\n    text: \"text-amber-300\",\n  },\n  { value: \"won\", label: \"Won\", dot: \"bg-emerald-400\", text: \"text-emerald-300\" },\n  { value: \"lost\", label: \"Lost\", dot: \"bg-rose-400\", text: \"text-rose-300\" },\n];\n\nconst EMPTY_BOARD: Column[] = STAGES.map((stage) => ({\n  stage: stage.value,\n  count: 0,\n  contacts: [],\n}));\n\nfunction stageLabel(stage: string): string {\n  return STAGES.find((item) => item.value === stage)?.label ?? stage;\n}\n\nexport default function PipelinePage() {\n  const [columns, setColumns] = useState<Column[] | null>(null);\n  const [note, setNote] = useState(\"\");\n\n  const load = useCallback(async () => {\n    try {\n      const response = await fetch(\"/api/omniflow/portal/pipeline\", {\n        cache: \"no-store\",\n      });\n      if (!response.ok) {\n        setColumns(null);\n        return;\n      }\n      const payload: unknown = await response.json().catch(() => null);\n      const stages =\n        payload !== null && typeof payload === \"object\"\n          ? (payload as Record<string, unknown>).stages\n          : null;\n      if (!Array.isArray(stages)) {\n        setColumns(null);\n        return;\n      }\n      const byStage = new Map<string, Column>();\n      for (const item of stages) {\n        if (item === null || typeof item !== \"object\") continue;\n        const row = item as Record<string, unknown>;\n        if (typeof row.stage !== \"string\") continue;\n        const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];\n        const contacts: PipelineContact[] = [];\n        for (const entry of rawContacts) {\n          if (entry === null || typeof entry !== \"object\") continue;\n          const contact = entry as Record<string, unknown>;\n          if (typeof contact.contact_id !== \"string\") continue;\n          contacts.push({\n            contactId: contact.contact_id,\n            name: typeof contact.name === \"string\" ? contact.name : \"\",\n            leadTemp: typeof contact.lead_temp === \"string\" ? contact.lead_temp : \"cold\",\n            chats: typeof contact.chats === \"number\" ? contact.chats : 0,\n            lastAt: typeof contact.last_at === \"string\" ? contact.last_at : null,\n          });\n        }\n        byStage.set(row.stage, {\n          stage: row.stage,\n          count: typeof row.count === \"number\" ? row.count : contacts.length,\n          contacts,\n        });\n      }\n      setColumns(\n        STAGES.map((stage) => byStage.get(stage.value) ?? {\n          stage: stage.value,\n          count: 0,\n          contacts: [],\n        })\n      );\n    } catch {\n      setColumns(null);\n    }\n  }, []);\n\n  useEffect(() => {\n    void load();\n  }, [load]);\n\n  async function move(contactId: string, stage: string) {\n    setNote(\"\");\n    try {\n      const response = await fetch(\"/api/omniflow/portal/pipeline/stage\", {\n        method: \"POST\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ contact: contactId, stage }),\n      });\n      if (!response.ok) {\n        setNote(\"Could not move that contact. Try again.\");\n        return;\n      }\n      await load();\n    } catch {\n      setNote(\"Could not move that contact. Try again.\");\n    }\n  }\n\n  return (\n    <main className=\"min-h-screen bg-[#07111f] px-4 py-8 sm:px-6\">\n      <div className=\"mx-auto max-w-6xl\">\n        <div className=\"flex items-center justify-between gap-3\">\n          <div>\n            <h1 className=\"text-lg font-semibold text-white\">Pipeline</h1>\n            <p className=\"mt-0.5 text-xs text-slate-500\">\n              Move customers through New, Interested, Negotiating, Won or Lost.\n            </p>\n          </div>\n          <button\n            type=\"button\"\n            onClick={() => void load()}\n            className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/[0.03] hover:text-white\"\n          >\n            Refresh\n          </button>\n        </div>\n\n        {note ? (\n          <p className=\"mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-200\">\n            {note}\n          </p>\n        ) : null}\n\n        {columns === null ? (\n          <p className=\"mt-6 text-sm text-slate-500\">\n            Pipeline is not available right now.\n          </p>\n        ) : (\n          <div className=\"mt-4 flex gap-3 overflow-x-auto pb-4\">\n            {columns.map((column) => {\n              const meta =\n                STAGES.find((item) => item.value === column.stage) ??\n                STAGES[0];\n              return (\n                <section\n                  key={column.stage}\n                  className=\"flex w-60 shrink-0 flex-col rounded-2xl border border-white/[0.06] bg-white/[0.015]\"\n                >\n                  <div className=\"flex items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2.5\">\n                    <span className=\"flex items-center gap-2 text-xs font-semibold text-white\">\n                      <span\n                        className={\"h-1.5 w-1.5 rounded-full \" + meta.dot}\n                      />\n                      {meta.label}\n                    </span>\n                    <span\n                      className={\n                        \"rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] \" +\n                        meta.text\n                      }\n                    >\n                      {column.count}\n                    </span>\n                  </div>\n                  {column.contacts.length === 0 ? (\n                    <p className=\"px-3 py-4 text-[11px] text-slate-600\">\n                      No contacts here yet.\n                    </p>\n                  ) : (\n                    <ul className=\"space-y-1.5 p-2\">\n                      {column.contacts.map((contact) => (\n                        <li\n                          key={contact.contactId}\n                          className=\"rounded-xl border border-white/[0.05] bg-white/[0.01] p-2\"\n                        >\n                          <Link\n                            prefetch={false}\n                            href={\n                              \"/dashboard/customers/profile?contact=\" +\n                              encodeURIComponent(contact.contactId)\n                            }\n                            className=\"block truncate text-xs font-medium text-slate-200 transition hover:text-cyan-200\"\n                          >\n                            {contact.name || contact.contactId}\n                          </Link>\n                          <p className=\"mt-0.5 text-[10px] text-slate-500\">\n                            {contact.chats} chat{contact.chats === 1 ? \"\" : \"s\"}\n                            {\" \\\\u00b7 \"}{contact.leadTemp} lead\n                          </p>\n                          <select\n                            value={column.stage}\n                            onChange={(event) =>\n                              void move(contact.contactId, event.target.value)\n                            }\n                            className=\"mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0b1626] px-1.5 py-1 text-[10px] text-slate-300 outline-none\"\n                          >\n                            {STAGES.map((stage) => (\n                              <option key={stage.value} value={stage.value}>\n                                {stageLabel(stage.value)}\n                              </option>\n                            ))}\n                          </select>\n                        </li>\n                      ))}\n                    </ul>\n                  )}\n                </section>\n              );\n            })}\n          </div>\n        )}\n      </div>\n    </main>\n  );\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");