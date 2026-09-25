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
function repairAppPy() {
  const path = CP + "/app.py";
  if (!fs.existsSync(path)) {
    console.log("SKIP (file not found): " + path);
    warnings++;
    return;
  }
  const original = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  let updated = original;
  const notes = [];
  let failures = 0;
  const addedProbes = [];

  function ensure(importLine, importProbe, registerLine, registerProbe,
                  importAnchors, registerAnchors, label) {
    if (updated.includes(importProbe)) {
      notes.push(label + " import: already present");
    } else {
      const res = insertAfterLine(updated, importLine, importAnchors);
      if (res) {
        updated = res.text;
        addedProbes.push(importProbe);
        notes.push(label + " import: ADDED after '" +
          res.anchor.slice(0, 44) + "'");
      } else {
        notes.push(label + " import: NO ANCHOR FOUND - report this");
        failures++;
        return;
      }
    }
    if (updated.includes(registerProbe)) {
      notes.push(label + " register: already present");
    } else {
      const res = insertAfterLine(updated, registerLine, registerAnchors);
      if (res) {
        updated = res.text;
        addedProbes.push(registerProbe);
        notes.push(label + " register: ADDED after '" +
          res.anchor.slice(0, 44) + "'");
      } else {
        notes.push(label + " register: NO ANCHOR FOUND - report this");
        failures++;
      }
    }
  }

  const importChain = [
    "from portal_revenue import",
    "from portal_winback import",
    "from portal_churn import",
    "from portal_reco import",
    "from portal_",
  ];
  const registerChain = [
    "aux_app.register_blueprint(portal_revenue_bp)",
    "aux_app.register_blueprint(portal_winback_bp)",
    "aux_app.register_blueprint(portal_churn_bp)",
    "aux_app.register_blueprint(portal_reco_bp)",
    "aux_app.register_blueprint(portal_",
  ];

  ensure(
    "from portal_restock import bp as portal_restock_bp  # noqa: E402",
    "from portal_restock import",
    "aux_app.register_blueprint(portal_restock_bp)",
    "aux_app.register_blueprint(portal_restock_bp)",
    importChain,
    registerChain,
    "restock"
  );
  ensure(
    "from portal_value import bp as portal_value_bp  # noqa: E402",
    "from portal_value import",
    "aux_app.register_blueprint(portal_value_bp)",
    "aux_app.register_blueprint(portal_value_bp)",
    ["from portal_restock import"].concat(importChain),
    ["aux_app.register_blueprint(portal_restock_bp)"].concat(registerChain),
    "value"
  );

  for (const note of notes) console.log("  ~ " + note);
  if (addedProbes.length === 0) {
    if (failures > 0) {
      warnings++;
      console.log("FAIL (anchors missing - nothing repaired): " + path);
      return;
    }
    already++;
    console.log("= " + path + " (registrations already complete)");
    return;
  }
  const backup = path + BACKUP_TAG + "repair";
  if (!fs.existsSync(backup)) fs.copyFileSync(path, backup);
  fs.writeFileSync(path, updated, "utf8");
  if (!compilePython(path)) {
    fs.copyFileSync(backup, path);
    console.log("FAIL (compile failed, restored): " + path);
    warnings++;
    return;
  }
  let verified = true;
  for (const probe of addedProbes) {
    if (!updated.includes(probe)) verified = false;
  }
  if (!verified) {
    fs.copyFileSync(backup, path);
    console.log("FAIL (verification failed, restored): " + path);
    warnings++;
    return;
  }
  if (failures > 0) warnings++;
  applied++;
  console.log("+ " + path + " (registrations repaired)");
}

