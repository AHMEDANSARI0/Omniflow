// Omniflow batch 196-200 — sequences v2.2: edit steps, save-as-copy, templates.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_196_200.mjs
// CP:  PUT /api/v1/portal/sequences/<id>/steps — replace steps in place (validated 1-5,
//      0-168h), rollback keeps old steps on invalid input, audit sequence.steps_updated.
//      Existing enrollments adapt: delivery picks the next step_no > current_step and
//      completes gracefully when none is left.
// Web: portal.ts updateSequenceSteps client, BFF sequences/[id]/steps route (PUT),
//      sequences page: per-row Edit dialog (step editor + Save / Save as copy — copies
//      carry name+steps, never the trigger keyword) and "Start from:" template chips
//      (Welcome flow, Order follow-up, Reorder nudge with REORDER keyword, Review request).
// Tests (rig, not this patcher): test_sequence_edit.py (36 checks).
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b196200.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b196200.bak";
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


applySwaps("OmniFlow-Control-Plane/portal_sequences.py", "replace_sequence_steps", true, [
  ["        return jsonify(portal_db.portal_unavailable(error, \"sequence update\")[0]), 503\n    if not rows:\n        return jsonify({\"error\": {\"code\": \"not_found\",\n                                  \"message\": \"Sequence not found.\"}}), 404\n    return jsonify({\"ok\": True}), 200\n\n\n@bp.delete(\"/sequences/<int:sequence_id>\")\n",
   "        return jsonify(portal_db.portal_unavailable(error, \"sequence update\")[0]), 503\n    if not rows:\n        return jsonify({\"error\": {\"code\": \"not_found\",\n                                  \"message\": \"Sequence not found.\"}}), 404\n    return jsonify({\"ok\": True}), 200\n\n\n@bp.put(\"/sequences/<int:sequence_id>/steps\")\ndef replace_sequence_steps(sequence_id: int):\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    forbidden = ensure_human_principal(principal)\n    if forbidden is not None:\n        return forbidden\n    payload = request.get_json(silent=True) or {}\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_seq_tables(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"SELECT id FROM \" + portal_db._q(SEQUENCES_TABLE) +\n                    \" WHERE id = %s AND client_id = %s\",\n                    (sequence_id, principal[\"client_id\"]),\n                )\n                found = portal_db.rows(cur)\n                if not found:\n                    return jsonify({\"error\": {\"code\": \"not_found\",\n                                              \"message\": \"Sequence not found.\"}}), 404\n                cur.execute(\n                    \"DELETE FROM \" + portal_db._q(STEPS_TABLE) +\n                    \" WHERE client_id = %s AND sequence_id = %s\",\n                    (principal[\"client_id\"], sequence_id),\n                )\n                count = _parse_steps(payload.get(\"steps\"), principal[\"client_id\"],\n                                     sequence_id, cur)\n                if count is None:\n                    conn.rollback()\n                    return jsonify({\"error\": {\"code\": \"bad_request\",\n                                              \"message\": \"Steps: 1 to 5, each with text and a 0-168h delay.\"}}), 400\n                portal_db.log_action(\n                    cur,\n                    principal[\"client_id\"],\n                    \"sequence.steps_updated\",\n                    \"customer_user\",\n                    principal.get(\"user_id\"),\n                    None,\n                    \"Sequence #%d now has %d step(s).\" % (sequence_id, count),\n                )\n            conn.commit()\n        finally:\n            conn.close()\n    except Exception as error:\n        return jsonify(portal_db.portal_unavailable(error, \"sequence steps update\")[0]), 503\n    return jsonify({\"ok\": True}), 200\n\n\n@bp.delete(\"/sequences/<int:sequence_id>\")\n"]
]);


