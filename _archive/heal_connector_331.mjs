// heal_connector_331.mjs - one-shot heal for connector_api.py channel-safe
// ingest (batch 331) + listen/routing hooks (batch 351), tolerant of local
// text variants in the conversation-INSERT line. Idempotent: safe to rerun.
// Run from the folder that CONTAINS OmniFlow-Control-Plane (same place you
// run the batch patchers):  node heal_connector_331.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = "OmniFlow-Control-Plane/connector_api.py";
const BACKUP = REPO + ".pre_heal331";

if (!fs.existsSync(REPO)) {
  console.log("NOT FOUND: " + REPO + " (run from the folder above the repo)");
  process.exit(1);
}
let src = fs.readFileSync(REPO, "utf8").replace(/\r\n/g, "\n");
if (!fs.existsSync(BACKUP)) fs.copyFileSync(REPO, BACKUP);

const done = [];
const failed = [];

function step(name, marker, apply) {
  if (src.includes(marker)) {
    done.push(name + " (already)");
    return true;
  }
  try {
    src = apply(src);
    if (!src.includes(marker)) throw new Error("marker missing after apply");
    done.push(name);
    return true;
  } catch (error) {
    failed.push(name + " :: " + error.message);
    return false;
  }
}

const L = (arr) => arr.join("\n") + "\n";

// 1. channel constants
step("ALLOWED_CHANNELS const", "ALLOWED_CHANNELS", (s) =>
  s.replace(/^(ALLOWED_DIRECTIONS = .*)$/m,
    "$1\nALLOWED_CHANNELS = (\"whatsapp\", \"telegram\")"));

// 2. ingest channel validation (right after the direction check)
step("ingest channel validation", 'channel whatsapp|telegram hon."', (s) => {
  const from = L([
    '        direction = item.get("direction", "in")',
    "        if direction not in ALLOWED_DIRECTIONS:",
    '            return jsonify({"error": {"code": "bad_request",',
    '                                      "message": "direction in|out hon."}}), 400',
  ]);
  const to = from + L([
    '        channel = item.get("channel", "whatsapp")',
    "        if channel not in ALLOWED_CHANNELS:",
    '            return jsonify({"error": {"code": "bad_request",',
    '                                      "message": "channel whatsapp|telegram hon."}}), 400',
  ]).slice(0, -1); // no trailing newline duplication
  return s.replace(from, from + L([
    '        channel = item.get("channel", "whatsapp")',
    "        if channel not in ALLOWED_CHANNELS:",
    '            return jsonify({"error": {"code": "bad_request",',
    '                                      "message": "channel whatsapp|telegram hon."}}), 400',
  ]));
});

// 3. normalized.append carries the channel
step("normalized.append channel", '"channel": channel,', (s) =>
  s.replace(
    L(["            \"direction\": direction,", "        })"]),
    L([
      '            "direction": direction,',
      '            "channel": channel,',
      "        })",
    ])
  ));

// 4. commands poll: channel param validation
step("commands channel param", 'args.get("channel")', (s) =>
  s.replace(
    L(["    limit = _query_int(\"limit\", 20, 1, 50)", "", "    try:"]),
    L([
      "    limit = _query_int(\"limit\", 20, 1, 50)",
      "    channel = (args.get(\"channel\") or \"\").strip()",
      "    if channel and channel not in ALLOWED_CHANNELS:",
      "        return jsonify({\"error\": {\"code\": \"bad_request\",",
      "                                  \"message\": \"channel whatsapp|telegram hon.\"}}), 400",
      "",
      "    try:",
    ])
  ));

// 5. commands poll: SQL channel filter
step("commands SQL filter", "cmd_params", (s) =>
  s.replace(
    L([
      "                cur.execute(",
      "                    \"SELECT id, action, payload, created_at FROM \"",
      "                    + portal_db._q(portal_db.CMD_TABLE) +",
      "                    \" WHERE client_id = %s AND status = 'pending'\"",
      "                    \" ORDER BY id ASC LIMIT %s\",",
      "                    (tenant[\"client_id\"], limit),",
      "                )",
    ]),
    L([
      "                cmd_sql = (",
      "                    \"SELECT id, action, payload, created_at FROM \"",
      "                    + portal_db._q(portal_db.CMD_TABLE) +",
      "                    \" WHERE client_id = %s AND status = 'pending'\"",
      "                )",
      "                cmd_params: list = [tenant[\"client_id\"]]",
      "                if channel:",
      "                    cmd_sql += \" AND channel = %s\"",
      "                    cmd_params.append(channel)",
      "                    cmd_sql += \" ORDER BY id ASC LIMIT %s\".replace(\" AND channel = %s\", \"\")",
      "                    cmd_params.append(limit)",
      "                cur.execute(cmd_sql, tuple(cmd_params))",
    ]).replace(
      "                    cmd_sql += \" ORDER BY id ASC LIMIT %s\".replace(\" AND channel = %s\", \"\")\n",
      ""
    ).replace("                    cmd_params.append(limit)", "                cmd_sql += \" ORDER BY id ASC LIMIT %s\"\n                cmd_params.append(limit)")
));

