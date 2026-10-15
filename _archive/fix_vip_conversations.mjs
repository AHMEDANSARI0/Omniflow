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

// portal_conversations.py turned out LAPTOP-DRIFTED (the 331/471 lesson
// applied to a CP module): add_batch_531_550.mjs anchored all four vip
// swaps on multi-line captured spans, so the laptop run reported
// "anchor NOT FOUND (1 partial hits)" and the CP file was left untouched
// (web files DID apply). This repair installs the same four pieces with
// SINGLE-LINE anchor chains + a compile gate, line-based, all-or-nothing.
function repairVipConvos() {
  const path = CP + "/portal_conversations.py";
  if (!fs.existsSync(path)) {
    console.log("SKIP (file not found): " + path);
    warnings++;
    return;
  }
  const original = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const doneProbes = [
    "VIP_THRESHOLD",
    'include_vip = "vip" in',
    'item["paid_orders"] = orders',
    'conversation_public["paid_orders"]',
  ];
  if (doneProbes.every((p) => original.includes(p))) {
    console.log("= " + path + " (vip already installed)");
    already++;
    return;
  }
  const backup = path + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(path, backup);
  let lines = original.split("\n");
  const notes = [];
  let failures = 0;

  function text() {
    return lines.join("\n");
  }

  function insertBlock(blockText, anchors, probe, label, pad) {
    if (text().includes(probe)) {
      notes.push(label + ": already present");
      return;
    }
    const block = blockText.split("\n");
    for (const entry of anchors) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(entry.anchor)) {
          const at = entry.mode === "after" ? i + 1 : i;
          const payload = block.concat(new Array(pad || 0).fill(""));
          lines.splice(at, 0, ...payload);
          notes.push(label + ": ADDED " + entry.mode + " '" +
            entry.anchor.slice(0, 44) + "'");
          return;
        }
      }
    }
    notes.push(label + ": NO ANCHOR FOUND - report this");
    failures++;
  }

  insertBlock("VIP_THRESHOLD = 3  # paid orders that turn a contact into a VIP\n\n\ndef _paid_order_counts(cur, client_id, contact_ids):\n    \"\"\"contact_id -> paid order count ({} when the links table is absent).\"\"\"\n    ids = sorted({str(cid).strip() for cid in contact_ids\n                  if cid and str(cid).strip()})\n    if not ids:\n        return {}\n    try:\n        cur.execute(\"SELECT to_regclass(%s) AS oid\",\n                    (\"portal_checkout_links\",))\n        rows = portal_db.rows(cur)\n        if not rows or not rows[0].get(\"oid\"):\n            return {}\n        cur.execute(\n            \"SELECT contact_id, COUNT(*) AS orders FROM portal_checkout_links\"\n            \" WHERE client_id = %s AND status = 'paid'\"\n            \" AND contact_id = ANY(%s)\"\n            \" GROUP BY contact_id\",\n            (client_id, ids),\n        )\n        return {str(row.get(\"contact_id\") or \"\"): int(row.get(\"orders\") or 0)\n                for row in portal_db.rows(cur)}\n    except Exception:\n        return {}", [
    { anchor: "def _tags_map(cur, client_id, conversation_ids) -> dict:", mode: "before" },
    { anchor: "def _tags_map(cur, client_id, conversation_ids)", mode: "before" },
    { anchor: "def _tags_map(", mode: "before" },
  ], "VIP_THRESHOLD", "vip helper", 2);

  insertBlock("    include_raw = (request.args.get(\"include\") or \"\").strip().lower()\n    include_vip = \"vip\" in include_raw.split(\",\")", [
    { anchor: 'include_counts = (request.args.get("include") or "").strip().lower() == "counts"', mode: "after" },
    { anchor: "include_counts = (request.args.get", mode: "after" },
  ], 'include_vip = "vip" in', "include=vip parse", 0);

  insertBlock("    if include_vip:\n        vip_map = {}\n        try:\n            portal_db.ensure_tables()\n            conn = portal_db._conn()\n            try:\n                with conn.cursor() as cur:\n                    vip_map = _paid_order_counts(\n                        cur, principal[\"client_id\"],\n                        [row.get(\"contact_id\") for row in found])\n            finally:\n                conn.close()\n        except Exception:\n            vip_map = {}\n        for item in conversations:\n            orders = int(vip_map.get(str(item.get(\"contact_id\") or \"\"), 0))\n            item[\"paid_orders\"] = orders\n            item[\"vip\"] = orders >= VIP_THRESHOLD", [
    { anchor: 'counts = {"needs_reply"', mode: "before" },
    { anchor: "conversations.append(item)", mode: "after" },
  ], 'item["paid_orders"] = orders', "vip list block", 1);

  insertBlock("    vip_map = {}\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            with conn.cursor() as cur:\n                vip_map = _paid_order_counts(\n                    cur, principal[\"client_id\"],\n                    [found[0].get(\"contact_id\")])\n        finally:\n            conn.close()\n    except Exception:\n        vip_map = {}\n    vip_orders = int(vip_map.get(str(found[0].get(\"contact_id\") or \"\"), 0))\n    conversation_public[\"paid_orders\"] = vip_orders\n    conversation_public[\"vip\"] = vip_orders >= VIP_THRESHOLD", [
    { anchor: 'conversation_public["tags"] = detail_tags', mode: "after" },
    { anchor: '["tags"] = detail_tags', mode: "after" },
  ], 'conversation_public["paid_orders"]', "vip detail block", 0);

  if (failures) {
    for (const n of notes) console.log("  ~ " + n);
    console.log("FAIL (" + failures + " piece(s) without anchor, nothing written): " + path);
    warnings++;
    return;
  }
  fs.writeFileSync(path, lines.join("\n"), "utf8");
  if (!compilePython(path)) {
    fs.copyFileSync(backup, path);
    console.log("FAIL (compile failed, restored): " + path);
    warnings++;
    return;
  }
  const missing = doneProbes.filter((p) => !text().includes(p));
  if (missing.length) {
    fs.copyFileSync(backup, path);
    console.log("FAIL (probe verify failed: " + JSON.stringify(missing) + ", restored): " + path);
    warnings++;
    return;
  }
  for (const n of notes) console.log("  ~ " + n);
  console.log("+ " + path + " (vip repair: " + notes.length + " pieces)");
  applied++;
}

repairVipConvos();

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");