applySwaps("Omniflow/lib/omniflow/portal.ts", "updateSequenceSteps", false, [
  ["\nexport async function deleteSequence(\n",
   "\nexport async function updateSequenceSteps(\n  accessToken: string,\n  id: number,\n  steps: { delay_hours: number; body: string }[]\n): Promise<SequenceMutation> {\n  let response: Response;\n  try {\n    response = await portalRequest(\n      accessToken,\n      \"api/v1/portal/sequences/\" + String(id) + \"/steps\",\n      {\n        method: \"PUT\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ steps }),\n      }\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return { kind: \"unavailable\" };\n  }\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (response.status === 400) return { kind: \"invalid\" };\n  if (response.status === 404) return { kind: \"not_found\" };\n  if (!response.ok) return { kind: \"unavailable\" };\n  return { kind: \"ok\" };\n}\n\nexport async function deleteSequence(\n"]
]);


applySwaps("Omniflow/app/dashboard/(portal)/sequences/page.tsx", "Save as copy", false, [
  ["\nexport default function SequencesPage() {\n",
   "\nconst TEMPLATES: {\n  label: string;\n  name: string;\n  keyword: string;\n  steps: DraftStep[];\n}[] = [\n  {\n    label: \"Welcome flow\",\n    name: \"Welcome flow\",\n    keyword: \"\",\n    steps: [\n      {\n        delay_hours: 0,\n        body: \"Welcome {name}! Thanks for reaching out \\u2014 reply here anytime and we'll help you out.\",\n      },\n    ],\n  },\n  {\n    label: \"Order follow-up\",\n    name: \"Order follow-up\",\n    keyword: \"\",\n    steps: [\n      {\n        delay_hours: 0,\n        body: \"Thank you {name}! Your order is confirmed. We'll share delivery updates right here.\",\n      },\n      {\n        delay_hours: 24,\n        body: \"Hi {name}, did your order arrive safely? Reply if you need anything.\",\n      },\n    ],\n  },\n  {\n    label: \"Reorder nudge\",\n    name: \"Reorder nudge\",\n    keyword: \"reorder\",\n    steps: [\n      {\n        delay_hours: 72,\n        body: \"Hi {name}! Time for a refill? Send REORDER and we'll set you up.\",\n      },\n      {\n        delay_hours: 96,\n        body: \"{name}, your favourites are back in stock. Reply REORDER and we'll reserve them for you.\",\n      },\n    ],\n  },\n  {\n    label: \"Review request\",\n    name: \"Review request\",\n    keyword: \"\",\n    steps: [\n      {\n        delay_hours: 48,\n        body: \"Hi {name}! Glad you shopped with us. Could you spare a minute to share your experience?\",\n      },\n    ],\n  },\n];\n\nexport default function SequencesPage() {\n"],
  ["  const [addNote, setAddNote] = useState<string | null>(null);\n\n",
   "  const [addNote, setAddNote] = useState<string | null>(null);\n  const [editOpenFor, setEditOpenFor] = useState<number | null>(null);\n  const [editDraft, setEditDraft] = useState<DraftStep[]>([]);\n  const [editBusy, setEditBusy] = useState(false);\n  const [editNote, setEditNote] = useState<string | null>(null);\n\n"],
  ["      current.map((step, i) => (i === index ? { ...step, ...changes } : step))\n    );\n  };\n\n",
   "      current.map((step, i) => (i === index ? { ...step, ...changes } : step))\n    );\n  };\n\n  const applyTemplate = (template: (typeof TEMPLATES)[number]) => {\n    setName(template.name);\n    setKeyword(template.keyword);\n    setDraft(template.steps.map((step) => ({ ...step })));\n    setNoteTone(\"neutral\");\n    setNote(\"Template loaded \\u2014 edit anything, then Create series.\");\n  };\n\n"],
  ["\n  const saveTrigger = useCallback(\n",
   "\n  const openEdit = useCallback((row: Sequence) => {\n    setEditOpenFor(row.id);\n    setEditDraft(\n      row.steps.map((step) => ({ delay_hours: step.delay_hours, body: step.body }))\n    );\n    setEditNote(null);\n  }, []);\n\n  const patchEditStep = (index: number, changes: Partial<DraftStep>) => {\n    setEditDraft((current) =>\n      current.map((step, i) => (i === index ? { ...step, ...changes } : step))\n    );\n  };\n\n  const saveEdit = useCallback(\n    async (row: Sequence, asCopy: boolean) => {\n      if (editBusy) return;\n      const steps = editDraft.map((step) => ({\n        delay_hours: step.delay_hours,\n        body: step.body,\n      }));\n      if (steps.length === 0 || steps.some((step) => !step.body.trim())) {\n        setEditNote(\"Fill every step's message.\");\n        return;\n      }\n      setEditBusy(true);\n      setEditNote(null);\n      try {\n        if (asCopy) {\n          const response = await fetch(\"/api/omniflow/portal/sequences\", {\n            method: \"POST\",\n            headers: { \"Content-Type\": \"application/json\" },\n            body: JSON.stringify({ name: row.name + \" copy\", steps }),\n          });\n          if (!response.ok) {\n            setEditNote(\"Could not save the copy. Check steps (1-5, 0-168h each).\");\n            return;\n          }\n        } else {\n          const response = await fetch(\n            \"/api/omniflow/portal/sequences/\" + String(row.id) + \"/steps\",\n            {\n              method: \"PUT\",\n              headers: { \"Content-Type\": \"application/json\" },\n              body: JSON.stringify({ steps }),\n            }\n          );\n          if (!response.ok) {\n            setEditNote(\n              response.status === 404\n                ? \"Series not found.\"\n                : \"Could not save. Check steps (1-5, 0-168h each).\"\n            );\n            return;\n          }\n        }\n        setEditOpenFor(null);\n        void load();\n      } catch {\n        setEditNote(\"Could not save. Try again.\");\n      } finally {\n        setEditBusy(false);\n      }\n    },\n    [editBusy, editDraft, load]\n  );\n\n  const saveTrigger = useCallback(\n"],
  ["          <h2 className=\"text-sm font-semibold text-white\">New series</h2>\n          <input\n",
   "          <h2 className=\"text-sm font-semibold text-white\">New series</h2>\n          <div className=\"mt-3 flex flex-wrap items-center gap-2\">\n            <span className=\"text-[11px] uppercase tracking-wider text-slate-500\">\n              Start from:\n            </span>\n            {TEMPLATES.map((template) => (\n              <button\n                key={template.label}\n                type=\"button\"\n                onClick={() => applyTemplate(template)}\n                className=\"rounded-full border border-white/[0.08] px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200\"\n              >\n                {template.label}\n              </button>\n            ))}\n          </div>\n          <input\n"],
  ["                      type=\"button\"\n                      onClick={() => void remove(row)}\n",
   "                      type=\"button\"\n                      onClick={() => openEdit(row)}\n                      className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white\"\n                    >\n                      Edit\n                    </button>\n                    <button\n                      type=\"button\"\n                      onClick={() => void remove(row)}\n"],
  ["                ) : null}\n                {addOpenFor === row.id ? (\n",
   "                ) : null}\n                {editOpenFor === row.id ? (\n                  <div className=\"mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3\">\n                    <p className=\"text-[11px] uppercase tracking-wider text-slate-500\">\n                      Edit steps \\u2014 {row.name}\n                    </p>\n                    <div className=\"mt-2 space-y-2\">\n                      {editDraft.map((step, index) => (\n                        <div\n                          key={index}\n                          className=\"rounded-lg border border-white/[0.06] bg-white/[0.015] p-2.5\"\n                        >\n                          <div className=\"flex items-center justify-between gap-2\">\n                            <p className=\"text-[10px] uppercase tracking-wider text-slate-500\">\n                              Step {index + 1}\n                            </p>\n                            {editDraft.length > 1 ? (\n                              <button\n                                type=\"button\"\n                                onClick={() =>\n                                  setEditDraft((current) =>\n                                    current.filter((_, i) => i !== index)\n                                  )\n                                }\n                                className=\"text-[11px] text-slate-500 transition hover:text-rose-300\"\n                              >\n                                Remove\n                              </button>\n                            ) : null}\n                          </div>\n                          <div className=\"mt-1.5 flex items-center gap-2\">\n                            <input\n                              type=\"number\"\n                              min={0}\n                              max={168}\n                              value={step.delay_hours}\n                              onChange={(event) =>\n                                patchEditStep(index, {\n                                  delay_hours: Math.max(\n                                    0,\n                                    Math.min(168, Number(event.target.value) || 0)\n                                  ),\n                                })\n                              }\n                              className=\"w-20 shrink-0 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/40\"\n                            />\n                            <span className=\"shrink-0 text-xs text-slate-500\">hours</span>\n                          </div>\n                          <textarea\n                            value={step.body}\n                            onChange={(event) =>\n                              patchEditStep(index, { body: event.target.value })\n                            }\n                            rows={2}\n                            maxLength={1000}\n                            placeholder=\"Use {name} for the customer's first name.\"\n                            className=\"mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40\"\n                          />\n                        </div>\n                      ))}\n                    </div>\n                    <div className=\"mt-2 flex flex-wrap items-center gap-2\">\n                      {editDraft.length < 5 ? (\n                        <button\n                          type=\"button\"\n                          onClick={() =>\n                            setEditDraft((current) => [\n                              ...current,\n                              { delay_hours: 24, body: \"\" },\n                            ])\n                          }\n                          className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white\"\n                        >\n                          + Add step\n                        </button>\n                      ) : null}\n                      <button\n                        type=\"button\"\n                        onClick={() => void saveEdit(row, false)}\n                        disabled={editBusy}\n                        className=\"rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50\"\n                      >\n                        {editBusy ? \"Saving...\" : \"Save\"}\n                      </button>\n                      <button\n                        type=\"button\"\n                        onClick={() => void saveEdit(row, true)}\n                        disabled={editBusy}\n                        className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:opacity-50\"\n                      >\n                        Save as copy\n                      </button>\n                      <button\n                        type=\"button\"\n                        onClick={() => setEditOpenFor(null)}\n                        className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white\"\n                      >\n                        Close\n                      </button>\n                      {editNote ? (\n                        <p className=\"text-xs text-amber-300\">{editNote}</p>\n                      ) : null}\n                    </div>\n                    <p className=\"mt-2 text-[10px] text-slate-600\">\n                      People already in the series continue with the new steps. Save as\n                      copy keeps this series untouched.\n                    </p>\n                  </div>\n                ) : null}\n                {addOpenFor === row.id ? (\n"]
]);


