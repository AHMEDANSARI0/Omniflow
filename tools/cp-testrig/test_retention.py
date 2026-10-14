"""§238 Retention & loyalty hub.

Units (tiers, templates, offers, send window, purchase definition) + wiring
pins, then the real thing on pgserver: who is due (reorder / win-back) and
who is held back (opted out, open cart, active sequence, cooldown), the
daily cap, automatic sends from the connector tick (opt-in, throttled,
window, own commit), results attribution, the loyalty note for the brain,
the HTTP API (auth, roles, validation, tenant isolation), and the fixed
neighbours: win-back queue send commits + respects opt-outs, recovery
skips opted-out customers, shipped / delivered orders count as purchases.
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith("OF_RETENTION_"):
        os.environ.pop(name)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
CP = os.getcwd()

from decimal import Decimal  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_retention as pr  # noqa: E402


def read(name):
    with open(os.path.join(CP, name), encoding="utf8") as handle:
        return handle.read()


def squash(text):
    return " ".join(text.split())


print("== units: purchases / tiers ==")
check("purchase = paid, shipped, delivered", pr.PURCHASED_SQL == "('paid', 'shipped', 'delivered')", pr.PURCHASED_SQL)
tiers, why = pr.clean_tiers([{"label": "Silver", "min_orders": 2, "min_spend": 0, "coupon": "silver5"},
                             {"label": "Gold", "min_orders": "4", "min_spend": 10000}])
check("clean tiers: keys, numbers, coupon upper-cased", tiers == [
    {"key": "silver", "label": "Silver", "min_orders": 2, "min_spend": 0, "coupon": "SILVER5"},
    {"key": "gold", "label": "Gold", "min_orders": 4, "min_spend": 10000, "coupon": ""}] and why == "", tiers)
for label, raw in (("empty", []), ("not a list", "x"),
                   ("too many", [{"label": "T" + str(i), "min_orders": i + 1} for i in range(6)]),
                   ("no label", [{"label": "", "min_orders": 1}]),
                   ("label too long", [{"label": "x" * 31, "min_orders": 1}]),
                   ("bool orders", [{"label": "A", "min_orders": True}]),
                   ("fraction orders", [{"label": "A", "min_orders": 1.5}]),
                   ("zero orders", [{"label": "A", "min_orders": 0}]),
                   ("negative spend", [{"label": "A", "min_orders": 1, "min_spend": -1}]),
                   ("text spend", [{"label": "A", "min_orders": 1, "min_spend": "lots"}]),
                   ("duplicate labels", [{"label": "Gold", "min_orders": 1}, {"label": "gold", "min_orders": 2}]),
                   ("not ascending", [{"label": "A", "min_orders": 3}, {"label": "B", "min_orders": 2}]),
                   ("lower spend later", [{"label": "A", "min_orders": 1, "min_spend": 500},
                                          {"label": "B", "min_orders": 2, "min_spend": 100}]),
                   ("same minimums", [{"label": "A", "min_orders": 2}, {"label": "B", "min_orders": 2}])):
    got, reason = pr.clean_tiers(raw)
    check("clean tiers rejects: " + label, got is None and reason, (got, reason))
gold = [{"key": "a", "label": "A", "min_orders": 1, "min_spend": 0},
        {"key": "b", "label": "B", "min_orders": 3, "min_spend": 5000},
        {"key": "c", "label": "C", "min_orders": 6, "min_spend": 20000}]
current, upcoming = pr.tier_for(4, 3000, gold)
check("tier: both minimums must be met", current["key"] == "a" and upcoming["key"] == "b", (current, upcoming))
current, upcoming = pr.tier_for(7, 25000, gold)
check("tier: top tier, nothing next", current["key"] == "c" and upcoming is None)
check("tier: no purchases -> none", pr.tier_for(0, 0, gold) == (None, gold[0]))
check("default tiers line up with the inbox VIP badge (3 orders)",
      pr.DEFAULT_TIERS[-1]["label"] == "VIP" and pr.DEFAULT_TIERS[-1]["min_orders"] == 3
      and pr.clean_tiers(pr.DEFAULT_TIERS)[0] == pr.DEFAULT_TIERS)
now = datetime(2026, 10, 5, tzinfo=timezone.utc)
stats = pr.stats_of([{"created_at": now - timedelta(days=50), "total": Decimal("1200.50"),
                      "items": [{"name": "Lawn Suit"}, {"name": "Dupatta"}]},
                     {"created_at": (now - timedelta(days=9)).isoformat(), "total": "800",
                      "items": json.dumps([{"name": "lawn suit"}])},
                     {"created_at": None, "total": None, "items": None}], now)
check("stats: orders, spend, favourite, last order", stats == {
    "orders": 3, "spend": 2000.5, "favourite": "Lawn Suit", "last_order_days": 9}, stats)

print("== units: messages / offers ==")
check("template: blank -> default", pr.clean_template("  ") == ("", ""))
check("template: unknown placeholder", pr.clean_template("Hi {first}")[0] is None)
check("template: too long", pr.clean_template("x" * 501)[0] is None)
check("template: offer needs {code}", pr.clean_template("Save {value}", "code")[0] is None
      and pr.clean_template("Code {code}", "code") == ("Code {code}", ""))
check("render tidies blanks", pr.render("Salam {name}! {item} , ok", {"name": "", "item": "Suit"}) == "Salam! Suit, ok")
coupons = {"VIP10": {"code": "VIP10", "kind": "percent", "value": 10.0},
           "FLAT500": {"code": "FLAT500", "kind": "fixed", "value": 500.0}}
check("offer: percent", pr.offer_for({"label": "VIP", "coupon": "vip10"}, coupons) == {"code": "VIP10", "value": "10%"})
check("offer: fixed", pr.offer_for({"label": "VIP", "coupon": "FLAT500"}, coupons) == {"code": "FLAT500", "value": "500"})
check("offer: inactive / unknown coupon -> none", pr.offer_for({"label": "VIP", "coupon": "OLD"}, coupons) is None
      and pr.offer_for({"label": "VIP", "coupon": ""}, coupons) is None and pr.offer_for(None, coupons) is None)
settings = dict(pr.DEFAULT_SETTINGS)
text = pr.compose(settings, "reorder", "Ali Khan", "Lawn Suit", {"label": "VIP"}, {"code": "VIP10", "value": "10%"})
check("compose: first name, item, offer line", text.startswith("Assalam-o-Alaikum Ali!") and "Lawn Suit" in text
      and "VIP customer ke liye code VIP10 se 10% off." in text, text)
text = pr.compose(settings, "winback", "", "", None, None)
check("compose: no name / offer -> clean default", text.startswith("Assalam-o-Alaikum!") and "code" not in text
      and "{" not in text, text)
check("compose: item fallback", pr.FALLBACK_ITEM in pr.compose(settings, "reorder", "Sara", "", None, None))
custom = dict(settings, tpl_reorder="Hi {name}, {item} again?{offer}", tpl_offer="Use {code}.")
check("compose: owner templates", pr.compose(custom, "reorder", "Sara", "Soap", {"label": "VIP"},
                                             {"code": "X", "value": "5%"}) == "Hi Sara, Soap again? Use X.")
check("window: plain", pr.in_window(10, 10, 20) and not pr.in_window(20, 10, 20) and not pr.in_window(9, 10, 20))
check("window: overnight", pr.in_window(23, 22, 6) and pr.in_window(5, 22, 6) and not pr.in_window(12, 22, 6))
check("window: start == end -> always", pr.in_window(3, 9, 9))
check("loyalty rules forbid offers / codes", "never invent offers, codes or discounts" in pr.LOYALTY_RULES)
import portal_datasafety  # noqa: E402

check("own tables - data retention keeps portal_retention_settings",
      {pr.SETTINGS_TABLE, pr.SENDS_TABLE}.isdisjoint({portal_datasafety.RETENTION_TABLE}))
check("automatic sends are off by default", pr.DEFAULT_SETTINGS["auto_reorder"] is False
      and pr.DEFAULT_SETTINGS["auto_winback"] is False)

print("== wiring ==")
app_src = read("app.py")
check("app registers the blueprint", "from portal_retention import bp as portal_retention_bp" in app_src
      and "aux_app.register_blueprint(portal_retention_bp)" in app_src)
conn_src = read("connector_api.py")
kick = conn_src.find("portal_retention.kick(cur, tenant[\"client_id\"], conn)")
check("tick: kick inside its own savepoint, after workflows, before the command read",
      kick > conn_src.find("portal_workflows.run_due_workflows(") > 0
      and "with portal_txn.savepoint(cur, conn, \"of_tick\"):" in conn_src[kick - 200:kick]
      and kick < conn_src.find("cmd_sql = ("))
brain_src = read("portal_brain.py")
check("brain: loyalty note in a savepoint + rules only when present",
      "portal_retention.context_for(cur, client_id, contact_id)" in brain_src
      and "portal_txn.savepoint(cur, None, \"of_loyalty_ctx\")" in brain_src
      and "system_prompt += portal_retention.LOYALTY_RULES" in brain_src and 'if "loyalty" in context:' in brain_src)
for module, fn in (("portal_value.py", "def _load_paid_rows"), ("portal_churn.py", "def _load_paid_links"),
                   ("portal_winback.py", "def _load_paid_links"), ("portal_conversations.py", "def _paid_order_counts")):
    src = read(module)
    body = src[src.index(fn):src.index("\ndef ", src.index(fn) + 5)]
    check(module + ": purchases = portal_retention.PURCHASED_SQL",
          "portal_retention.PURCHASED_SQL" in body and "status = 'paid'" not in body)
rec_src = read("portal_recovery.py")
check("recovery: quiet buyers use purchases + order value", "status IN \"\n        + portal_retention.PURCHASED_SQL" in rec_src
      and "SUM(paid_amount)" not in rec_src)
win_src = read("portal_winback.py")
send = win_src[win_src.index("def winback_send"):]
check("winback send commits", "conn.commit()" in send)
check("compliance exposes is_opted_out", "def is_opted_out(cur, client_id, contact)" in read("portal_compliance.py"))


def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="retention238_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def connect():
        return psycopg2.connect(host=data, dbname="postgres", user="postgres")

    def sql(q, a=(), fetch=True):
        c = connect()
        try:
            cur = c.cursor()
            cur.execute(q, a)
            got = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return got
        finally:
            c.close()

    def in_txn(fn, commit=True):
        """fn(cur) inside a savepoint like the tick; returns (result, usable).
        commit=False rolls the caller's transaction back (only work the step
        committed itself survives)."""
        c = connect()
        try:
            with c.cursor() as cur:
                import portal_txn
                out = None
                with portal_txn.savepoint(cur, c, "of_tick"):
                    out = fn(cur, c)
                cur.execute("SELECT 1")
                usable = cur.fetchone() == (1,)
            if commit:
                c.commit()
            else:
                c.rollback()
            return out, usable
        finally:
            c.close()

    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)

    # data retention (portal_datasafety) already owns a similar table name
    c = connect()
    portal_datasafety._ensure_retention_table(c)
    c.close()

    # --- bare database ------------------------------------------------------
    pr._NEXT_CHECK.clear()
    out, usable = in_txn(lambda cur, c: pr.kick(cur, 7, None))
    check("db: bare database -> kick is a no-op, transaction usable", out == 0 and usable)
    out, usable = in_txn(lambda cur, c: pr.context_for(cur, 7, "923001112201@c.us"))
    check("db: bare database -> no loyalty note", out is None and usable)
    out, usable = in_txn(lambda cur, c: pr.plan(cur, 7, dict(pr.DEFAULT_SETTINGS)))
    check("db: bare database -> nothing due", usable and out["ready"] == [] and out["customers"] == 0, out)

    # --- seed -----------------------------------------------------------------
    import portal_checkout
    import portal_coupons
    import portal_sequences
    c = connect()
    portal_checkout._ensure_checkout_tables(c)
    portal_coupons._ensure_coupons_tables(c)
    portal_sequences._SEQ_DDL_READY = False
    portal_sequences._ensure_seq_tables(c)
    c.close()
    tokens = iter(range(1, 1000))

    def chat(client, contact, name, quiet_days):
        return sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name, last_message_at)"
                   " VALUES (%s, %s, %s, NOW() - make_interval(days => %s)) RETURNING id",
                   (client, contact, name, quiet_days))[0][0]

    def order(client, contact, days, status="paid", total=1000, item="Lawn Suit"):
        return sql("INSERT INTO portal_checkout_links (client_id, contact_id, token, items, total, status, created_at)"
                   " VALUES (%s, %s, %s, CAST(%s AS JSONB), %s, %s, NOW() - make_interval(days => %s)) RETURNING id",
                   (client, contact, "t" + str(next(tokens)), json.dumps([{"name": item, "price": total}]),
                    total, status, days))[0][0]

    ali, sara, opt, cart, seq, cool, cancel, foreign = (
        "923001112201@c.us", "923001112202@c.us", "923001112203@c.us", "923001112204@c.us",
        "923001112205@c.us", "923001112206@c.us", "923001112207@c.us", "923001112299@c.us")
    ali_conv = chat(7, ali, "Ali Khan", 10)
    for days, status in ((100, "delivered"), (70, "shipped"), (40, "paid")):
        order(7, ali, days, status, 2500)
    sara_conv = chat(7, sara, "Sara", 60)
    sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body, created_at)"
        " VALUES (%s, 7, 'out', 'Shukriya!', NOW() - INTERVAL '50 days')", (sara_conv,), fetch=False)
    order(7, sara, 100, "paid", 900, "Soap")
    for contact, name in ((opt, "Opted"), (cart, "Cart"), (seq, "Seq"), (cool, "Cool")):
        chat(7, contact, name, 60)
        order(7, contact, 100, "delivered", 700)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (7, %s)", (opt,), fetch=False)
    order(7, cart, 2, "open", 500)
    seq_id = sql("INSERT INTO portal_sequences (client_id, name) VALUES (7, 'Drip') RETURNING id")[0][0]
    sql("INSERT INTO portal_sequence_enrollments (client_id, sequence_id, conversation_id, contact_id)"
        " VALUES (7, %s, 1, %s)", (seq_id, seq), fetch=False)
    sql("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status, created_at, updated_at)"
        " VALUES (7, 'whatsapp', 'send_message', CAST(%s AS JSONB), 'sent', NOW() - INTERVAL '2 days', NOW())",
        (json.dumps({"external_user_id": cool, "body": "x", "source": "recovery"}),), fetch=False)
    chat(7, cancel, "Cancelled", 60)
    order(7, cancel, 100, "cancelled", 5000)
    chat(8, foreign, "Other shop", 60)
    order(8, foreign, 100, "paid", 999)
    # another shop's opt-out / outreach for Sara must not hold her back here
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (8, %s)", (sara,), fetch=False)
    sql("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status, created_at, updated_at)"
        " VALUES (8, 'whatsapp', 'send_message', CAST(%s AS JSONB), 'sent', NOW() - INTERVAL '1 day', NOW())",
        (json.dumps({"external_user_id": sara, "body": "x", "source": "retention"}),), fetch=False)

    # --- the purchase fix in the neighbours -----------------------------------
    import portal_value
    import portal_churn
    import portal_winback
    import portal_conversations
    cur = connect().cursor()
    check("db: value counts shipped / delivered orders",
          len([r for r in portal_value._load_paid_rows(cur, 7) if r["contact_id"] == ali]) == 3)
    check("db: churn counts shipped / delivered orders", len(portal_churn._load_paid_links(cur, 7, ali)) == 3)
    check("db: win-back counts shipped / delivered orders", len(portal_winback._load_paid_links(cur, 7, ali)) == 3)
    check("db: inbox VIP counts shipped / delivered orders",
          portal_conversations._paid_order_counts(cur, 7, [ali, cancel]) == {ali: 3})

    # --- plan --------------------------------------------------------------------
    out, usable = in_txn(lambda cur, c: pr.plan(cur, 7, pr.load_settings(cur, 7)))
    ready = [(e["contact_id"], e["kind"]) for e in out["ready"]]
    check("db: plan -> reorder first, then win-back", usable and ready == [(ali, "reorder"), (sara, "winback")], ready)
    check("db: plan -> held back by reason", out["skipped"] == {"opted_out": 1, "open_cart": 1, "in_sequence": 1,
                                                                "cooldown": 1, "no_chat": 0}, out["skipped"])
    check("db: plan -> due counts + customers (cancelled is not a customer, other shop not seen)",
          out["due"] == {"reorder": 1, "winback": 5} and out["customers"] == 6, (out["due"], out["customers"]))
    check("db: plan -> tiers", out["tiers"]["vip"]["customers"] == 1 and out["tiers"]["vip"]["spend"] == 7500
          and out["tiers"]["new_buyer"]["customers"] == 5, out["tiers"])
    first = out["ready"][0]
    check("db: plan -> personal message (name, favourite, no offer without a coupon)",
          first["message"].startswith("Assalam-o-Alaikum Ali!") and "Lawn Suit" in first["message"]
          and first["tier"] == "VIP" and first["coupon"] == "" and first["conversation_id"] == ali_conv, first)

    # --- run: dry run, kinds, cap, cooldown ---------------------------------------
    def commands(source="retention"):
        return sql("SELECT payload FROM portal_connector_commands WHERE client_id = 7"
                   " AND payload->>'source' = %s ORDER BY id", (source,))

    out, _ = in_txn(lambda cur, c: pr.run(cur, 7, pr.load_settings(cur, 7), "manual", dry_run=True))
    check("db: dry run lists, queues nothing", out["sent"] == 0 and len(out["would_send"]) == 2
          and commands() == [] and sql("SELECT COUNT(*) FROM portal_loyalty_sends")[0][0] == 0)
    settings = dict(pr.load_settings(connect().cursor(), 7), auto_reorder=True)
    out, usable = in_txn(lambda cur, c: pr.run(cur, 7, settings, "auto"))
    payloads = [row[0] for row in commands()]
    check("db: auto run sends only switched-on kinds", usable and out["sent"] == 1 and len(payloads) == 1
          and payloads[0]["external_user_id"] == ali and payloads[0]["retention_kind"] == "reorder"
          and payloads[0]["conversation_id"] == ali_conv and payloads[0]["target_display_name"] == "Ali Khan", payloads)
    check("db: auto run logged (results + audit)",
          sql("SELECT contact_id, kind, tier, mode FROM portal_loyalty_sends") == [(ali, "reorder", "VIP", "auto")]
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'retention.auto' AND client_id = 7")[0][0] == 1)
    out, _ = in_txn(lambda cur, c: pr.run(cur, 7, settings, "auto"))
    check("db: the same customer is not messaged again (cooldown)", out["sent"] == 0
          and out["skipped"]["cooldown"] == 1, out["skipped"])
    capped = dict(settings, auto_winback=True, daily_cap=1)
    out, _ = in_txn(lambda cur, c: pr.run(cur, 7, capped, "auto"))
    check("db: daily cap counts the last 24h", out["sent"] == 0 and out["room"] == 0, out)

    # --- offers -------------------------------------------------------------------
    sql("INSERT INTO portal_coupons (client_id, code, kind, value) VALUES (7, 'VIP10', 'percent', 10)", fetch=False)
    sql("INSERT INTO portal_coupons (client_id, code, kind, value, is_active) VALUES (7, 'OFF', 'fixed', 100, FALSE)",
        fetch=False)
    sql("INSERT INTO portal_coupons (client_id, code, kind, value, expires_at) VALUES"
        " (7, 'OLD', 'fixed', 100, NOW() - INTERVAL '1 day')", fetch=False)
    sql("INSERT INTO portal_coupons (client_id, code, kind, value, usage_limit, used_count) VALUES"
        " (7, 'USED', 'fixed', 100, 5, 5)", fetch=False)
    cur = connect().cursor()
    check("db: only usable coupons are offers", sorted(pr.active_coupons(cur, 7)) == ["VIP10"]
          and pr.active_coupons(cur, 8) == {})

    # --- kick (connector tick) ------------------------------------------------------
    sql("DELETE FROM portal_loyalty_sends", fetch=False)
    sql("DELETE FROM portal_connector_commands WHERE payload->>'source' = 'retention'", fetch=False)
    pr._NEXT_CHECK.clear()
    out, _ = in_txn(lambda cur, c: pr.kick(cur, 7, c))
    check("db: kick without settings -> nothing (opt-in)", out == 0 and commands() == [])
    tiers = [dict(t) for t in pr.DEFAULT_TIERS]
    tiers[-1]["coupon"] = "VIP10"
    sql("INSERT INTO portal_loyalty_settings (client_id, auto_reorder, window_start, window_end, tiers)"
        " VALUES (7, TRUE, 0, 0, CAST(%s AS JSONB))", (json.dumps(tiers),), fetch=False)
    pr._NEXT_CHECK.clear()
    out, usable = in_txn(lambda cur, c: pr.kick(cur, 7, c), commit=False)
    payloads = [row[0] for row in commands()]
    check("db: kick sends due reorder messages with the tier offer + commits itself", out == 1 and usable
          and len(payloads) == 1 and "code VIP10 se 10% off" in payloads[0]["body"], payloads)
    check("db: kick stamps last_run_at",
          sql("SELECT last_run_at IS NOT NULL FROM portal_loyalty_settings WHERE client_id = 7")[0][0] is True)
    pr._NEXT_CHECK.clear()
    sql("DELETE FROM portal_loyalty_sends", fetch=False)
    sql("DELETE FROM portal_connector_commands WHERE payload->>'source' = 'retention'", fetch=False)
    out, _ = in_txn(lambda cur, c: pr.kick(cur, 7, c))
    check("db: kick runs at most every OF_RETENTION_EVERY_MINUTES", out == 0 and commands() == [])
    out, _ = in_txn(lambda cur, c: pr.kick(cur, 7, c))
    check("db: per-process throttle (no query until the next check)", out == 0)
    sql("UPDATE portal_loyalty_settings SET last_run_at = NULL, window_start = (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + 2) %% 24,"
        " window_end = (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + 3) %% 24", fetch=False)
    pr._NEXT_CHECK.clear()
    out, _ = in_txn(lambda cur, c: pr.kick(cur, 7, c))
    check("db: outside the send window -> nothing sent", out == 0 and commands() == [])
    sql("UPDATE portal_loyalty_settings SET last_run_at = NULL, auto_reorder = FALSE, window_start = 0,"
        " window_end = 0", fetch=False)
    pr._NEXT_CHECK.clear()
    out, _ = in_txn(lambda cur, c: pr.kick(cur, 7, c))
    check("db: both kinds off -> nothing (not even a run stamp)", out == 0 and commands() == []
          and sql("SELECT last_run_at FROM portal_loyalty_settings WHERE client_id = 7")[0][0] is None)

    # --- loyalty note ----------------------------------------------------------------
    cur = connect().cursor()
    note = pr.context_for(cur, 7, ali)
    check("db: loyalty note (tier, orders, favourite)", note == {"tier": "VIP", "orders": 3, "favourite": "Lawn Suit",
                                                                 "last_order_days": 40}, note)
    check("db: no purchases -> no note", pr.context_for(cur, 7, cancel) is None and pr.context_for(cur, 7, "") is None)
    check("db: another workspace's customer -> no note", pr.context_for(cur, 7, foreign) is None)
    sql("UPDATE portal_loyalty_settings SET brain_context = FALSE WHERE client_id = 7", fetch=False)
    check("db: switched off -> no note", pr.context_for(connect().cursor(), 7, ali) is None)
    sql("UPDATE portal_loyalty_settings SET brain_context = TRUE WHERE client_id = 7", fetch=False)

    # --- brain ----------------------------------------------------------------------
    import portal_brain
    import portal_llm
    import portal_sales
    seen = {}

    def fake_chat(system, user, **kw):
        seen["system"], seen["user"] = system, json.loads(user)
        return {"reply": "ok", "needs_human": False, "confidence": 0.9}

    class Scope:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    real = (portal_llm.chat_json, portal_llm.usage_scope, portal_sales.context_for)
    portal_llm.chat_json, portal_llm.usage_scope = fake_chat, Scope
    portal_sales.context_for = lambda *a, **k: None
    tools = {name: getattr(portal_brain, name) for name in (
        "tool_customer_orders", "tool_search_kb", "tool_business_facts", "tool_customer_memory",
        "tool_customer_profile")}
    for name in tools:
        setattr(portal_brain, name, (lambda *a, **k: {}) if name == "tool_customer_profile"
                else (lambda *a, **k: []))
    try:
        c = connect()
        with c.cursor() as cur:
            portal_brain._DDL_READY = False
            portal_brain._ensure_ddl(cur)
        c.commit()
        with c.cursor() as cur:
            payload, grounding = portal_brain._reason(cur, 7, ali_conv, ali, "Ali", "salam", "")
            check("brain: LOYALTY note in context + rules appended + grounding tagged",
                  payload and seen["user"].get("loyalty", {}).get("tier") == "VIP"
                  and pr.LOYALTY_RULES in seen["system"] and "loyalty_context" in grounding["tools"]
                  and grounding["loyalty"] == {"tier": "VIP", "orders": 3}, grounding)
            payload, grounding = portal_brain._reason(cur, 7, ali_conv, cancel, "", "hello", "")
            check("brain: no purchases -> prompt unchanged", "loyalty" not in seen["user"]
                  and pr.LOYALTY_RULES not in seen["system"] and "loyalty_context" not in grounding["tools"])
            cur.execute("SELECT 1")
            check("brain: transaction still usable", cur.fetchone() == (1,))
        c.rollback()
        c.close()
    finally:
        portal_llm.chat_json, portal_llm.usage_scope, portal_sales.context_for = real
        for name, fn in tools.items():
            setattr(portal_brain, name, fn)

    # --- HTTP -----------------------------------------------------------------------
    import portal_compliance
    import portal_recovery
    app = Flask("retention")
    app.register_blueprint(pr.bp)
    app.register_blueprint(portal_winback.bp)
    client = app.test_client()
    owner = {"client_id": 7, "user_id": 11, "role": "owner", "via_api_key": False}
    agent = dict(owner, user_id=12, role="agent")
    pr.authenticate_portal_request = lambda: dict(owner)
    portal_winback.authenticate_portal_request = lambda: dict(owner)
    base = "/api/v1/portal/retention"
    res = client.get(base + "/settings")
    body = res.get_json()
    check("http: settings + usable coupons + defaults", res.status_code == 200 and body["can_edit"] is True
          and body["settings"]["tiers"][-1]["coupon"] == "VIP10" and [c["code"] for c in body["coupons"]] == ["VIP10"]
          and body["defaults"]["reorder"] and "offer" in body["placeholders"], body)
    for name, bad in (("bad tiers", {"tiers": [{"label": "A", "min_orders": 0}]}),
                      ("unknown placeholder", {"tpl_reorder": "Hi {first}"}),
                      ("offer without code", {"tpl_offer": "Save {value}"}),
                      ("cap too high", {"daily_cap": pr.CAP_MAX + 1}),
                      ("cap not a number", {"daily_cap": "5"}),
                      ("bool as number", {"cooldown_days": True}),
                      ("hour 24", {"window_end": 24}),
                      ("flag not bool", {"auto_reorder": "yes"}),
                      ("nothing", {}),
                      ("inactive coupon", {"tiers": [{"label": "VIP", "min_orders": 3, "coupon": "OFF"}]})):
        check("http: settings 400 - " + name, client.put(base + "/settings", json=bad).status_code == 400)
    check("http: settings 400 - not JSON", client.put(base + "/settings", data="x",
                                                       content_type="text/plain").status_code == 400)
    res = client.put(base + "/settings", json={"auto_winback": True, "daily_cap": 5, "tpl_winback": "Salam {name}!{offer}",
                                               "tiers": [{"label": "Member", "min_orders": 1},
                                                         {"label": "Gold", "min_orders": 2, "min_spend": 5000,
                                                          "coupon": "vip10"}]})
    body = res.get_json()
    check("http: settings saved + audited", res.status_code == 200 and body["settings"]["auto_winback"] is True
          and body["settings"]["daily_cap"] == 5 and body["settings"]["tiers"][1]["coupon"] == "VIP10"
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'retention.settings'")[0][0] == 1, body)
    check("http: untouched settings stay", body["settings"]["auto_reorder"] is False
          and body["settings"]["window_start"] == 0)
    pr.authenticate_portal_request = lambda: dict(agent)
    check("http: agent can read, not change or send", client.get(base + "/settings").get_json()["can_edit"] is False
          and client.put(base + "/settings", json={"daily_cap": 3}).status_code == 403
          and client.post(base + "/run", json={"dry_run": True}).status_code == 403)
    res = client.get(base + "/customer?contact_id=" + ali)
    body = res.get_json()
    check("http: agent sees a customer's loyalty", res.status_code == 200 and body["tier"]["label"] == "Gold"
          and body["orders"] == 3 and body["spend"] == 7500 and body["next"] is None
          and body["due"]["kind"] == "reorder" and "VIP10" in body["due"]["message"] and body["opted_out"] is False, body)
    body = client.get(base + "/customer?contact_id=" + sara).get_json()
    check("http: next tier progress", body["tier"]["label"] == "Member" and body["next"] == {
        "label": "Gold", "orders_needed": 1, "spend_needed": 4100.0} and body["due"]["kind"] == "winback"
        and body["due"]["message"] == "Salam Sara!", body)
    body = client.get(base + "/customer?contact_id=" + opt).get_json()
    check("http: opted-out customer is flagged + held", body["opted_out"] is True and body["due"]["held"] == "opted_out")
    check("http: customer 400 without contact", client.get(base + "/customer").status_code == 400)
    body = client.get(base + "/customer?contact_id=" + foreign).get_json()
    check("http: another workspace's customer looks empty", body["orders"] == 0 and body["tier"] is None
          and body["due"] is None)
    pr.authenticate_portal_request = lambda: dict(owner)
    res = client.post(base + "/run", json={})
    body = res.get_json()
    check("http: run defaults to a preview", res.status_code == 200 and body["dry_run"] is True and body["sent"] == 0
          and [m["contact_id"] for m in body["messages"]] == [ali, sara] and commands() == [], body)
    res = client.post(base + "/run", json={"dry_run": False})
    body = res.get_json()
    check("http: send now queues + commits", res.status_code == 200 and body["sent"] == 2 and len(commands()) == 2
          and sql("SELECT COUNT(*) FROM portal_loyalty_sends WHERE mode = 'manual'")[0][0] == 2, body)
    # a purchase after the message counts as "came back"
    order(7, sara, 0, "paid", 1500, "Soap")
    sql("UPDATE portal_checkout_links SET created_at = NOW() + INTERVAL '1 minute' WHERE contact_id = %s"
        " AND total = 1500", (sara,), fetch=False)
    res = client.get(base + "/overview")
    body = res.get_json()
    check("http: overview results + attribution", res.status_code == 200 and body["totals"] == {
        "sent": 2, "returned": 1, "revenue": 1500.0} and body["results"]["winback"]["returned"] == 1
        and body["sent_last_day"] == 2 and body["daily_cap"] == 5
        and {t["label"]: t["customers"] for t in body["tiers"]} == {"Member": 5, "Gold": 1}
        and body["recent"][0]["mode"] == "manual" and body["auto"] == {"reorder": False, "winback": True}, json.dumps(body))
    pr.authenticate_portal_request = lambda: dict(owner, client_id=8)
    body = client.get(base + "/overview").get_json()
    check("http: workspace 8 sees only its own customers", body["customers"] == 1 and body["totals"]["sent"] == 0
          and body["recent"] == [], body)
    pr.authenticate_portal_request = lambda: None
    check("http: signed out -> 401", client.get(base + "/overview").status_code == 401)
    pr.authenticate_portal_request = lambda: dict(owner, via_api_key=True)
    check("http: API keys are refused (human only)", client.get(base + "/overview").status_code == 403)

    check("db: retention sends count for the outreach cooldown",
          pr.recently_contacted(connect().cursor(), 7, ali, 7) is True)

    # --- neighbours: win-back queue send, recovery ------------------------------------
    sql("DELETE FROM portal_connector_commands WHERE payload->>'source' IN ('winback', 'retention')", fetch=False)
    res = client.post("/api/v1/portal/winback/send", json={"contact_id": sara, "kind": "winback"})
    check("http: win-back queue send is committed now", res.status_code == 200
          and len(commands("winback")) == 1
          and sql("SELECT mode FROM portal_loyalty_sends WHERE contact_id = %s ORDER BY id DESC LIMIT 1",
                  (sara,))[0][0] == "queue", res.get_json())
    res = client.post("/api/v1/portal/winback/send", json={"contact_id": opt, "kind": "winback"})
    check("http: win-back queue send refuses an opted-out customer", res.status_code == 409
          and res.get_json()["error"]["code"] == "opted_out" and len(commands("winback")) == 1)
    check("db: queue sends do not use up the daily cap", pr.sent_last_day(connect().cursor(), 7) == 2)
    cur = connect().cursor()
    check("db: compliance.is_opted_out", portal_compliance.is_opted_out(cur, 7, opt) is True
          and portal_compliance.is_opted_out(cur, 7, sara) is False and portal_compliance.is_opted_out(cur, 8, opt) is False)
    c = connect()
    with c.cursor() as cur:
        skipped = portal_recovery._enqueue_followup(cur, 7, "inactive_high_value", opt, None)
        queued = portal_recovery._enqueue_followup(cur, 7, "inactive_high_value", sara, sara_conv)
    c.commit()
    c.close()
    check("db: recovery follow-up skips an opted-out customer", skipped is False and queued is True
          and len(commands("recovery")) == 2)
    check("db: recovery shares the outreach cooldown",
          pr.recently_contacted(connect().cursor(), 7, sara, 7) is True
          and pr.recently_contacted(connect().cursor(), 7, cancel, 7) is False)


db_half()
sys.exit(1 if summary("retention") else 0)
