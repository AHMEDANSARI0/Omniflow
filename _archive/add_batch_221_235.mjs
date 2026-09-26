// Omniflow batch 221-235 — SEQUENCES PRO: reply-aware flows, smart step conditions,
// step-funnel analytics (+ list keyword-column fix).
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_221_235.mjs
// CP:  lazy DDL — sequences.pause_on_reply (default TRUE), steps.only_if_idle_hours,
//      NEW portal_sequence_step_log (+idx); update_sequence accepts pause_on_reply (bool);
//      maybe_auto_pause_replies(connector hook after the keyword enroll): pauses a
//      conversation's active enrollments on customer reply, 2-minute grace protects the
//      just-enrolled, audits sequence.auto_paused as system; delivery loop: steps with
//      only_if_idle_hours skip (no send) when the customer messaged within the window —
//      the step still advances exactly like a send, and EVERY send/skip writes a
//      step_log row; NEW GET /portal/sequences/<id>/stats — per-step sent/skipped funnel
//      (COUNT FILTER, 404-scoped). FIX: list SELECT now returns trigger_keyword +
//      pause_on_reply (the keyword chip previously vanished after a page refresh).
// Web: portal.ts SequenceStep.onlyIfIdleHours + SequenceRow.pauseOnReply + explicit
//      step normalization + create/update/edit wire mapping + getSequenceStats client;
//      create/steps/update BFF routes carry the new keys; NEW sequences/[id]/stats BFF
//      (SEVEN ../); sequences page: "Send only if no reply for [N] hours" per step
//      (create + edit), "pauses on reply / ignores replies" chip-toggle per row,
//      Stats button + per-step sent/skipped progress bars.
// Tests (rig, not this patcher): test_auto_pause 24, test_step_conditions 28,
//      test_sequence_ui_pro 31; eight sequences-family suites rebased to the 10-slot DDL.
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b221235.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b221235.bak";
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