repairAppPy();
writeNew(WEB + "/app/dashboard/(portal)/DailyBrief.tsx", "winback/queue", false, "\"use client\";\n\nimport Link from \"next/link\";\nimport { useEffect, useState } from \"react\";\n\ninterface BriefData {\n  carts: number;\n  reorders: number;\n  winbacks: number;\n  atRisk: number;\n  revenue: number;\n  delta: number | null;\n}\n\nexport default function DailyBrief() {\n  const [brief, setBrief] = useState<BriefData | null>(null);\n  const [failed, setFailed] = useState(false);\n\n  useEffect(() => {\n    let active = true;\n    void (async () => {\n      const getJson = async (\n        url: string\n      ): Promise<Record<string, unknown> | null> => {\n        try {\n          const response = await fetch(url, { cache: \"no-store\" });\n          if (!response.ok) return null;\n          const payload = await response.json().catch(() => null);\n          return payload !== null && typeof payload === \"object\"\n            ? (payload as Record<string, unknown>)\n            : null;\n        } catch {\n          return null;\n        }\n      };\n      const [queue, radar, revenue] = await Promise.all([\n        getJson(\"/api/omniflow/portal/winback/queue\"),\n        getJson(\"/api/omniflow/portal/churn/radar?limit=1\"),\n        getJson(\"/api/omniflow/portal/revenue/summary?days=7\"),\n      ]);\n      if (!active) return;\n      if (!queue && !radar && !revenue) {\n        setFailed(true);\n        return;\n      }\n      const queueCounts =\n        queue !== null && queue.counts !== null &&\n        typeof queue.counts === \"object\"\n          ? (queue.counts as Record<string, unknown>)\n          : {};\n      const radarCounts =\n        radar !== null && radar.counts !== null &&\n        typeof radar.counts === \"object\"\n          ? (radar.counts as Record<string, unknown>)\n          : {};\n      const num = (raw: Record<string, unknown>, key: string): number =>\n        typeof raw[key] === \"number\" ? (raw[key] as number) : 0;\n      setBrief({\n        carts: num(queueCounts, \"cart\"),\n        reorders: num(queueCounts, \"reorder\"),\n        winbacks: num(queueCounts, \"winback\"),\n        atRisk: num(radarCounts, \"at_risk\") + num(radarCounts, \"cooling\"),\n        revenue: revenue !== null ? num(revenue, \"revenue\") : 0,\n        delta:\n          revenue !== null && typeof revenue.delta_percent === \"number\"\n            ? (revenue.delta_percent as number)\n            : null,\n      });\n    })();\n    return () => {\n      active = false;\n    };\n  }, []);\n\n  if (failed || !brief) return null;\n\n  return (\n    <section className=\"mb-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4\">\n      <div className=\"flex flex-wrap items-center justify-between gap-2\">\n        <p className=\"text-xs font-semibold text-white\">Today</p>\n        <div className=\"flex gap-3 text-[10px]\">\n          <Link\n            href=\"/dashboard/growth\"\n            className=\"text-cyan-300 hover:underline\"\n          >\n            Growth\n          </Link>\n          <Link\n            href=\"/dashboard/winback\"\n            className=\"text-cyan-300 hover:underline\"\n          >\n            Win-back\n          </Link>\n          <Link\n            href=\"/dashboard/customers\"\n            className=\"text-cyan-300 hover:underline\"\n          >\n            Customers\n          </Link>\n        </div>\n      </div>\n      <ul className=\"mt-2 space-y-1 text-xs text-slate-300\">\n        <li>\n          Rs {brief.revenue.toLocaleString()} this week\n          {brief.delta !== null ? (\n            <span\n              className={\n                brief.delta >= 0 ? \" text-emerald-300\" : \" text-rose-300\"\n              }\n            >\n              {\" \"}\n              ({brief.delta >= 0 ? \"+\" : \"\"}\n              {brief.delta}% vs prior)\n            </span>\n          ) : null}\n        </li>\n        <li>\n          <span className=\"text-amber-300\">\n            {brief.carts + brief.reorders} to recover\n          </span>{\" \"}\n          · {brief.carts} open carts, {brief.reorders} reorders due\n          {brief.winbacks > 0 ? `, ${brief.winbacks} quiet payers` : \"\"}\n        </li>\n        {brief.atRisk > 0 ? (\n          <li>\n            <span className=\"text-rose-300\">\n              {brief.atRisk} customers cooling or at risk\n            </span>\n          </li>\n        ) : null}\n      </ul>\n    </section>\n  );\n}\n");
applySwaps(WEB + "/app/dashboard/(portal)/page.tsx", "DailyBrief", false, [["import SetupChecklist from \"../components/SetupChecklist\";", "import SetupChecklist from \"../components/SetupChecklist\";\nimport DailyBrief from \"./DailyBrief\";"], ["      <SetupChecklist />\n\n      {overview && (", "      <SetupChecklist />\n\n      <DailyBrief />\n\n      {overview && ("]]);

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");