writeNew("Omniflow/app/api/omniflow/portal/sequences/[id]/steps/route.ts", "updateSequenceSteps",
"import {\n  requirePortalAccessToken,\n  updateSequenceSteps,\n} from \"../../../../../../../lib/omniflow/portal\";\nimport {\n  safeJson,\n} from \"../../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../../lib/omniflow/control-plane\";\n\n\nexport async function PUT(\n  request: Request,\n  { params }: { params: Promise<{ id: string }> }\n) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const { id } = await params;\n  const sequenceId = Number.parseInt(id, 10);\n  if (!Number.isFinite(sequenceId)) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"Invalid sequence id.\" } },\n      400\n    );\n  }\n\n  const payload: unknown = await request.json().catch(() => null);\n  const input =\n    payload !== null && typeof payload === \"object\"\n      ? (payload as Record<string, unknown>)\n      : {};\n  const rawSteps = Array.isArray(input.steps) ? input.steps : [];\n  const steps = rawSteps\n    .map((step) => {\n      const item =\n        step !== null && typeof step === \"object\"\n          ? (step as { delay_hours?: unknown; body?: unknown })\n          : {};\n      return {\n        delay_hours: typeof item.delay_hours === \"number\" ? item.delay_hours : 0,\n        body: typeof item.body === \"string\" ? item.body : \"\",\n      };\n    })\n    .filter((step) => step.body.trim().length > 0);\n  if (steps.length === 0) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"At least one step with text is required.\" } },\n      400\n    );\n  }\n\n  try {\n    const result = await updateSequenceSteps(accessToken, sequenceId, steps);\n    if (result.kind === \"ok\") {\n      return safeJson({ ok: true }, 200);\n    }\n    if (result.kind === \"invalid\") {\n      return safeJson(\n        { error: { code: \"bad_request\", message: \"Steps: 1 to 5, each with text and a 0-168h delay.\" } },\n        400\n      );\n    }\n    if (result.kind === \"not_found\") {\n      return safeJson(\n        { error: { code: \"not_found\", message: \"Sequence not found.\" } },\n        404\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");