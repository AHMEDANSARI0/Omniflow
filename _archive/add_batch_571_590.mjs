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
applySwaps(CP + "/portal_checkout.py", "portal_cart_reminders", true, [["_SETTINGS_DDL_READY = False\nMAX_ITEMS = 20", "_SETTINGS_DDL_READY = False\nCART_TABLE = \"portal_cart_reminders\"\n_CART_DDL_READY = False\nCART_SEND_CAP = 5\nCART_GAP_DEFAULTS = {1: 2, 2: 24, 3: 48}\nDEFAULT_CART_TEMPLATES = {\n    1: \"Assalam o alaikum! You left '{title}' ({total}) in your cart.\"\n       \" Complete your order before it runs out of stock.\",\n    2: \"Still thinking about '{title}'? It is reserved for you - reply\"\n       \" here and we will confirm your order right away.\",\n    3: \"Last reminder: your cart '{title}' ({total}) expires soon. Pay\"\n       \" via the checkout link or reply here to place your order.\",\n}\nMAX_ITEMS = 20"], ["            \" tpl_delivered TEXT NOT NULL DEFAULT '',\"\n            \" updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\"\n        )\n    conn.commit()\n    _SETTINGS_DDL_READY = True", "            \" tpl_delivered TEXT NOT NULL DEFAULT '',\"\n            \" updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\"\n        )\n        for column in (\n            \"cart_enabled BOOLEAN NOT NULL DEFAULT FALSE\",\n            \"cart_gap_1 INTEGER NOT NULL DEFAULT 2\",\n            \"cart_gap_2 INTEGER NOT NULL DEFAULT 24\",\n            \"cart_gap_3 INTEGER NOT NULL DEFAULT 48\",\n            \"cart_tpl_1 TEXT NOT NULL DEFAULT ''\",\n            \"cart_tpl_2 TEXT NOT NULL DEFAULT ''\",\n            \"cart_tpl_3 TEXT NOT NULL DEFAULT ''\",\n        ):\n            cur.execute(\n                \"ALTER TABLE \" + portal_db._q(SETTINGS_TABLE) +\n                \" ADD COLUMN IF NOT EXISTS \" + column\n            )\n    conn.commit()\n    _SETTINGS_DDL_READY = True"], ["    return body[:1000]\n\n\ndef _normalize_items(raw: Any) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:", "    return body[:1000]\n\n\ndef _ensure_cart_table(conn) -> None:\n    global _CART_DDL_READY\n    if _CART_DDL_READY:\n        return\n    with conn.cursor() as cur:\n        cur.execute(\n            \"CREATE TABLE IF NOT EXISTS \" + portal_db._q(CART_TABLE) +\n            \" (id BIGSERIAL PRIMARY KEY,\"\n            \" client_id BIGINT NOT NULL,\"\n            \" link_id BIGINT NOT NULL,\"\n            \" step INTEGER NOT NULL,\"\n            \" sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\"\n            \" UNIQUE (client_id, link_id, step))\"\n        )\n        cur.execute(\n            \"CREATE INDEX IF NOT EXISTS portal_cart_reminders_client_idx ON \"\n            + portal_db._q(CART_TABLE) + \" (client_id, link_id, step)\"\n        )\n    conn.commit()\n    _CART_DDL_READY = True\n\n\ndef _load_cart_settings(cur, client_id):\n    \"\"\"Cart recovery settings. Absent row or unreadable table -> defaults\n    (recovery OFF until the merchant turns it on).\"\"\"\n    try:\n        cur.execute(\n            \"SELECT cart_enabled, cart_gap_1, cart_gap_2, cart_gap_3,\"\n            \" cart_tpl_1, cart_tpl_2, cart_tpl_3 FROM \"\n            + portal_db._q(SETTINGS_TABLE) + \" WHERE client_id = %s\",\n            (client_id,),\n        )\n        rows = portal_db.rows(cur)\n    except Exception:\n        rows = []\n    row = rows[0] if rows else {}\n\n    def _gap(key):\n        try:\n            value = int(row.get(key))\n        except (TypeError, ValueError):\n            return None\n        return value if 1 <= value <= 168 else None\n\n    settings = {\n        \"cart_enabled\": bool(row.get(\"cart_enabled\", False)) if rows else False,\n        \"cart_gap_1\": _gap(\"cart_gap_1\") or CART_GAP_DEFAULTS[1],\n        \"cart_gap_2\": _gap(\"cart_gap_2\") or CART_GAP_DEFAULTS[2],\n        \"cart_gap_3\": _gap(\"cart_gap_3\") or CART_GAP_DEFAULTS[3],\n    }\n    for key in (\"cart_tpl_1\", \"cart_tpl_2\", \"cart_tpl_3\"):\n        settings[key] = str(row.get(key) or \"\").strip()[:500]\n    return settings\n\n\ndef _render_cart_body(settings, step, title, total, name=\"\"):\n    \"\"\"Fill {name}/{title}/{total}; blank custom template -> default.\"\"\"\n    template = str(settings.get(\"cart_tpl_\" + str(step)) or \"\").strip()\n    if not template:\n        template = DEFAULT_CART_TEMPLATES.get(int(step), \"\")\n    clean_name = str(name or \"\").strip()\n    first_name = clean_name.split(\" \")[0] if clean_name else \"\"\n    return (template\n            .replace(\"{name}\", first_name)\n            .replace(\"{title}\", str(title or \"\"))\n            .replace(\"{total}\", str(total if total is not None else \"\")))[:1000]\n\n\ndef materialize_cart_reminders(cur, client_id, conn) -> int:\n    \"\"\"Time-based cart recovery: up to 3 WhatsApp reminders per open\n    checkout link, riding the connector tick (like scheduled broadcasts).\n    Returns the number of reminders queued. Never raises for missing\n    tables - recovery silently stays off on fresh workspaces.\"\"\"\n    settings = _load_cart_settings(cur, client_id)\n    if not settings[\"cart_enabled\"]:\n        return 0\n    _ensure_cart_table(conn)\n    sent = 0\n    for step in (1, 2, 3):\n        if sent >= CART_SEND_CAP:\n            break\n        gap = settings[\"cart_gap_\" + str(step)]\n        cur.execute(\n            \"SELECT l.id, l.contact_id, l.title, l.total\"\n            \" FROM \" + portal_db._q(LINKS_TABLE) + \" l\"\n            \" WHERE l.client_id = %s AND l.status = 'open'\"\n            \" AND l.created_at <= NOW() - (%s || ' hours')::interval\"\n            \" AND NOT EXISTS (SELECT 1 FROM \" + portal_db._q(CART_TABLE) +\n            \" r WHERE r.client_id = l.client_id AND r.link_id = l.id\"\n            \" AND r.step = %s)\"\n            \" ORDER BY l.id ASC LIMIT %s\",\n            (client_id, str(gap), step, CART_SEND_CAP - sent),\n        )\n        due_rows = portal_db.rows(cur)\n        for row in due_rows:\n            if sent >= CART_SEND_CAP:\n                break\n            contact_id = str(row.get(\"contact_id\") or \"\").strip()\n            if not contact_id:\n                continue\n            name = _contact_name(cur, client_id, contact_id)\n            body = _render_cart_body(\n                settings, step, row.get(\"title\"), row.get(\"total\"), name)\n            portal_growth._send_command(\n                cur, client_id, contact_id, name, body, \"cart_recovery\",\n            )\n            cur.execute(\n                \"INSERT INTO \" + portal_db._q(CART_TABLE) +\n                \" (client_id, link_id, step) VALUES (%s, %s, %s)\"\n                \" ON CONFLICT (client_id, link_id, step) DO NOTHING\",\n                (client_id, int(row.get(\"id\") or 0), step),\n            )\n            portal_db.log_action(\n                cur,\n                client_id,\n                \"cart.recovery_step_\" + str(step),\n                \"system\",\n                None,\n                None,\n                (\"Cart reminder \" + str(step) + \" queued\")[:200],\n            )\n            sent += 1\n    if sent:\n        conn.commit()\n    return sent\n\n\ndef _normalize_items(raw: Any) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:"], ["                    \"SELECT notify_enabled, tpl_paid, tpl_shipped,\"\n                    \" tpl_delivered FROM \" + portal_db._q(SETTINGS_TABLE) +\n                    \" WHERE client_id = %s\",", "                    \"SELECT notify_enabled, tpl_paid, tpl_shipped,\"\n                    \" tpl_delivered, cart_enabled, cart_gap_1, cart_gap_2,\"\n                    \" cart_gap_3, cart_tpl_1, cart_tpl_2, cart_tpl_3 FROM \"\n                    + portal_db._q(SETTINGS_TABLE) +\n                    \" WHERE client_id = %s\","], ["        logger.warning(\"checkout settings read failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error, \"checkout settings\")[0]), 503\n    row = rows[0] if rows else {}\n    return jsonify({", "        logger.warning(\"checkout settings read failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error, \"checkout settings\")[0]), 503\n    row = rows[0] if rows else {}\n\n    def _gap_out(key):\n        try:\n            value = int(row.get(key))\n        except (TypeError, ValueError):\n            return None\n        return value if 1 <= value <= 168 else None\n\n    cart = {\n        \"enabled\": bool(row.get(\"cart_enabled\", False)),\n        \"gap_1\": _gap_out(\"cart_gap_1\") or CART_GAP_DEFAULTS[1],\n        \"gap_2\": _gap_out(\"cart_gap_2\") or CART_GAP_DEFAULTS[2],\n        \"gap_3\": _gap_out(\"cart_gap_3\") or CART_GAP_DEFAULTS[3],\n        \"tpl_1\": str(row.get(\"cart_tpl_1\") or \"\").strip()[:500],\n        \"tpl_2\": str(row.get(\"cart_tpl_2\") or \"\").strip()[:500],\n        \"tpl_3\": str(row.get(\"cart_tpl_3\") or \"\").strip()[:500],\n    }\n    return jsonify({"], ["            \"tpl_delivered\": str(row.get(\"tpl_delivered\") or \"\").strip()[:500],\n        },", "            \"tpl_delivered\": str(row.get(\"tpl_delivered\") or \"\").strip()[:500],\n            \"cart\": cart if rows else {\n                \"enabled\": False,\n                \"gap_1\": CART_GAP_DEFAULTS[1],\n                \"gap_2\": CART_GAP_DEFAULTS[2],\n                \"gap_3\": CART_GAP_DEFAULTS[3],\n                \"tpl_1\": \"\", \"tpl_2\": \"\", \"tpl_3\": \"\",\n            },\n        },"], ["        templates[key] = value\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_settings_table(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"INSERT INTO \" + portal_db._q(SETTINGS_TABLE) +", "        templates[key] = value\n    cart_in = settings_in.get(\"cart\")\n    cart_provided = isinstance(cart_in, dict)\n    cart_in = cart_in if cart_provided else {}\n    cart_enabled = cart_in.get(\"enabled\") is True\n    gaps = {}\n    for key in (1, 2, 3):\n        if not cart_provided:\n            gaps[key] = CART_GAP_DEFAULTS[key]\n            continue\n        try:\n            gap = int(cart_in.get(\"gap_\" + str(key)))\n        except (TypeError, ValueError):\n            gap = 0\n        if not 1 <= gap <= 168:\n            return jsonify({\"error\": {\"code\": \"bad_request\",\n                                      \"message\": \"Reminder gaps are 1 to\"\n                                                 \" 168 hours.\"}}), 400\n        gaps[key] = gap\n    cart_templates = {}\n    for key in (1, 2, 3):\n        value = str(cart_in.get(\"tpl_\" + str(key)) or \"\").strip()\n        if len(value) > 500:\n            return jsonify({\"error\": {\"code\": \"bad_request\",\n                                      \"message\": \"Templates are capped at\"\n                                                 \" 500 characters.\"}}), 400\n        cart_templates[key] = value\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            _ensure_settings_table(conn)\n            with conn.cursor() as cur:\n                cur.execute(\n                    \"INSERT INTO \" + portal_db._q(SETTINGS_TABLE) +"], ["                    \" (client_id, notify_enabled, tpl_paid, tpl_shipped,\"\n                    \" tpl_delivered, updated_at)\"\n                    \" VALUES (%s, %s, %s, %s, %s, NOW())\"\n                    \" ON CONFLICT (client_id) DO UPDATE SET\"", "                    \" (client_id, notify_enabled, tpl_paid, tpl_shipped,\"\n                    \" tpl_delivered, cart_enabled, cart_gap_1, cart_gap_2,\"\n                    \" cart_gap_3, cart_tpl_1, cart_tpl_2, cart_tpl_3,\"\n                    \" updated_at)\"\n                    \" VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,\"\n                    \" %s, NOW())\"\n                    \" ON CONFLICT (client_id) DO UPDATE SET\""], ["                    \" tpl_delivered = EXCLUDED.tpl_delivered,\"\n                    \" updated_at = NOW()\",", "                    \" tpl_delivered = EXCLUDED.tpl_delivered,\"\n                    \" cart_enabled = EXCLUDED.cart_enabled,\"\n                    \" cart_gap_1 = EXCLUDED.cart_gap_1,\"\n                    \" cart_gap_2 = EXCLUDED.cart_gap_2,\"\n                    \" cart_gap_3 = EXCLUDED.cart_gap_3,\"\n                    \" cart_tpl_1 = EXCLUDED.cart_tpl_1,\"\n                    \" cart_tpl_2 = EXCLUDED.cart_tpl_2,\"\n                    \" cart_tpl_3 = EXCLUDED.cart_tpl_3,\"\n                    \" updated_at = NOW()\","], ["                     templates[\"paid\"], templates[\"shipped\"],\n                     templates[\"delivered\"]),\n                )\n                portal_db.log_action(\n                    cur,\n                    principal[\"client_id\"],\n                    \"checkout.settings\",", "                     templates[\"paid\"], templates[\"shipped\"],\n                     templates[\"delivered\"], cart_enabled,\n                     gaps[1], gaps[2], gaps[3],\n                     cart_templates[1], cart_templates[2],\n                     cart_templates[3]),\n                )\n                portal_db.log_action(\n                    cur,\n                    principal[\"client_id\"],\n                    \"checkout.settings\","]]);
applySwaps(WEB + "/lib/omniflow/portal.ts", "normalizeCart", false, [["  tplDelivered: string;\n}\n\nexport async function getCheckoutNotifySettings(", "  tplDelivered: string;\n  cartEnabled: boolean;\n  cartGap1: number;\n  cartGap2: number;\n  cartGap3: number;\n  cartTpl1: string;\n  cartTpl2: string;\n  cartTpl3: string;\n}\n\nfunction normalizeCart(raw: Record<string, unknown>): {\n  cartEnabled: boolean;\n  cartGap1: number;\n  cartGap2: number;\n  cartGap3: number;\n  cartTpl1: string;\n  cartTpl2: string;\n  cartTpl3: string;\n} {\n  const gap = (value: unknown, fallback: number): number =>\n    typeof value === \"number\" && Number.isFinite(value)\n      && value >= 1 && value <= 168\n      ? Math.floor(value)\n      : fallback;\n  return {\n    cartEnabled: raw.enabled === true,\n    cartGap1: gap(raw.gap_1, 2),\n    cartGap2: gap(raw.gap_2, 24),\n    cartGap3: gap(raw.gap_3, 48),\n    cartTpl1: typeof raw.tpl_1 === \"string\" ? raw.tpl_1 : \"\",\n    cartTpl2: typeof raw.tpl_2 === \"string\" ? raw.tpl_2 : \"\",\n    cartTpl3: typeof raw.tpl_3 === \"string\" ? raw.tpl_3 : \"\",\n  };\n}\n\nexport async function getCheckoutNotifySettings("], ["  const s = raw as Record<string, unknown>;\n  return {\n    notifyEnabled: s.notify_enabled === true,", "  const s = raw as Record<string, unknown>;\n  const cartRaw = s.cart !== null && typeof s.cart === \"object\"\n    ? (s.cart as Record<string, unknown>)\n    : {};\n  return {\n    notifyEnabled: s.notify_enabled === true,"], ["    tplDelivered: typeof s.tpl_delivered === \"string\" ? s.tpl_delivered : \"\",\n  };\n}\n\nexport async function saveCheckoutNotifySettings(", "    tplDelivered: typeof s.tpl_delivered === \"string\" ? s.tpl_delivered : \"\",\n    ...normalizeCart(cartRaw),\n  };\n}\n\nexport async function saveCheckoutNotifySettings("], ["            tpl_delivered: String(settings.tplDelivered || \"\").trim().slice(0, 500),\n          },\n        }),\n      }\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 400) return \"bad_request\";", "            tpl_delivered: String(settings.tplDelivered || \"\").trim().slice(0, 500),\n            cart: {\n              enabled: settings.cartEnabled === true,\n              gap_1: Number(settings.cartGap1) >= 1\n                && Number(settings.cartGap1) <= 168\n                ? Math.floor(Number(settings.cartGap1)) : 2,\n              gap_2: Number(settings.cartGap2) >= 1\n                && Number(settings.cartGap2) <= 168\n                ? Math.floor(Number(settings.cartGap2)) : 24,\n              gap_3: Number(settings.cartGap3) >= 1\n                && Number(settings.cartGap3) <= 168\n                ? Math.floor(Number(settings.cartGap3)) : 48,\n              tpl_1: String(settings.cartTpl1 || \"\").trim().slice(0, 500),\n              tpl_2: String(settings.cartTpl2 || \"\").trim().slice(0, 500),\n              tpl_3: String(settings.cartTpl3 || \"\").trim().slice(0, 500),\n            },\n          },\n        }),\n      }\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 400) return \"bad_request\";"]]);
applySwaps(WEB + "/app/api/omniflow/portal/checkout/settings/route.ts", "cartRaw", false, [["    tplDelivered: typeof raw.tpl_delivered === \"string\" ? raw.tpl_delivered.trim().slice(0, 500) : \"\",\n  };", "    tplDelivered: typeof raw.tpl_delivered === \"string\" ? raw.tpl_delivered.trim().slice(0, 500) : \"\",\n    cartEnabled: false,\n    cartGap1: 2,\n    cartGap2: 24,\n    cartGap3: 48,\n    cartTpl1: \"\",\n    cartTpl2: \"\",\n    cartTpl3: \"\",\n  };"], ["      400\n    );\n  }\n\n  try {\n    const result = await saveCheckoutNotifySettings(accessToken, settings);", "      400\n    );\n  }\n  const cartRaw =\n    raw.cart !== null && typeof raw.cart === \"object\"\n      ? (raw.cart as Record<string, unknown>)\n      : null;\n  if (cartRaw) {\n    settings.cartEnabled = cartRaw.enabled === true;\n    const gaps: [number, unknown, number][] = [\n      [1, cartRaw.gap_1, 2],\n      [2, cartRaw.gap_2, 24],\n      [3, cartRaw.gap_3, 48],\n    ];\n    for (const [slot, value, fallback] of gaps) {\n      if (\n        typeof value !== \"number\"\n        || !Number.isFinite(value)\n        || value < 1\n        || value > 168\n      ) {\n        if (value !== undefined && value !== null && value !== \"\") {\n          return safeJson(\n            { error: { code: \"bad_request\", message: \"Reminder gaps are 1 to 168 hours.\" } },\n            400\n          );\n        }\n        if (slot === 1) settings.cartGap1 = fallback;\n        if (slot === 2) settings.cartGap2 = fallback;\n        if (slot === 3) settings.cartGap3 = fallback;\n      } else {\n        if (slot === 1) settings.cartGap1 = Math.floor(value);\n        if (slot === 2) settings.cartGap2 = Math.floor(value);\n        if (slot === 3) settings.cartGap3 = Math.floor(value);\n      }\n    }\n    settings.cartTpl1 =\n      typeof cartRaw.tpl_1 === \"string\" ? cartRaw.tpl_1.trim().slice(0, 500) : \"\";\n    settings.cartTpl2 =\n      typeof cartRaw.tpl_2 === \"string\" ? cartRaw.tpl_2.trim().slice(0, 500) : \"\";\n    settings.cartTpl3 =\n      typeof cartRaw.tpl_3 === \"string\" ? cartRaw.tpl_3.trim().slice(0, 500) : \"\";\n  }\n\n  try {\n    const result = await saveCheckoutNotifySettings(accessToken, settings);"]]);
applySwaps(WEB + "/app/dashboard/(portal)/growth/OrderUpdatesSettings.tsx", "Cart recovery", false, [["  tplDelivered: string;\n}\n\nconst EMPTY: NotifySettings = {", "  tplDelivered: string;\n  cartEnabled: boolean;\n  cartGap1: number;\n  cartGap2: number;\n  cartGap3: number;\n  cartTpl1: string;\n  cartTpl2: string;\n  cartTpl3: string;\n}\n\nconst EMPTY: NotifySettings = {"], ["  tplDelivered: \"\",\n};", "  tplDelivered: \"\",\n  cartEnabled: false,\n  cartGap1: 2,\n  cartGap2: 24,\n  cartGap3: 48,\n  cartTpl1: \"\",\n  cartTpl2: \"\",\n  cartTpl3: \"\",\n};"], ["        tplDelivered: typeof s.tplDelivered === \"string\" ? s.tplDelivered : \"\",\n      });\n      setVisible(true);", "        tplDelivered: typeof s.tplDelivered === \"string\" ? s.tplDelivered : \"\",\n        cartEnabled: s.cartEnabled === true,\n        cartGap1: typeof s.cartGap1 === \"number\" ? s.cartGap1 : 2,\n        cartGap2: typeof s.cartGap2 === \"number\" ? s.cartGap2 : 24,\n        cartGap3: typeof s.cartGap3 === \"number\" ? s.cartGap3 : 48,\n        cartTpl1: typeof s.cartTpl1 === \"string\" ? s.cartTpl1 : \"\",\n        cartTpl2: typeof s.cartTpl2 === \"string\" ? s.cartTpl2 : \"\",\n        cartTpl3: typeof s.cartTpl3 === \"string\" ? s.cartTpl3 : \"\",\n      });\n      setVisible(true);"], ["            tpl_delivered: settings.tplDelivered.trim().slice(0, 500),\n          },", "            tpl_delivered: settings.tplDelivered.trim().slice(0, 500),\n            cart: {\n              enabled: settings.cartEnabled,\n              gap_1: settings.cartGap1,\n              gap_2: settings.cartGap2,\n              gap_3: settings.cartGap3,\n              tpl_1: settings.cartTpl1.trim().slice(0, 500),\n              tpl_2: settings.cartTpl2.trim().slice(0, 500),\n              tpl_3: settings.cartTpl3.trim().slice(0, 500),\n            },\n          },"], ["      if (response.ok) {\n        setNote(\"Saved. Customers get these updates automatically.\");\n      } else if (response.status === 400) {", "      if (response.ok) {\n        setNote(\n          settings.cartEnabled\n            ? \"Saved. Order updates and cart recovery are active.\"\n            : \"Saved. Customers get these updates automatically.\"\n        );\n      } else if (response.status === 400) {"], ["      </p>\n\n      <div className=\"mt-3 flex items-center gap-3\">", "      </p>\n\n      <div className=\"mt-5 border-t border-white/[0.06] pt-4\">\n        <div className=\"flex flex-wrap items-center justify-between gap-2\">\n          <div>\n            <h4 className=\"text-sm font-semibold text-slate-100\">\n              Cart recovery\n            </h4>\n            <p className=\"mt-0.5 text-xs text-slate-500\">\n              Up to three automatic WhatsApp reminders for checkout links\n              still open after each delay. Stops the moment a link is paid\n              or cancelled.\n            </p>\n          </div>\n          <button\n            type=\"button\"\n            role=\"switch\"\n            aria-checked={settings.cartEnabled}\n            onClick={() =>\n              setSettings((prev) => ({\n                ...prev,\n                cartEnabled: !prev.cartEnabled,\n              }))\n            }\n            className={`rounded-lg border px-2.5 py-1 text-[11px] ${\n              settings.cartEnabled\n                ? \"border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300\"\n                : \"border-white/[0.08] bg-white/[0.02] text-slate-400\"\n            }`}\n          >\n            {settings.cartEnabled ? \"Recovery on\" : \"Recovery off\"}\n          </button>\n        </div>\n\n        {settings.cartEnabled ? (\n          <>\n            <div className=\"mt-3 grid grid-cols-3 gap-2 sm:max-w-xs\">\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">After (1)</span>\n                <input\n                  type=\"number\"\n                  min={1}\n                  max={168}\n                  value={settings.cartGap1}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartGap1: Number(event.target.value) || 0,\n                    }))\n                  }\n                  className={FIELD_BASE}\n                />\n              </label>\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">Then (2)</span>\n                <input\n                  type=\"number\"\n                  min={1}\n                  max={168}\n                  value={settings.cartGap2}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartGap2: Number(event.target.value) || 0,\n                    }))\n                  }\n                  className={FIELD_BASE}\n                />\n              </label>\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">Then (3)</span>\n                <input\n                  type=\"number\"\n                  min={1}\n                  max={168}\n                  value={settings.cartGap3}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartGap3: Number(event.target.value) || 0,\n                    }))\n                  }\n                  className={FIELD_BASE}\n                />\n              </label>\n            </div>\n            <p className=\"mt-1 text-[10px] text-slate-600\">\n              Hours after the checkout link was created (1-168).\n            </p>\n            <div className=\"mt-3 grid gap-3 sm:grid-cols-3\">\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">\n                  Reminder 1\n                </span>\n                <textarea\n                  rows={3}\n                  value={settings.cartTpl1}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartTpl1: event.target.value,\n                    }))\n                  }\n                  placeholder=\"You left &apos;{title}&apos; ({total}) in your cart.\"\n                  className={FIELD_BASE}\n                />\n              </label>\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">\n                  Reminder 2\n                </span>\n                <textarea\n                  rows={3}\n                  value={settings.cartTpl2}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartTpl2: event.target.value,\n                    }))\n                  }\n                  placeholder=\"Still thinking about &apos;{title}&apos;?\"\n                  className={FIELD_BASE}\n                />\n              </label>\n              <label className=\"block\">\n                <span className=\"text-[11px] text-slate-400\">\n                  Reminder 3\n                </span>\n                <textarea\n                  rows={3}\n                  value={settings.cartTpl3}\n                  onChange={(event) =>\n                    setSettings((prev) => ({\n                      ...prev,\n                      cartTpl3: event.target.value,\n                    }))\n                  }\n                  placeholder=\"Last reminder for &apos;{title}&apos;.\"\n                  className={FIELD_BASE}\n                />\n              </label>\n            </div>\n          </>\n        ) : null}\n      </div>\n\n      <div className=\"mt-3 flex items-center gap-3\">"]]);