// 6. conversation INSERT VALUES line (VARIANT-TOLERANT: whole-line regex)
function fixValues(s) {
  const re = /^[ ]*"VALUES \(%s, 'whatsapp',.*$/gm;
  const hits = s.match(re);
  if (!hits || hits.length === 0) {
    const lines = s.split("\n")
      .map((line, i) => (line.includes("'whatsapp'") ? (i + 1) + ": " + line.trim() : null))
      .filter(Boolean)
      .join("\n");
    throw new Error("VALUES line not found. Lines containing 'whatsapp':\n" + lines);
  }
  if (hits.length !== 1) throw new Error(hits.length + " VALUES lines matched");
  return s.replace(re, "                        \"VALUES (%s, %s, %s, %s, 'open', %s, NOW(), NOW(), NOW()) \"");
}
step("INSERT VALUES line (variant-safe)", '"VALUES (%s, %s, %s, %s, \'open\', %s, NOW(), NOW(), NOW()) "', fixValues);

// 7. INSERT params tuple (channel added)
step("INSERT params channel", 'item["channel"], item["from"],', (s) =>
  s.replace(
    /^[ ]*\(tenant\["client_id"\], item\["from"\], item\["name"\], item\["body"\].*$/gm,
    "                        (tenant[\"client_id\"], item[\"channel\"], item[\"from\"],\n                         item[\"name\"], item[\"body\"]),"
  ));

// 8. opt-out hook (batch 331) before the sequences hook
const SEQ_ANCHOR = L([
  "                    try:",
  "                        portal_sequences.maybe_enroll_new_contact(",
]);
step("opt-out ingest hook", "maybe_opt_out", (s) => {
  const count = s.split(SEQ_ANCHOR).length - 1;
  if (count !== 1) throw new Error("sequences anchor x" + count);
  return s.replace(SEQ_ANCHOR, "                    if item[\"direction\"] == \"in\":\n                        try:\n                            import portal_compliance\n\n                            portal_compliance.maybe_opt_out(\n                                tenant[\"client_id\"],\n                                item[\"from\"],\n                                item[\"body\"],\n                                conn,\n                            )\n                        except Exception:\n                            pass\n" + SEQ_ANCHOR);
});

// 9. listen + routing hooks (batch 351)
step("listen/routing hooks", "maybe_route", (s) => {
  const count = s.split(SEQ_ANCHOR).length - 1;
  if (count !== 1) throw new Error("sequences anchor x" + count);
  return s.replace(SEQ_ANCHOR, "                        try:\n                            import portal_listen\n\n                            portal_listen.maybe_listen(\n                                tenant[\"client_id\"],\n                                conversation_id,\n                                item[\"from\"],\n                                item[\"body\"],\n                                conn,\n                            )\n                        except Exception:\n                            pass\n                        try:\n                            import portal_routing\n\n                            portal_routing.maybe_route(\n                                tenant[\"client_id\"],\n                                conversation_id,\n                                item[\"from\"],\n                                item[\"body\"],\n                                conn,\n                            )\n                        except Exception:\n                            pass\n" + SEQ_ANCHOR);
});

// 10. portal_contacts import if the 311 hook exists without it
if (src.includes("portal_contacts.maybe_detect_language") &&
    !src.includes("\nimport portal_contacts\n")) {
  src = src.replace("import portal_cod\n", "import portal_cod\nimport portal_contacts\n");
  done.push("portal_contacts import (healed)");
}

fs.writeFileSync(REPO, src);

let compile = "SKIPPED";
try {
  execFileSync("python", ["-m", "py_compile", REPO], { stdio: "pipe" });
  compile = "OK";
} catch (error) {
  compile = "FAILED: " + String(error.stderr || error.message).slice(0, 400);
}

console.log("");
console.log("HEAL SUMMARY: " + done.length + " ok, " + failed.length + " failed, py_compile " + compile);
done.forEach((d) => console.log("  + " + d));
failed.forEach((f) => console.log("  ? " + f));
if (failed.length > 0 || compile !== "OK") {
  console.log("");
  console.log("Paste the HEAL SUMMARY above back into the chat.");
  process.exit(1);
}
console.log("");
console.log("connector_api.py is channel-safe now. Rerun both patchers:");
console.log("  node add_batch_331_350.mjs   (connector should say: already done)");
console.log("  node add_batch_351_370.mjs   (connector should say: already done)");