applySwaps("OmniFlow-Control-Plane/portal_sequences.py", "sequence_stats", true, [
  ["SETTINGS_TABLE = \"portal_sequence_settings\"\nMAX_STEPS = 5\n",
   "SETTINGS_TABLE = \"portal_sequence_settings\"\nSTEP_LOG_TABLE = \"portal_sequence_step_log\"\nMAX_STEPS = 5\n"],
  ["        )\n    conn.commit()\n",
   "        )\n        cur.execute(\n            \"ALTER TABLE \" + portal_db._q(SEQUENCES_TABLE) +\n            \" ADD COLUMN IF NOT EXISTS pause_on_reply BOOLEAN NOT NULL DEFAULT TRUE\"\n        )\n        cur.execute(\n            \"ALTER TABLE \" + portal_db._q(STEPS_TABLE) +\n            \" ADD COLUMN IF NOT EXISTS only_if_idle_hours INT\"\n        )\n        cur.execute(\n            \"CREATE TABLE IF NOT EXISTS \" + portal_db._q(STEP_LOG_TABLE) +\n            \" (id BIGSERIAL PRIMARY KEY,\"\n            \" client_id BIGINT NOT NULL,\"\n            \" sequence_id BIGINT NOT NULL,\"\n            \" enrollment_id BIGINT NOT NULL,\"\n            \" step_no INT NOT NULL,\"\n            \" action TEXT NOT NULL,\"\n            \" created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\"\n        )\n        cur.execute(\n            \"CREATE INDEX IF NOT EXISTS idx_sequence_step_log\"\n            \" ON \" + portal_db._q(STEP_LOG_TABLE) +\n            \" (client_id, sequence_id, step_no)\"\n        )\n    conn.commit()\n"],
  ["        cleaned.append((index + 1, delay, body))\n    for step_no, delay, body in cleaned:\n        cur.execute(\n            \"INSERT INTO \" + portal_db._q(STEPS_TABLE) +\n            \" (client_id, sequence_id, step_no, delay_hours, body)\"\n            \" VALUES (%s, %s, %s, %s, %s)\",\n            (client_id, sequence_id, step_no, delay, body),\n",
   "        idle_raw = item.get(\"only_if_idle_hours\")\n        if idle_raw is None or idle_raw == \"\":\n            idle_value = None\n        else:\n            try:\n                idle_value = int(idle_raw)\n            except (TypeError, ValueError):\n                return None\n            if idle_value < 1 or idle_value > MAX_DELAY_HOURS:\n                return None\n        cleaned.append((index + 1, delay, body, idle_value))\n    for step_no, delay, body, idle_value in cleaned:\n        cur.execute(\n            \"INSERT INTO \" + portal_db._q(STEPS_TABLE) +\n            \" (client_id, sequence_id, step_no, delay_hours, body,\"\n            \" only_if_idle_hours)\"\n            \" VALUES (%s, %s, %s, %s, %s, %s)\",\n            (client_id, sequence_id, step_no, delay, body, idle_value),\n"],
  ["            \"body\": row.get(\"body\") or \"\",\n        }\n",
   "            \"body\": row.get(\"body\") or \"\",\n            \"only_if_idle_hours\": (\n                int(row[\"only_if_idle_hours\"])\n                if row.get(\"only_if_idle_hours\") is not None else None\n            ),\n        }\n"],
  ["        \"trigger_keyword\": row.get(\"trigger_keyword\") or None,\n    }\n",
   "        \"trigger_keyword\": row.get(\"trigger_keyword\") or None,\n        \"pause_on_reply\": row.get(\"pause_on_reply\") is not False,\n    }\n"],
  ["                    \"SELECT id, name, enabled, created_at FROM \" + portal_db._q(SEQUENCES_TABLE) +\n",
   "                    \"SELECT id, name, enabled, created_at, trigger_keyword, pause_on_reply FROM \" + portal_db._q(SEQUENCES_TABLE) +\n"],
  ["                        \"SELECT step_no, delay_hours, body FROM \" + portal_db._q(STEPS_TABLE) +\n",
   "                        \"SELECT step_no, delay_hours, body, only_if_idle_hours FROM \" + portal_db._q(STEPS_TABLE) +\n"],
  ["        params.append(_normalize_keyword(payload.get(\"trigger_keyword\")))\n    if \"enabled\" in payload:\n",
   "        params.append(_normalize_keyword(payload.get(\"trigger_keyword\")))\n    if \"pause_on_reply\" in payload:\n        if not isinstance(payload.get(\"pause_on_reply\"), bool):\n            return jsonify({\"error\": {\"code\": \"bad_request\",\n                                      \"message\": \"pause_on_reply must be true or false.\"}}), 400\n        changes.append(\"pause_on_reply = %s\")\n        params.append(payload.get(\"pause_on_reply\"))\n    if \"enabled\" in payload:\n"],
  ["                 \"attachment; filename=sequence-%d-enrollments.csv\" % sequence_id},\n    )\n\n\n",
   "                 \"attachment; filename=sequence-%d-enrollments.csv\" % sequence_id},\n    )\n\n\n@bp.get(\"/sequences/<int:sequence_id>/stats\")\ndef sequence_stats(sequence_id: int):\n    \"\"\"Per-step sent/skipped funnel for one sequence.\"\"\"\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_seq_tables(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"SELECT 1 FROM \" + portal_db._q(SEQUENCES_TABLE) +\n                    \" WHERE id = %s AND client_id = %s\",\n                    (sequence_id, principal[\"client_id\"]),\n                )\n                if not portal_db.rows(cur):\n                    return jsonify({\"error\": {\"code\": \"not_found\",\n                                              \"message\": \"Sequence not found.\"}}), 404\n                cur.execute(\n                    \"SELECT step_no,\"\n                    \" COUNT(*) FILTER (WHERE action = 'sent') AS sent,\"\n                    \" COUNT(*) FILTER (WHERE action = 'skipped') AS skipped\"\n                    \" FROM \" + portal_db._q(STEP_LOG_TABLE) +\n                    \" WHERE client_id = %s AND sequence_id = %s\"\n                    \" GROUP BY step_no ORDER BY step_no\",\n                    (principal[\"client_id\"], sequence_id),\n                )\n                rows = portal_db.rows(cur)\n        finally:\n            conn.close()\n    except Exception as error:\n        return jsonify(portal_db.portal_unavailable(error, \"sequence stats\")[0]), 503\n    return jsonify({\"steps\": [\n        {\n            \"step_no\": int(row.get(\"step_no\") or 0),\n            \"sent\": int(row.get(\"sent\") or 0),\n            \"skipped\": int(row.get(\"skipped\") or 0),\n        }\n        for row in rows\n    ]}), 200\n\n\n"],
  ["\ndef deliver_due_sequence_steps(cur, client_id: int, conn) -> int:\n",
   "\ndef maybe_auto_pause_replies(client_id: int, conversation_id: int, conn) -> int:\n    \"\"\"Pause a conversation's running series when the customer replies.\n\n    Enrollments younger than 2 minutes are spared so the message that just\n    enrolled (keyword trigger) never pauses its own series.\n    \"\"\"\n    try:\n        portal_db.ensure_tables()\n        _ensure_seq_tables(conn)\n    except Exception:\n        return 0\n    try:\n        with conn.cursor() as cur:\n            cur.execute(\n                \"UPDATE \" + portal_db._q(ENROLLMENTS_TABLE) + \" e\"\n                \" SET status = 'paused'\"\n                \" FROM \" + portal_db._q(SEQUENCES_TABLE) + \" s\"\n                \" WHERE e.sequence_id = s.id\"\n                \" AND e.client_id = %s AND e.conversation_id = %s\"\n                \" AND e.status = 'active'\"\n                \" AND e.enrolled_at < NOW() - interval '2 minutes'\"\n                \" AND s.enabled IS TRUE AND s.pause_on_reply IS TRUE\"\n                \" RETURNING e.id\",\n                (client_id, conversation_id),\n            )\n            rows = portal_db.rows(cur)\n            if not rows:\n                return 0\n            portal_db.log_action(\n                cur,\n                client_id,\n                \"sequence.auto_paused\",\n                \"system\",\n                None,\n                conversation_id,\n                \"Auto-paused %d series after the customer replied.\" % len(rows),\n            )\n        conn.commit()\n        return len(rows)\n    except Exception:\n        return 0\n\n\ndef deliver_due_sequence_steps(cur, client_id: int, conn) -> int:\n"],
  ["            \"SELECT e.id, e.sequence_id, e.current_step, e.contact_id, e.contact_name\"\n",
   "            \"SELECT e.id, e.sequence_id, e.current_step, e.conversation_id,\"\n            \" e.contact_id, e.contact_name\"\n"],
  ["        for row in due:\n            current_step = int(row.get(\"current_step\") or 0)\n            cur.execute(\n                \"SELECT step_no, delay_hours, body FROM \" + portal_db._q(STEPS_TABLE) +\n",
   "        skipped_count = 0\n        for row in due:\n            current_step = int(row.get(\"current_step\") or 0)\n            cur.execute(\n                \"SELECT step_no, delay_hours, body, only_if_idle_hours FROM \" + portal_db._q(STEPS_TABLE) +\n"],
  ["            display = str(row.get(\"contact_name\") or \"\").strip()\n            body = str(step.get(\"body\") or \"\").replace(\n                \"{name}\", (display.split(\" \")[0] if display else \"there\")\n            )\n            portal_growth._send_command(\n                cur, client_id, str(row.get(\"contact_id\") or \"\"), display,\n                body, \"sequence\", broadcast_id=None,\n            )\n",
   "            idle = step.get(\"only_if_idle_hours\")\n            skip = False\n            if idle is not None:\n                cur.execute(\n                    \"SELECT 1 FROM \" + portal_db._q(portal_db.MSGS_TABLE) +\n                    \" WHERE client_id = %s AND conversation_id = %s\"\n                    \" AND direction = 'in'\"\n                    \" AND created_at > NOW() - make_interval(hours => %s)\"\n                    \" LIMIT 1\",\n                    (client_id, row.get(\"conversation_id\"), int(idle)),\n                )\n                skip = bool(portal_db.rows(cur))\n            if not skip:\n                display = str(row.get(\"contact_name\") or \"\").strip()\n                body = str(step.get(\"body\") or \"\").replace(\n                    \"{name}\", (display.split(\" \")[0] if display else \"there\")\n                )\n                portal_growth._send_command(\n                    cur, client_id, str(row.get(\"contact_id\") or \"\"), display,\n                    body, \"sequence\", broadcast_id=None,\n                )\n"],
  ["            sent += 1\n        if sent:\n",
   "            cur.execute(\n                \"INSERT INTO \" + portal_db._q(STEP_LOG_TABLE) +\n                \" (client_id, sequence_id, enrollment_id, step_no, action)\"\n                \" VALUES (%s, %s, %s, %s, %s)\",\n                (client_id, row.get(\"sequence_id\"), row.get(\"id\"),\n                 int(step.get(\"step_no\") or 0), \"skipped\" if skip else \"sent\"),\n            )\n            if skip:\n                skipped_count += 1\n            else:\n                sent += 1\n        if sent or skipped_count:\n"]
]);


