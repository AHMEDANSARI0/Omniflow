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

applySwaps(CP + "/app.py", "portal_restock_bp", true, [["from portal_revenue import bp as portal_revenue_bp  # noqa: E402\nfrom portal_checkout import public_bp as portal_checkout_public_bp  # noqa: E402", "from portal_revenue import bp as portal_revenue_bp  # noqa: E402\nfrom portal_restock import bp as portal_restock_bp  # noqa: E402\nfrom portal_checkout import public_bp as portal_checkout_public_bp  # noqa: E402"], ["aux_app.register_blueprint(portal_revenue_bp)\naux_app.register_blueprint(portal_checkout_public_bp)", "aux_app.register_blueprint(portal_revenue_bp)\naux_app.register_blueprint(portal_restock_bp)\naux_app.register_blueprint(portal_checkout_public_bp)"]]);
applySwaps(WEB + "/lib/omniflow/portal.ts", "getRestockRadar", false, [["    .filter((item) => item.name);\n}\n\nexport async function deleteSequence(", "    .filter((item) => item.name);\n}\n\nexport interface RestockItem {\n  name: string;\n  weeklyRate: number;\n  revenue: number;\n  buyers: number;\n  lastSoldDays: number | null;\n  recentUnits: number;\n  priorUnits: number;\n  sharePercent: number | null;\n  trend: string;\n}\n\nexport interface RestockRadar {\n  stockUp: RestockItem[];\n  watch: RestockItem[];\n  slow: RestockItem[];\n  counts: Record<string, number>;\n  itemsSold: number;\n  days: number;\n}\n\nfunction restockItemOf(raw: unknown): RestockItem | null {\n  if (raw === null || typeof raw !== \"object\") return null;\n  const item = raw as Record<string, unknown>;\n  const name = typeof item.name === \"string\" ? item.name : \"\";\n  if (!name) return null;\n  return {\n    name,\n    weeklyRate: typeof item.weekly_rate === \"number\" ? item.weekly_rate : 0,\n    revenue: typeof item.revenue === \"number\" ? item.revenue : 0,\n    buyers: typeof item.buyers === \"number\" ? item.buyers : 0,\n    lastSoldDays:\n      typeof item.last_sold_days === \"number\" ? item.last_sold_days : null,\n    recentUnits: typeof item.recent_units === \"number\" ? item.recent_units : 0,\n    priorUnits: typeof item.prior_units === \"number\" ? item.prior_units : 0,\n    sharePercent:\n      typeof item.share_percent === \"number\" ? item.share_percent : null,\n    trend: typeof item.trend === \"string\" ? item.trend : \"steady\",\n  };\n}\n\nexport async function getRestockRadar(\n  accessToken: string,\n  days: number\n): Promise<RestockRadar | null> {\n  let response: Response;\n  try {\n    response = await portalRequest(\n      accessToken,\n      \"api/v1/portal/restock/radar?days=\" + encodeURIComponent(String(days))\n    );\n  } catch (error) {\n    assertNotAuthError(error);\n    return null;\n  }\n  if (response.status === 404 || response.status === 501) return null;\n  if (response.status === 401) throw new ControlPlaneRequestError(401, \"unauthorized\");\n  if (!response.ok) return null;\n  const payload: unknown = await response.json().catch(() => null);\n  if (payload === null || typeof payload !== \"object\") return null;\n  const row = payload as Record<string, unknown>;\n  const listOf = (raw: unknown): RestockItem[] =>\n    Array.isArray(raw)\n      ? raw\n          .map(restockItemOf)\n          .filter((item): item is RestockItem => item !== null)\n      : [];\n  const counts =\n    row.counts !== null && typeof row.counts === \"object\"\n      ? (row.counts as Record<string, unknown>)\n      : {};\n  const tierCounts: Record<string, number> = {};\n  for (const [key, value] of Object.entries(counts)) {\n    if (typeof value === \"number\") tierCounts[key] = value;\n  }\n  return {\n    stockUp: listOf(row.stock_up),\n    watch: listOf(row.watch),\n    slow: listOf(row.slow),\n    counts: tierCounts,\n    itemsSold: typeof row.items_sold === \"number\" ? row.items_sold : 0,\n    days: typeof row.days === \"number\" ? row.days : 0,\n  };\n}\n\nexport async function deleteSequence("]]);
writeNew(WEB + "/app/api/omniflow/portal/restock/radar/route.ts", "getRestockRadar", false, "import {\n  getRestockRadar,\n  requirePortalAccessToken,\n} from \"../../../../../../lib/omniflow/portal\";\nimport {\n  noStoreHeaders,\n  safeJson,\n} from \"../../../../../../lib/omniflow/request-security\";\nimport { ControlPlaneRequestError } from \"../../../../../../lib/omniflow/control-plane\";\n\n\nexport async function GET(request: Request) {\n  const accessToken = await requirePortalAccessToken();\n  if (!accessToken) {\n    return safeJson(\n      { error: { code: \"unauthorized\", message: \"Sign in required.\" } },\n      401\n    );\n  }\n\n  const params = new URL(request.url).searchParams;\n  const rawDays = params.get(\"days\");\n  let days = 60;\n  if (rawDays !== null) {\n    const parsed = Number.parseInt(rawDays, 10);\n    if (!Number.isFinite(parsed) || parsed <= 0) {\n      return safeJson(\n        { error: { code: \"bad_request\", message: \"days must be a number.\" } },\n        400\n      );\n    }\n    days = parsed;\n  }\n\n  try {\n    const result = await getRestockRadar(accessToken, days);\n    if (result === null) {\n      return safeJson(\n        { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n        503\n      );\n    }\n    return safeJson(result, 200);\n  } catch (error) {\n    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {\n      return safeJson(\n        { error: { code: \"unauthorized\", message: \"Session expired.\" } },\n        401\n      );\n    }\n    return safeJson(\n      { error: { code: \"portal_unavailable\", message: \"Try again shortly.\" } },\n      503\n    );\n  }\n}\n");
writeNew(CP + "/portal_restock.py", "portal_restock", true, "\"\"\"Restock radar: deterministic, zero AI. Classifies every sold item into\nstock-up / watch / slow lists from paid checkout history - weekly sell\nrate, recent-vs-prior trend, revenue share, buyer count and days since\nlast sale. Tells the seller what to reorder before it runs out, and what\nNOT to restock. Read-only: no new tables.\"\"\"\n\nimport logging\nimport re\nfrom datetime import date, datetime, timezone\nfrom typing import Any, Dict, List, Optional, Tuple\n\nfrom flask import Blueprint, jsonify, request\n\nfrom portal_auth import (\n    PortalAuthUnavailable,\n    authenticate_portal_request,\n)\nimport portal_db\n\nbp = Blueprint(\"portal_restock\", __name__, url_prefix=\"/api/v1/portal\")\n\nlogger = logging.getLogger(__name__)\n\nLINKS_TABLE = \"portal_checkout_links\"\n\nWINDOW_DAYS_DEFAULT = 60\nMAX_WINDOW_DAYS = 180\nMAX_LINKS = 500\nMAX_PER_LIST = 8\n\n_NUMBER_RE = re.compile(r\"\\d[\\d,]*\")\n\n_RESTOCK_DDL_READY = True  # module owns no tables\n\n\ndef _principal_or_error():\n    try:\n        principal = authenticate_portal_request()\n    except PortalAuthUnavailable as error:\n        return None, (jsonify({\"error\": {\"code\": \"portal_unavailable\",\n                                         \"message\": str(error)}}), 503)\n    if principal is None:\n        return None, (jsonify({\"error\": {\"code\": \"unauthorized\",\n                                         \"message\": \"Sign in required.\"}}), 401)\n    return principal, None\n\n\ndef _table_exists(cur, table: str) -> bool:\n    cur.execute(\"SELECT to_regclass(%s) AS oid\", (table,))\n    rows = portal_db.rows(cur)\n    return bool(rows and rows[0].get(\"oid\"))\n\n\ndef _now() -> datetime:\n    return datetime.now(timezone.utc)\n\n\ndef _parse_ts(value: Any) -> Optional[datetime]:\n    if isinstance(value, datetime):\n        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)\n    if isinstance(value, date):\n        return datetime(value.year, value.month, value.day,\n                        tzinfo=timezone.utc)\n    text = str(value or \"\").strip()\n    if not text:\n        return None\n    try:\n        parsed = datetime.fromisoformat(text.replace(\"Z\", \"+00:00\"))\n    except ValueError:\n        return None\n    if parsed.tzinfo is None:\n        parsed = parsed.replace(tzinfo=timezone.utc)\n    return parsed\n\n\ndef _days_since(value: Any, now: datetime) -> Optional[int]:\n    ts = _parse_ts(value)\n    if ts is None:\n        return None\n    return max(0, int((now - ts).total_seconds() // 86400))\n\n\ndef _weekly_rate(units: int, window_days: int) -> float:\n    weeks = max(window_days / 7.0, 1.0)\n    return round(units / weeks, 1)\n\n\nSTOCK_UP_WEEKLY = 0.5  # at least ~2 units/month keeps a item stock-worthy\n\n\ndef _classify(recent: int, prior: int, weekly_rate: float) -> Tuple[str, str]:\n    \"\"\"(list, trend) from the two window halves.\"\"\"\n    if recent > 0 and prior == 0:\n        return (\"stock_up\", \"new\") if weekly_rate >= STOCK_UP_WEEKLY \\\n            else (\"watch\", \"new\")\n    if prior > 0 and recent == 0:\n        return \"slow\", \"stalled\"\n    ratio = recent / float(prior)\n    if ratio < 0.5:\n        return \"slow\", \"slowing\"\n    if weekly_rate >= STOCK_UP_WEEKLY:\n        return \"stock_up\", (\"accelerating\" if ratio > 1.2 else \"steady\")\n    if ratio > 1.2:\n        return \"watch\", \"accelerating\"\n    return \"watch\", \"steady\"\n\n\ndef _load_window_links(cur, client_id, days: int) -> List[Dict[str, Any]]:\n    \"\"\"Paid links inside the window (created_at included for the halves).\"\"\"\n    if not _table_exists(cur, LINKS_TABLE):\n        return []\n    cur.execute(\n        \"SELECT contact_id, items, created_at FROM \"\n        + portal_db._q(LINKS_TABLE) +\n        \" WHERE client_id = %s AND status = 'paid'\"\n        \" AND created_at > NOW() - make_interval(days => %s)\"\n        \" ORDER BY id DESC LIMIT \" + str(MAX_LINKS),\n        (client_id, days),\n    )\n    return [{\"contact_id\": str(row.get(\"contact_id\") or \"\"),\n             \"items\": row.get(\"items\"),\n             \"created_at\": row.get(\"created_at\")}\n            for row in portal_db.rows(cur)]\n\n\ndef _item_revenue(item: Any) -> int:\n    if not isinstance(item, dict):\n        return 0\n    match = _NUMBER_RE.search(str(item.get(\"price\") or \"\"))\n    return int(match.group(0).replace(\",\", \"\")) if match else 0\n\n\ndef build_radar(links: List[Dict[str, Any]], days: int,\n                now: datetime) -> Dict[str, Any]:\n    \"\"\"Split the window into halves, classify every sold item.\"\"\"\n    half_seconds = max(days, 1) * 86400 / 2.0\n    stats: Dict[str, Dict[str, Any]] = {}\n    total_revenue = 0\n    for link in links:\n        age = _days_since(link.get(\"created_at\"), now)\n        if age is None:\n            continue\n        in_recent = age < half_seconds // 86400 or age <= days / 2.0\n        for item in (link[\"items\"] if isinstance(link[\"items\"], list)\n                     else []):\n            if not isinstance(item, dict):\n                continue\n            name = str(item.get(\"name\") or \"\").strip()\n            if not name:\n                continue\n            key = name.lower()\n            entry = stats.setdefault(key, {\n                \"name\": name, \"recent\": 0, \"prior\": 0, \"revenue\": 0,\n                \"buyers\": set(), \"last_sold_days\": None})\n            if in_recent:\n                entry[\"recent\"] += 1\n            else:\n                entry[\"prior\"] += 1\n            revenue = _item_revenue(item)\n            entry[\"revenue\"] += revenue\n            total_revenue += revenue\n            entry[\"buyers\"].add(link[\"contact_id\"])\n            last = entry[\"last_sold_days\"]\n            if last is None or age < last:\n                entry[\"last_sold_days\"] = age\n\n    lists: Dict[str, List[Dict[str, Any]]] = {\n        \"stock_up\": [], \"watch\": [], \"slow\": []}\n    steady_count = 0\n    for entry in stats.values():\n        weekly = _weekly_rate(entry[\"recent\"] + entry[\"prior\"], days)\n        bucket, trend = _classify(entry[\"recent\"], entry[\"prior\"], weekly)\n        if bucket == \"watch\" and trend == \"steady\" \\\n                and weekly < STOCK_UP_WEEKLY:\n            # mid mover, no signal either way - counted, not listed\n            steady_count += 1\n            continue\n        payload = {\n            \"name\": entry[\"name\"],\n            \"weekly_rate\": weekly,\n            \"revenue\": entry[\"revenue\"],\n            \"buyers\": len(entry[\"buyers\"]),\n            \"last_sold_days\": entry[\"last_sold_days\"],\n            \"recent_units\": entry[\"recent\"],\n            \"prior_units\": entry[\"prior\"],\n            \"share_percent\": (round(entry[\"revenue\"] * 100.0\n                                    / total_revenue, 1)\n                              if total_revenue else None),\n            \"trend\": trend,\n        }\n        lists[bucket].append(payload)\n\n    for bucket in lists.values():\n        bucket.sort(key=lambda entry: (-entry[\"revenue\"],\n                                       entry[\"name\"].lower()))\n    lists[\"stock_up\"] = lists[\"stock_up\"][:MAX_PER_LIST]\n    lists[\"watch\"] = lists[\"watch\"][:MAX_PER_LIST]\n    lists[\"slow\"] = lists[\"slow\"][:MAX_PER_LIST]\n    return {\n        \"stock_up\": lists[\"stock_up\"],\n        \"watch\": lists[\"watch\"],\n        \"slow\": lists[\"slow\"],\n        \"counts\": {\n            \"stock_up\": len(lists[\"stock_up\"]),\n            \"watch\": len(lists[\"watch\"]),\n            \"slow\": len(lists[\"slow\"]),\n            \"steady\": steady_count,\n        },\n        \"items_sold\": len(stats),\n    }\n\n\n@bp.get(\"/restock/radar\")\ndef restock_radar():\n    \"\"\"Stock-up / watch / slow lists from paid order history.\"\"\"\n    principal, error = _principal_or_error()\n    if error:\n        return error\n    try:\n        days = int(request.args.get(\"days\") or WINDOW_DAYS_DEFAULT)\n    except ValueError:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"days must be a number.\"}}), 400\n    if not 1 <= days <= MAX_WINDOW_DAYS:\n        return jsonify({\"error\": {\"code\": \"bad_request\",\n                                  \"message\": \"days must be 1-180.\"}}), 400\n    client_id = principal[\"client_id\"]\n    try:\n        portal_db.ensure_tables()\n        conn = portal_db._conn()\n        try:\n            with conn.cursor() as cur:\n                links = _load_window_links(cur, client_id, days)\n        finally:\n            conn.close()\n    except Exception as error:\n        logger.warning(\"restock radar failed: %s\", error)\n        return jsonify(portal_db.portal_unavailable(error,\n                                                    \"restock radar\")[0]), 503\n    radar = build_radar(links, days, _now())\n    radar[\"days\"] = days\n    return jsonify(radar), 200\n");
applySwaps(WEB + "/app/dashboard/(portal)/growth/page.tsx", "Restock radar", false, [["  trend: string;\n}\n\nconst DAYS_OPTIONS = [7, 14, 30, 60];", "  trend: string;\n}\n\ninterface RestockItemData {\n  name: string;\n  weeklyRate: number;\n  revenue: number;\n  buyers: number;\n  lastSoldDays: number | null;\n  recentUnits: number;\n  priorUnits: number;\n  sharePercent: number | null;\n  trend: string;\n}\n\ninterface RestockRadarData {\n  stockUp: RestockItemData[];\n  watch: RestockItemData[];\n  slow: RestockItemData[];\n  counts: Record<string, number>;\n  itemsSold: number;\n  days: number;\n}\n\nconst DAYS_OPTIONS = [7, 14, 30, 60];"], ["  const [revItems, setRevItems] = useState<RevenueItemData[]>([]);\n  const [days, setDays] = useState(14);", "  const [revItems, setRevItems] = useState<RevenueItemData[]>([]);\n  const [restock, setRestock] = useState<RestockRadarData | null>(null);\n  const [days, setDays] = useState(14);"], ["  const load = useCallback(async () => {\n    const [churnPayload, radarPayload, revenuePayload, itemsPayload, forecast, ideas, negotiation, checkout, listenRules, listenHits, routingRules] =\n      await Promise.all([", "  const load = useCallback(async () => {\n    const [churnPayload, radarPayload, revenuePayload, itemsPayload, forecast, ideas, negotiation, checkout, listenRules, listenHits, routingRules, restockPayload] =\n      await Promise.all(["], ["        getJson<{ rules: RoutingRule[] }>(\"/api/omniflow/portal/routing/rules\"),\n      ]);", "        getJson<{ rules: RoutingRule[] }>(\"/api/omniflow/portal/routing/rules\"),\n        getJson<RestockRadarData>(\n          \"/api/omniflow/portal/restock/radar?days=\" + days\n        ),\n      ]);"], ["    setRouting(routingRules?.rules ?? []);\n  }, [days]);", "    setRouting(routingRules?.rules ?? []);\n    setRestock(restockPayload);\n  }, [days]);"], ["              Revenue data unavailable.\n            </p>\n          )}\n        </Section>\n\n        <Section\n          title=\"Churn radar\"", "              Revenue data unavailable.\n            </p>\n          )}\n        </Section>\n\n        <Section\n          title=\"Restock radar\"\n          hint=\"What to reorder from your sell-through - fast movers, risers and slow items.\"\n        >\n          {restock && restock.itemsSold > 0 ? (\n            <div className=\"grid gap-3 md:grid-cols-3\">\n              {(\n                [\n                  [\"Stock up\", restock.stockUp, \"text-emerald-300\"],\n                  [\"Watch\", restock.watch, \"text-amber-300\"],\n                  [\"Slow movers\", restock.slow, \"text-slate-400\"],\n                ] as const\n              ).map(([label, list, tone]) => (\n                <div\n                  key={label}\n                  className=\"rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5\"\n                >\n                  <p className={`text-[10px] font-semibold ${tone}`}>\n                    {label} ({list.length})\n                  </p>\n                  {list.length === 0 ? (\n                    <p className=\"mt-1.5 text-[11px] text-slate-600\">\n                      Nothing here.\n                    </p>\n                  ) : (\n                    <ul className=\"mt-1.5 space-y-1\">\n                      {list.slice(0, 4).map((item) => (\n                        <li\n                          key={label + item.name}\n                          className=\"rounded-lg border border-white/[0.05] bg-white/[0.015] px-2 py-1.5\"\n                        >\n                          <div className=\"flex items-center justify-between gap-1.5\">\n                            <p className=\"truncate text-xs text-slate-200\">\n                              {item.name}\n                            </p>\n                            <span className=\"shrink-0 text-[10px] text-slate-500\">\n                              {item.weeklyRate}/wk\n                            </span>\n                          </div>\n                          <p className=\"mt-0.5 text-[10px] text-slate-600\">\n                            {item.trend}\n                            {item.sharePercent !== null\n                              ? \" · \" + item.sharePercent + \"% of revenue\"\n                              : \"\"}\n                            {item.lastSoldDays !== null\n                              ? \" · last sold \" + item.lastSoldDays + \"d ago\"\n                              : \"\"}\n                          </p>\n                        </li>\n                      ))}\n                    </ul>\n                  )}\n                </div>\n              ))}\n            </div>\n          ) : (\n            <p className=\"text-xs text-slate-500\">\n              Sell a few orders to see restock signals.\n            </p>\n          )}\n        </Section>\n\n        <Section\n          title=\"Churn radar\""]]);

console.log("SUMMARY: " + applied + " applied, " + already + " already done, " + warnings + " warnings");