// connector_api.py is laptop-drifted territory (the 331 lesson): the cart
// tick is installed with a single-line anchor chain + compile gate instead
// of a multi-line captured span.
function repairCartTick() {
  const path = CP + "/connector_api.py";
  if (!fs.existsSync(path)) {
    console.log("SKIP (file not found): " + path);
    warnings++;
    return;
  }
  const original = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (original.includes("materialize_cart_reminders")) {
    console.log("= " + path + " (cart tick already present)");
    already++;
    return;
  }
  const backup = path + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(path, backup);
  const chains = [
    'portal_growth.materialize_due_broadcasts(cur, tenant["client_id"], conn)',
    "materialize_due_broadcasts(",
    "import portal_growth",
  ];
  const block = [
    "                    import portal_checkout",
    "",
    "                    portal_checkout.materialize_cart_reminders(",
    '                        cur, tenant["client_id"], conn',
    "                    )",
    "",
  ];
  const lines = original.split("\n");
  let insertAt = -1;
  let used = "";
  for (const anchor of chains) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(anchor)) {
        insertAt = i + 1;
        used = anchor;
        break;
      }
    }
    if (insertAt !== -1) break;
  }
  if (insertAt === -1) {
    console.log("  ? " + path + " :: NO ANCHOR FOUND - report this");
    warnings++;
    return;
  }
  lines.splice(insertAt, 0, ...block);
  fs.writeFileSync(path, lines.join("\n"), "utf8");
  if (!compilePython(path)) {
    fs.copyFileSync(backup, path);
    console.log("FAIL (compile failed, restored): " + path);
    warnings++;
    return;
  }
  console.log("+ " + path + " (cart tick after '" + used.slice(0, 44) + "')");
  applied++;
}

repairCartTick();

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");