applySwaps("OmniFlow-Control-Plane/connector_api.py", "maybe_auto_pause_replies", true, [
  ["                        pass\n                    inserted += 1\n",
   "                        pass\n                    try:\n                        portal_sequences.maybe_auto_pause_replies(\n                            tenant[\"client_id\"],\n                            conversation_id,\n                            conn,\n                        )\n                    except Exception:\n                        pass\n                    inserted += 1\n"]
]);


applySwaps("Omniflow/lib/omniflow/portal.ts", "getSequenceStats", false, [
  ["  body: string;\n}\n",
   "  body: string;\n  onlyIfIdleHours: number | null;\n}\n"],
  ["  triggerKeyword: string | null;\n}\n",
   "  triggerKeyword: string | null;\n  pauseOnReply: boolean;\n}\n"],
  ["    const steps = Array.isArray(row.steps) ? (row.steps as SequenceStep[]) : [];\n",
   "    const steps = Array.isArray(row.steps)\n      ? (row.steps as Record<string, unknown>[]).map((step) => ({\n          step_no: typeof step.step_no === \"number\" ? step.step_no : 0,\n          delay_hours: typeof step.delay_hours === \"number\" ? step.delay_hours : 0,\n          body: typeof step.body === \"string\" ? step.body : \"\",\n          onlyIfIdleHours:\n            typeof step.only_if_idle_hours === \"number\"\n              ? step.only_if_idle_hours\n              : null,\n        }))\n      : [];\n"],
  ["        typeof row.completed_enrollments === \"number\" ? row.completed_enrollments : 0,\n      triggerKeyword: typeof row.trigger_keyword === \"string\" ? row.trigger_keyword : null,\n",
   "        typeof row.completed_enrollments === \"number\" ? row.completed_enrollments : 0,\n      pauseOnReply: row.pause_on_reply !== false,\n      triggerKeyword: typeof row.trigger_keyword === \"string\" ? row.trigger_keyword : null,\n"],
  ["  steps: { delay_hours: number; body: string }[],\n",
   "  steps: {\n    delay_hours: number;\n    body: string;\n    only_if_idle_hours?: number | null;\n  }[],\n"],
  ["  changes: { name?: string; enabled?: boolean; triggerKeyword?: string | null }\n",
   "  changes: {\n    name?: string;\n    enabled?: boolean;\n    triggerKeyword?: string | null;\n    pauseOnReply?: boolean;\n  }\n"],
  ["        body: JSON.stringify(\n          \"triggerKeyword\" in changes\n            ? { ...changes, trigger_keyword: changes.triggerKeyword ?? null }\n            : changes\n        ),\n",
   "        body: JSON.stringify((() => {\n          const wire: Record<string, unknown> = {};\n          if (\"name\" in changes) wire.name = changes.name;\n          if (\"enabled\" in changes) wire.enabled = changes.enabled;\n          if (\"triggerKeyword\" in changes) {\n            wire.trigger_keyword = changes.triggerKeyword ?? null;\n          }\n          if (\"pauseOnReply\" in changes) {\n            wire.pause_on_reply = changes.pauseOnReply === true;\n          }\n          return wire;\n        })()),\n"],
  ["  steps: { delay_hours: number; body: string }[]\n",
   "  steps: {\n    delay_hours: number;\n    body: string;\n    only_if_idle_hours?: number | null;\n  }[]\n"],
  ["  if (response.status === 400) return { kind: \"invalid\" };\n  if (!response.ok) return { kind: \"unavailable\" };\n  return { kind: \"ok\" };\n}\n\nexport async function deleteSequence(\n",
   "  if (response.status === 400) return { kind: \"invalid\" };\n  if (!response.ok) return { kind: \"unavailable\" };\n  return { kind: \"ok\" };\n}\n\nexport interface SequenceStepStat {\n  stepNo: number;\n  sent: number;\n  skipped: number;\n}\n\nexport async function getSequenceStats(\n  accessToken: string,\n  id: number\n): Promise<SequenceStepStat[] | null> {\n  let response: Response;\n  try {\n    response = await portalRequest(\n      accessToken,\n      \"api/v1/portal/sequences/\" + String(id) + \"/stats\"\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 404 || response.status === 501) return null;\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return null;\n  const payload: unknown = await response.json().catch(() => null);\n  if (payload === null || typeof payload !== \"object\") return null;\n  const list = (payload as { steps?: unknown }).steps;\n  if (!Array.isArray(list)) return null;\n  return list\n    .map((item) => {\n      const row =\n        item !== null && typeof item === \"object\"\n          ? (item as Record<string, unknown>)\n          : {};\n      return {\n        stepNo: typeof row.step_no === \"number\" ? row.step_no : 0,\n        sent: typeof row.sent === \"number\" ? row.sent : 0,\n        skipped: typeof row.skipped === \"number\" ? row.skipped : 0,\n      };\n    })\n    .filter((row) => row.stepNo > 0);\n}\n\nexport async function deleteSequence(\n"]
]);


