// Omniflow batch 311-330 — PARTIAL COMPLETION PASS: sidebar fixes + language +
// identity stitching + auto-escalation + intent classifier + action requests.
// Run from the folder that contains BOTH repos (Omniflow/ and OmniFlow-Control-Plane/):
//   node add_batch_311_330.mjs
// SIDEBAR FIXES: all nine empty nav icons get real glyphs (Overview house, WhatsApp
// phone, Configure AI asterism, Conversations envelope, Customers smiley,
// Automations zap, Analytics bullseye, Business profile card, Knowledge base grid)
// and Settings gets the gear; BOTH sidebar containers (desktop aside + mobile
// drawer) become min-h-0 flex-1 overflow-y-auto so all 21 items scroll instead of
// hiding below the fold.
// CP: NEW portal_contacts.py — workspace reply language (auto/en/ur/roman) with
// GET/PUT, per-contact language GET/POST (auto deletes the row), a deterministic
// script/marker language detector (Arabic script -> ur, Roman-Urdu marker hits ->
// roman, else en), identity stitching (portal_contact_identities with a sorted
// deterministic identity_key, /contacts/link + /identities), and the autonomous
// ACTION REQUEST surface (portal_action_requests: cancel_order / change_address /
// refund_request created against a conversation, listed per contact/status,
// resolved done/declined — every step audited). portal_insights.py gains
// GET /insights/intent (ordered regex rules -> refund/order_status/complaint/
// pricing/delivery/greeting/other + entity extraction: phones, #order ids,
// emails). portal_growth.py record_kb_gap now returns the gap count via
// INSERT..RETURNING and auto-ESCALATES on the 2nd gap: probes portal_team_members
// (to_regclass-guarded), assigns the conversation to the first member, audits
// bot.escalated. connector_api.py calls maybe_detect_language on inbound (once per
// contact, ON CONFLICT DO NOTHING). customer_profile gains language,
// linked_channels and actions sections (all to_regclass-guarded).
// Web: portal.ts clients for all of the above + CustomerProfile gains
// language/linkedChannels/actions; EIGHT BFF routes (depth law: workspace 6,
// contacts/* 6, detect 7, insights/intent 6, conversations/[id]/actions 7,
// contacts/actions 6, contacts/actions/[id] 7); the 360 page shows a language
// chip, Linked: rows and an Action requests section; the Activity page gains an
// "Escalations" family chip (bot. prefix).
// Tests (rig, not this patcher): test_partial_completion.py 78,
// test_partial_completion_ui.py 51, test_customer_360.py extended to 33.
// Idempotent: re-run reports "already done" per block. Backups: *.pre_b311330.bak
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BACKUP_TAG = ".pre_b311330.bak";
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
  let swapIndex = 0;
  for (const [frm, to] of swaps) {
    swapIndex++;
    if (!updated.includes(frm)) {
      const hits = original.split(frm.slice(0, 40)).length - 1;
      console.log(
        "  ? " + repoPath + " :: anchor NOT FOUND — report this" +
        " (swap " + swapIndex + "/" + swaps.length +
        ", anchor " + frm.length + " chars, starts: " +
        JSON.stringify(frm.slice(0, 60)) +
        ", " + hits + " partial hits)"
      );
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






const CP = "OmniFlow-Control-Plane";
const WEB = "Omniflow";

applySwaps(CP + "/portal_winback.py", "winback/send", true, [["link; nothing is ever sent automatically. No new tables.\"\"\"\n\nimport logging", "link; nothing is ever sent automatically. No new tables.\"\"\"\n\nimport json\nimport logging"], ["    authenticate_portal_request,\n)", "    authenticate_portal_request,\n    ensure_human_principal,\n)"], ["    }), 200", "    }), 200\n\n\nSEND_COOLDOWN_HOURS = 24\nWINBACK_KINDS = (\"cart\", \"reorder\", \"winback\")\n\n\n@bp.post(\"/winback/send\")\ndef winback_send():\n    \"\"\"Queue ONE suggested win-back message through the connector bridge.\n\n    The message is re-derived server-side from fresh data (never trusted from\n    the client), a 24h per-contact cooldown guards against double sends, and\n    the insert is audited. API keys are read-only - human session required.\n    \"\"\"\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    forbidden = ensure_human_principal(principal)\n    if forbidden:\n        return forbidden\n    body = request.get_json(silent=True) or {}\n    if not isinstance(body, dict):\n        body = {}\n    contact = str(body.get(\"contact_id\") or \"\").strip()[:100]\n    kind = str(body.get(\"kind\") or \"\").strip()\n    if not contact or kind not in WINBACK_KINDS:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"contact_id and a valid kind are\"\n                                             \" required.\"}}), 400\n    client_id = principal[\"client_id\"]\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"SELECT COALESCE(contact_name, '') AS name FROM \"\n                    + portal_db._q(portal_db.CONV_TABLE) +\n                    \" WHERE client_id = %s AND contact_id = %s LIMIT 1\",\n                    (client_id, contact),\n                )\n                rows = portal_db.rows(cur)\n                if not rows:\n                    return jsonify({\"error\": {\"code\": \"not_found\",\n                                              \"message\": \"Contact not\"\n                                                         \" found.\"}}), 404\n                display_name = str(rows[0].get(\"name\") or \"\")\n                cur.execute(\n                    \"SELECT 1 FROM \" + portal_db._q(portal_db.CMD_TABLE) +\n                    \" WHERE client_id = %s AND action = 'send_message'\"\n                    \" AND payload->>'source' = 'winback'\"\n                    \" AND payload->>'external_user_id' = %s\"\n                    \" AND created_at > NOW() - make_interval(hours => %s)\"\n                    \" LIMIT 1\",\n                    (client_id, contact, SEND_COOLDOWN_HOURS),\n                )\n                if portal_db.rows(cur):\n                    return jsonify({\"error\": {\"code\": \"cooldown\",\n                                              \"message\": \"A win-back message\"\n                                                         \" was sent to this\"\n                                                         \" contact recently.\"}}), 409\n                last = _load_last_message(cur, client_id, contact)\n                carts = _load_open_carts(cur, client_id, contact)\n                paid = _load_paid_links(cur, client_id, contact)\n                entry = build_entry(carts, paid, last, contact, display_name,\n                                    _now())\n                if entry is None or entry[\"kind\"] != kind:\n                    return jsonify({\"error\": {\"code\": \"stale\",\n                                              \"message\": \"This suggestion is\"\n                                                         \" no longer in the\"\n                                                         \" queue.\"}}), 409\n                cur.execute(\n                    \"SELECT id FROM \" + portal_db._q(portal_db.CONV_TABLE) +\n                    \" WHERE client_id = %s AND contact_id = %s\"\n                    \" ORDER BY id DESC LIMIT 1\",\n                    (client_id, contact),\n                )\n                conv_rows = portal_db.rows(cur)\n                conversation_id = (conv_rows[0].get(\"id\")\n                                   if conv_rows else None)\n                payload = {\n                    \"external_user_id\": contact,\n                    \"body\": entry[\"message\"],\n                    \"source\": \"winback\",\n                }\n                if conversation_id is not None:\n                    payload[\"conversation_id\"] = conversation_id\n                cur.execute(\n                    \"INSERT INTO \" + portal_db._q(portal_db.CMD_TABLE) +\n                    \" (client_id, channel, action, payload, status,\"\n                    \" requested_by, created_at, updated_at) \"\n                    \"VALUES (%s, 'whatsapp', 'send_message',\"\n                    \" CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW()) \"\n                    \"RETURNING id\",\n                    (client_id, json.dumps(payload)),\n                )\n                inserted = portal_db.rows(cur)\n                command_id = (int(inserted[0].get(\"id\") or 0)\n                              if inserted else 0)\n                portal_db.log_action(\n                    cur, client_id, \"winback.sent\",\n                    actor_kind=\"customer_user\",\n                    actor_user_id=principal.get(\"user_id\"),\n                    note=kind,\n                )\n        finally:\n            conn.close()\n    except Exception as error:\n        logger.warning(\"winback send failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error,\n                                                    \"winback send\")[0]), 503\n    return jsonify({\"sent\": True, \"kind\": kind,\n                    \"command_id\": command_id}), 200"]]);
applySwaps(WEB + "/lib/omniflow/portal.ts", "sendWinbackEntry", false, [["    winback: segmentOf(segments.winback),\n    counts: tierCounts,\n    scored: typeof row.scored === \"number\" ? row.scored : 0,\n  };\n}\n\nexport async function deleteSequence(", "    winback: segmentOf(segments.winback),\n    counts: tierCounts,\n    scored: typeof row.scored === \"number\" ? row.scored : 0,\n  };\n}\n\nexport type WinbackSendResult =\n  | { kind: \"ok\"; commandId: number }\n  | { kind: \"stale\" }\n  | { kind: \"cooldown\" }\n  | { kind: \"not_found\" }\n  | { kind: \"unavailable\" };\n\nexport async function sendWinbackEntry(\n  accessToken: string,\n  contactId: string,\n  entryKind: string\n): Promise<WinbackSendResult> {\n  let response: Response;\n  try {\n    response = await portalRequest(accessToken, \"api/v1/portal/winback/send\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ contact_id: contactId, kind: entryKind }),\n    });\n  } catch (error) {\n    assertNotAuthError(error);\n    return { kind: \"unavailable\" };\n  }\n  if (response.status === 404) return { kind: \"not_found\" };\n  if (response.status === 409) {\n    const payload: unknown = await response.json().catch(() => null);\n    const errorRaw =\n      payload !== null && typeof payload === \"object\"\n        ? (payload as Record<string, unknown>).error\n        : null;\n    const errorCode =\n      errorRaw !== null && typeof errorRaw === \"object\"\n        ? (errorRaw as Record<string, unknown>).code\n        : \"\";\n    return errorCode === \"cooldown\"\n      ? { kind: \"cooldown\" }\n      : { kind: \"stale\" };\n  }\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return { kind: \"unavailable\" };\n  const payload: unknown = await response.json().catch(() => null);\n  const row =\n    payload !== null && typeof payload === \"object\"\n      ? (payload as Record<string, unknown>)\n      : {};\n  const commandId = typeof row.command_id === \"number\" ? row.command_id : 0;\n  return { kind: \"ok\", commandId };\n}\n\nexport async function deleteSequence("]]);
writeNew(WEB + "/app/api/omniflow/portal/winback/send/route.ts", "sendWinbackEntry", false, "import {\n  requirePortalAccessToken,\n  sendWinbackEntry,\n} from \"../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../lib/omniflow/control-plane\";\n\n\nexport async function POST(request: Request) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const payload: unknown = await request.json().catch(() => null);\n  const body =\n    payload !== null && typeof payload === \"object\"\n      ? (payload as Record<string, unknown>)\n      : {};\n  const contactId = typeof body.contact_id === \"string\" ? body.contact_id : \"\";\n  const entryKind = typeof body.kind === \"string\" ? body.kind : \"\";\n  if (!contactId || contactId.length > 100 || !entryKind) {\n    return safeJson(\n      { error: { code: \"bad_request\", message: \"contact_id and kind are required.\" } },\n      400\n    );\n  }\n\n  try {\n    const result = await sendWinbackEntry(accessToken, contactId, entryKind);\n    if (result.kind === \"ok\") {\n      return safeJson(\n        { sent: true, kind: entryKind, command_id: result.commandId },\n        200\n      );\n    }\n    if (result.kind === \"not_found\") {\n      return safeJson(\n        { error: { code: \"not_found\", message: \"Contact not found.\" } },\n        404\n      );\n    }\n    if (result.kind === \"cooldown\") {\n      return safeJson(\n        {\n          error: {\n            code: \"cooldown\",\n            message: \"A win-back message was sent to this contact recently.\",\n          },\n        },\n        409\n      );\n    }\n    if (result.kind === \"stale\") {\n      return safeJson(\n        {\n          error: {\n            code: \"stale\",\n            message: \"This suggestion is no longer in the queue.\",\n          },\n        },\n        409\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");
applySwaps(WEB + "/app/dashboard/(portal)/winback/page.tsx", "winback/send", false, [["  const [copied, setCopied] = useState(false);\n\n  async function copyMessage() {", "  const [copied, setCopied] = useState(false);\n  const [sent, setSent] = useState(false);\n  const [busy, setBusy] = useState(false);\n  const [note, setNote] = useState(\"\");\n\n  async function copyMessage() {"], ["      setCopied(false);\n    }\n  }", "      setCopied(false);\n    }\n  }\n\n  async function sendNow() {\n    setBusy(true);\n    setNote(\"\");\n    try {\n      const response = await fetch(\"/api/omniflow/portal/winback/send\", {\n        method: \"POST\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ contact_id: entry.contactId, kind: entry.kind }),\n      });\n      if (response.ok) {\n        setSent(true);\n      } else if (response.status === 409) {\n        setNote(\"Recently sent or no longer in the queue.\");\n      } else if (response.status === 404) {\n        setNote(\"Contact no longer exists.\");\n      } else {\n        setNote(\"Send failed - try again shortly.\");\n      }\n    } catch {\n      setNote(\"Send failed - try again shortly.\");\n    } finally {\n      setBusy(false);\n    }\n  }"], ["        ) : null}\n      </div>\n    </li>", "        ) : null}\n        <button\n          onClick={() => void sendNow()}\n          disabled={busy || sent}\n          className=\"rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-2.5 py-1 text-[11px] text-cyan-300 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50\"\n        >\n          {sent ? \"Sent\" : busy ? \"Sending\\u2026\" : \"Send via WhatsApp\"}\n        </button>\n      </div>\n      {note ? <p className=\"mt-1 text-[10px] text-amber-300\">{note}</p> : null}\n    </li>"], ["          Ready-to-send recovery messages built from open carts, reorder gaps\n          and quiet customers. Copy a message or open WhatsApp - nothing is\n          ever sent automatically.\n        </p>\n      </div>\n\n      {failed ? (", "          Ready-to-send recovery messages built from open carts, reorder gaps\n          and quiet customers. Copy one, open WhatsApp, or send it through\n          your connected number - nothing is ever sent automatically.\n        </p>\n      </div>\n\n      {failed ? ("]]);

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");