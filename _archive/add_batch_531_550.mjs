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

function insertAfterLine(text, newLine, prefixes) {
  const lines = text.split("\n");
  for (const prefix of prefixes) {
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(prefix)) lastIdx = i;
    }
    if (lastIdx >= 0) {
      lines.splice(lastIdx + 1, 0, newLine);
      return { text: lines.join("\n"), anchor: prefix };
    }
  }
  return null;
}

// Laptop app.py repair: 471-490 / 491-510 used multi-line anchors that do not
// match every laptop app.py (the file drifted). This re-adds any missing
// blueprint registration line-by-line with fallback anchors instead.

applySwaps(CP + "/portal_conversations.py", "VIP_THRESHOLD", true, [["        \"intent\": row.get(\"intent\"),\n        \"created_at\": _iso(row.get(\"created_at\")),\n    }\n\n\ndef _tags_map(cur, client_id, conversation_ids) -> dict:", "        \"intent\": row.get(\"intent\"),\n        \"created_at\": _iso(row.get(\"created_at\")),\n    }\n\n\nVIP_THRESHOLD = 3  # paid orders that turn a contact into a VIP\n\n\ndef _paid_order_counts(cur, client_id, contact_ids):\n    \"\"\"contact_id -> paid order count ({} when the links table is absent).\"\"\"\n    ids = sorted({str(cid).strip() for cid in contact_ids\n                  if cid and str(cid).strip()})\n    if not ids:\n        return {}\n    try:\n        cur.execute(\"SELECT to_regclass(%s) AS oid\",\n                    (\"portal_checkout_links\",))\n        rows = portal_db.rows(cur)\n        if not rows or not rows[0].get(\"oid\"):\n            return {}\n        cur.execute(\n            \"SELECT contact_id, COUNT(*) AS orders FROM portal_checkout_links\"\n            \" WHERE client_id = %s AND status = 'paid'\"\n            \" AND contact_id = ANY(%s)\"\n            \" GROUP BY contact_id\",\n            (client_id, ids),\n        )\n        return {str(row.get(\"contact_id\") or \"\"): int(row.get(\"orders\") or 0)\n                for row in portal_db.rows(cur)}\n    except Exception:\n        return {}\n\n\ndef _tags_map(cur, client_id, conversation_ids) -> dict:"], ["    include_counts = (request.args.get(\"include\") or \"\").strip().lower() == \"counts\"\n    starred_filter = (request.args.get(\"starred\") or \"\").strip()\n    if starred_filter != \"1\":\n        starred_filter = \"\"\n\n    sql = (\n        \"SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,\"\n        \" c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,\"\n        \" c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name,\"", "    include_counts = (request.args.get(\"include\") or \"\").strip().lower() == \"counts\"\n    include_raw = (request.args.get(\"include\") or \"\").strip().lower()\n    include_vip = \"vip\" in include_raw.split(\",\")\n    starred_filter = (request.args.get(\"starred\") or \"\").strip()\n    if starred_filter != \"1\":\n        starred_filter = \"\"\n\n    sql = (\n        \"SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,\"\n        \" c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,\"\n        \" c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name,\""], ["        return jsonify(portal_db.portal_unavailable(error, \"conversations read\")[0]), 503\n\n    conversations = []\n    for row in found:\n        item = _conversation_public(row)\n        item[\"tags\"] = tags_map.get(row.get(\"id\"), [])\n        conversations.append(item)\n\n    counts = {\"needs_reply\": 0, \"overdue\": 0, \"unassigned\": 0, \"unread\": 0}", "        return jsonify(portal_db.portal_unavailable(error, \"conversations read\")[0]), 503\n\n    conversations = []\n    for row in found:\n        item = _conversation_public(row)\n        item[\"tags\"] = tags_map.get(row.get(\"id\"), [])\n        conversations.append(item)\n\n    if include_vip:\n        vip_map = {}\n        try:\n            portal_db.ensure_tables()\n            conn = portal_db._conn()\n            try:\n                with conn.cursor() as cur:\n                    vip_map = _paid_order_counts(\n                        cur, principal[\"client_id\"],\n                        [row.get(\"contact_id\") for row in found])\n            finally:\n                conn.close()\n        except Exception:\n            vip_map = {}\n        for item in conversations:\n            orders = int(vip_map.get(str(item.get(\"contact_id\") or \"\"), 0))\n            item[\"paid_orders\"] = orders\n            item[\"vip\"] = orders >= VIP_THRESHOLD\n\n    counts = {\"needs_reply\": 0, \"overdue\": 0, \"unassigned\": 0, \"unread\": 0}"], ["    conversation_public[\"tags\"] = detail_tags\n    return jsonify({\n        \"conversation\": conversation_public,", "    conversation_public[\"tags\"] = detail_tags\n    vip_map = {}\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            with conn.cursor() as cur:\n                vip_map = _paid_order_counts(\n                    cur, principal[\"client_id\"],\n                    [found[0].get(\"contact_id\")])\n        finally:\n            conn.close()\n    except Exception:\n        vip_map = {}\n    vip_orders = int(vip_map.get(str(found[0].get(\"contact_id\") or \"\"), 0))\n    conversation_public[\"paid_orders\"] = vip_orders\n    conversation_public[\"vip\"] = vip_orders >= VIP_THRESHOLD\n    return jsonify({\n        \"conversation\": conversation_public,"]]);
applySwaps(WEB + "/lib/omniflow/portal.ts", "include=counts,vip", false, [["  needsReply: boolean;\n  lastIntent: string | null;", "  needsReply: boolean;\n  vip: boolean;\n  paidOrders: number;\n  lastIntent: string | null;"], ["    needsReply: p.needs_reply === true,\n    lastIntent: typeof p.last_intent === \"string\" ? p.last_intent : null,", "    needsReply: p.needs_reply === true,\n    vip: p.vip === true,\n    paidOrders: typeof p.paid_orders === \"number\" ? p.paid_orders : 0,\n    lastIntent: typeof p.last_intent === \"string\" ? p.last_intent : null,"], ["      ? \"assigned=\" + assignedFilter\n      : \"\";\n  const countsPart = includeCounts ? \"include=counts\" : \"\";\n  const limitPart =", "      ? \"assigned=\" + assignedFilter\n      : \"\";\n  const countsPart = includeCounts ? \"include=counts,vip\" : \"include=vip\";\n  const limitPart ="]]);
applySwaps(WEB + "/app/dashboard/(portal)/conversations/InboxClient.tsx", "\u2605 vip", false, [["  needsReply: boolean;\n  lastIntent: string | null;", "  needsReply: boolean;\n  vip: boolean;\n  paidOrders: number;\n  lastIntent: string | null;"], ["                      </p>\n                      {item.contactId ? (", "                      </p>\n                        {item.vip && (\n                          <span\n                            className=\"shrink-0 rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300\"\n                            title={\"VIP — \" + item.paidOrders + \" paid orders\"}\n                          >\n                            ★ vip\n                          </span>\n                        )}\n                      {item.contactId ? ("]]);

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");