applySwaps("Omniflow/app/dashboard/(portal)/sequences/page.tsx", "toggleStats", false, [
  ["  step_no: number;\n  delay_hours: number;\n  body: string;\n}\n\ninterface Sequence {\n",
   "  step_no: number;\n  delay_hours: number;\n  body: string;\n  onlyIfIdleHours: number | null;\n}\n\ninterface Sequence {\n"],
  ["}\n\ninterface DraftStep {\n  delay_hours: number;\n  body: string;\n",
   "  pauseOnReply: boolean;\n}\n\ninterface DraftStep {\n  delay_hours: number;\n  body: string;\n  onlyIfIdleHours: number | null;\n"],
  ["        body: \"Welcome {name}! Thanks for reaching out \\u2014 reply here anytime and we'll help you out.\",\n      },\n",
   "        body: \"Welcome {name}! Thanks for reaching out \\u2014 reply here anytime and we'll help you out.\",\n        onlyIfIdleHours: null,\n      },\n"],
  ["      },\n      {\n        delay_hours: 24,\n        body: \"Hi {name}, did your order arrive safely? Reply if you need anything.\",\n",
   "        onlyIfIdleHours: null,\n      },\n      {\n        delay_hours: 24,\n        body: \"Hi {name}, did your order arrive safely? Reply if you need anything.\",\n        onlyIfIdleHours: null,\n"],
  ["      },\n      {\n        delay_hours: 96,\n        body: \"{name}, your favourites are back in stock. Reply REORDER and we'll reserve them for you.\",\n",
   "        onlyIfIdleHours: null,\n      },\n      {\n        delay_hours: 96,\n        body: \"{name}, your favourites are back in stock. Reply REORDER and we'll reserve them for you.\",\n        onlyIfIdleHours: null,\n"],
  ["        body: \"Hi {name}! Glad you shopped with us. Could you spare a minute to share your experience?\",\n      },\n",
   "        body: \"Hi {name}! Glad you shopped with us. Could you spare a minute to share your experience?\",\n        onlyIfIdleHours: null,\n      },\n"],
  ["    { delay_hours: 0, body: \"\" },\n",
   "    { delay_hours: 0, body: \"\", onlyIfIdleHours: null },\n"],
  ["  const [editNote, setEditNote] = useState<string | null>(null);\n  const [quiet, setQuiet] = useState<{\n",
   "  const [editNote, setEditNote] = useState<string | null>(null);\n  const [openStats, setOpenStats] = useState<number | null>(null);\n  const [stats, setStats] = useState<\n    Record<number, { sent: number; skipped: number }>\n  >({});\n  const [quiet, setQuiet] = useState<{\n"],
  ["        ? [...current, { delay_hours: 24, body: \"\" }]\n",
   "        ? [...current, { delay_hours: 24, body: \"\", onlyIfIdleHours: null }]\n"],
  ["        body: JSON.stringify(\n          keyword.trim()\n            ? { name, steps: draft, trigger_keyword: keyword.trim() }\n            : { name, steps: draft }\n        ),\n",
   "        body: JSON.stringify((() => {\n          const steps = draft.map((step) => ({\n            delay_hours: step.delay_hours,\n            body: step.body,\n            only_if_idle_hours: step.onlyIfIdleHours,\n          }));\n          return keyword.trim()\n            ? { name, steps, trigger_keyword: keyword.trim() }\n            : { name, steps };\n        })()),\n"],
  ["        setDraft([{ delay_hours: 0, body: \"\" }]);\n",
   "        setDraft([{ delay_hours: 0, body: \"\", onlyIfIdleHours: null }]);\n"],
  ["          body: JSON.stringify({ enabled }),\n        });\n",
   "          body: JSON.stringify({ enabled }),\n        });\n        void load();\n      } catch {\n        void load();\n      } finally {\n        setBusy(false);\n      }\n    },\n    [load]\n  );\n\n  const togglePauseReply = useCallback(\n    async (row: Sequence) => {\n      setBusy(true);\n      try {\n        await fetch(\"/api/omniflow/portal/sequences/\" + String(row.id), {\n          method: \"PUT\",\n          headers: { \"Content-Type\": \"application/json\" },\n          body: JSON.stringify({ pauseOnReply: !row.pauseOnReply }),\n        });\n"],
  ["\n  const openAdd = useCallback((id: number) => {\n",
   "\n  const toggleStats = useCallback(\n    async (id: number) => {\n      if (openStats === id) {\n        setOpenStats(null);\n        return;\n      }\n      setOpenStats(id);\n      try {\n        const response = await fetch(\n          \"/api/omniflow/portal/sequences/\" + String(id) + \"/stats\",\n          { cache: \"no-store\" }\n        );\n        const payload: unknown = await response.json().catch(() => null);\n        const list =\n          payload !== null && typeof payload === \"object\"\n            ? (payload as {\n                steps?: { step_no: number; sent: number; skipped: number }[];\n              }).steps\n            : null;\n        const map: Record<number, { sent: number; skipped: number }> = {};\n        for (const row of Array.isArray(list) ? list : []) {\n          map[row.step_no] = { sent: row.sent, skipped: row.skipped };\n        }\n        setStats(map);\n      } catch {\n        setStats({});\n      }\n    },\n    [openStats]\n  );\n\n  const openAdd = useCallback((id: number) => {\n"],
  ["      row.steps.map((step) => ({ delay_hours: step.delay_hours, body: step.body }))\n",
   "      row.steps.map((step) => ({\n        delay_hours: step.delay_hours,\n        body: step.body,\n        onlyIfIdleHours: step.onlyIfIdleHours,\n      }))\n"],
  ["        body: step.body,\n      }));\n",
   "        body: step.body,\n        onlyIfIdleHours: step.onlyIfIdleHours,\n      }));\n"],
  ["                </div>\n                <textarea\n",
   "                </div>\n                <label className=\"mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400\">\n                  <input\n                    type=\"checkbox\"\n                    checked={step.onlyIfIdleHours !== null}\n                    onChange={(event) =>\n                      patchStep(index, {\n                        onlyIfIdleHours: event.target.checked ? 24 : null,\n                      })\n                    }\n                    className=\"h-3.5 w-3.5 accent-cyan-400\"\n                  />\n                  Send only if no reply for\n                  <input\n                    type=\"number\"\n                    min={1}\n                    max={168}\n                    value={step.onlyIfIdleHours ?? 24}\n                    disabled={step.onlyIfIdleHours === null}\n                    onChange={(event) =>\n                      patchStep(index, {\n                        onlyIfIdleHours: Math.max(\n                          1,\n                          Math.min(168, Number(event.target.value) || 24)\n                        ),\n                      })\n                    }\n                    className=\"w-14 rounded-md border border-white/[0.07] bg-white/[0.02] px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-cyan-400/40 disabled:opacity-40\"\n                  />\n                  hours\n                </label>\n                <textarea\n"],
  ["                      ) : null}\n                    </span>\n",
   "                      ) : null}\n                      <button\n                        type=\"button\"\n                        onClick={() => void togglePauseReply(row)}\n                        title=\"Pause this series automatically when the customer replies\"\n                        className={\n                          \"shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] transition \" +\n                          (row.pauseOnReply\n                            ? \"border-amber-400/25 bg-amber-400/[0.08] text-amber-300\"\n                            : \"border-white/[0.08] bg-white/[0.02] text-slate-500\")\n                        }\n                      >\n                        {row.pauseOnReply ? \"pauses on reply\" : \"ignores replies\"}\n                      </button>\n                    </span>\n"],
  ["                      {openLog === row.id ? \"Hide people\" : \"People\"}\n                    </button>\n",
   "                      {openLog === row.id ? \"Hide people\" : \"People\"}\n                    </button>\n                    <button\n                      type=\"button\"\n                      onClick={() => void toggleStats(row.id)}\n                      className=\"rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white\"\n                    >\n                      {openStats === row.id ? \"Hide stats\" : \"Stats\"}\n                    </button>\n"],
  ["                </div>\n                {openLog === row.id ? (\n",
   "                </div>\n                {openStats === row.id ? (\n                  <div className=\"mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3\">\n                    <p className=\"text-[11px] uppercase tracking-wider text-slate-500\">\n                      Step delivery\n                    </p>\n                    <div className=\"mt-2 space-y-2\">\n                      {row.steps.map((step) => {\n                        const stat = stats[step.step_no] ?? {\n                          sent: 0,\n                          skipped: 0,\n                        };\n                        const total = stat.sent + stat.skipped;\n                        const pct =\n                          total === 0\n                            ? 0\n                            : Math.round((stat.sent / total) * 100);\n                        return (\n                          <div key={step.step_no}>\n                            <div className=\"flex items-center justify-between text-[11px] text-slate-400\">\n                              <span>Step {step.step_no}</span>\n                              <span>\n                                {stat.sent} sent \\u00b7 {stat.skipped} skipped\n                                \\u00b7 {pct}%\n                              </span>\n                            </div>\n                            <div className=\"mt-1 h-2 overflow-hidden rounded-full bg-white/[0.05]\">\n                              <div\n                                className=\"h-full rounded-full bg-cyan-400/50\"\n                                style={{ width: pct + \"%\" }}\n                              />\n                            </div>\n                          </div>\n                        );\n                      })}\n                    </div>\n                  </div>\n                ) : null}\n                {openLog === row.id ? (\n"],
  ["                          </div>\n                          <textarea\n",
   "                          </div>\n                          <label className=\"mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400\">\n                            <input\n                              type=\"checkbox\"\n                              checked={step.onlyIfIdleHours !== null}\n                              onChange={(event) =>\n                                patchEditStep(index, {\n                                  onlyIfIdleHours: event.target.checked ? 24 : null,\n                                })\n                              }\n                              className=\"h-3.5 w-3.5 accent-cyan-400\"\n                            />\n                            Send only if no reply for\n                            <input\n                              type=\"number\"\n                              min={1}\n                              max={168}\n                              value={step.onlyIfIdleHours ?? 24}\n                              disabled={step.onlyIfIdleHours === null}\n                              onChange={(event) =>\n                                patchEditStep(index, {\n                                  onlyIfIdleHours: Math.max(\n                                    1,\n                                    Math.min(168, Number(event.target.value) || 24)\n                                  ),\n                                })\n                              }\n                              className=\"w-14 rounded-md border border-white/[0.07] bg-white/[0.02] px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-cyan-400/40 disabled:opacity-40\"\n                            />\n                            hours\n                          </label>\n                          <textarea\n"],
  ["                              { delay_hours: 24, body: \"\" },\n",
   "                              { delay_hours: 24, body: \"\", onlyIfIdleHours: null },\n"]
]);


applySwaps("Omniflow/app/api/omniflow/portal/sequences/route.ts", "only_if_idle_hours", false, [
  ["    ? (input.steps as { delay_hours?: unknown; body?: unknown }[]).map(\n        (step) => ({\n          delay_hours: typeof step.delay_hours === \"number\" ? step.delay_hours : 0,\n          body: typeof step.body === \"string\" ? step.body : \"\",\n        })\n      )\n",
   "    ? (input.steps as {\n        delay_hours?: unknown;\n        body?: unknown;\n        only_if_idle_hours?: unknown;\n      }[]).map((step) => ({\n        delay_hours: typeof step.delay_hours === \"number\" ? step.delay_hours : 0,\n        body: typeof step.body === \"string\" ? step.body : \"\",\n        only_if_idle_hours:\n          typeof step.only_if_idle_hours === \"number\"\n            ? step.only_if_idle_hours\n            : null,\n      }))\n"]
]);


applySwaps("Omniflow/app/api/omniflow/portal/sequences/[id]/route.ts", "pauseOnReply", false, [
  ["  } = {};\n  if (typeof input.name === \"string\") changes.name = input.name;\n  if (typeof input.enabled === \"boolean\") changes.enabled = input.enabled;\n",
   "    pauseOnReply?: boolean;\n  } = {};\n  if (typeof input.name === \"string\") changes.name = input.name;\n  if (typeof input.enabled === \"boolean\") changes.enabled = input.enabled;\n  if (typeof input.pauseOnReply === \"boolean\") {\n    changes.pauseOnReply = input.pauseOnReply;\n  }\n"]
]);


applySwaps("Omniflow/app/api/omniflow/portal/sequences/[id]/steps/route.ts", "onlyIfIdleHours", false, [
  ["          ? (step as { delay_hours?: unknown; body?: unknown })\n          : {};\n      return {\n        delay_hours: typeof item.delay_hours === \"number\" ? item.delay_hours : 0,\n        body: typeof item.body === \"string\" ? item.body : \"\",\n",
   "          ? (step as {\n              delay_hours?: unknown;\n              body?: unknown;\n              onlyIfIdleHours?: unknown;\n            })\n          : {};\n      return {\n        delay_hours: typeof item.delay_hours === \"number\" ? item.delay_hours : 0,\n        body: typeof item.body === \"string\" ? item.body : \"\",\n        only_if_idle_hours:\n          typeof item.onlyIfIdleHours === \"number\" ? item.onlyIfIdleHours : null,\n"]
]);


writeNew("Omniflow/app/api/omniflow/portal/sequences/[id]/stats/route.ts", "getSequenceStats",
"import {\n  getSequenceStats,\n  requirePortalAccessToken,\n} from \"../../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../../lib/omniflow/control-plane\";\n\n\nexport async function GET(\n  _request: Request,\n  { params }: { params: Promise<{ id: string }> }\n) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const { id } = await params;\n  const sequenceId = Number.parseInt(id, 10);\n  if (!Number.isFinite(sequenceId)) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"Invalid sequence id.\" } },\n      400\n    );\n  }\n\n  try {\n    const steps = await getSequenceStats(accessToken, sequenceId);\n    return safeJson({ steps }, 200);\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");


console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");