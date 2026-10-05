"""§237 Sales agent: qualify, concerns + approved answers, compare, quotes.

Units (qualifier extraction in English + Roman Urdu, concern detection,
catalog matching, score / label / stage / next question) and the real thing
on pgserver: the ingest hook on a bare database (transaction never
aborted), a seeded lead (catalog, intelligence, links), forward-only
pipeline moves, the brain's SALES note + prompt rules, and the HTTP API
(auth, roles, tenant isolation, validation, catalog-priced quotes within
the negotiation limit).
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith("OF_SALES_"):
        os.environ.pop(name)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
CP = os.getcwd()

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_sales as ps  # noqa: E402


def read(name):
    with open(os.path.join(CP, name), encoding="utf8") as handle:
        return handle.read()


print("== units: qualifiers ==")
got = ps.extract(["Salam, 2 pcs chahiye", "Lahore delivery hogi? budget 5,000 tak", "COD hai na? urgent"])
check("qty / city / budget / timeline / payment", got == {"quantity": 2, "city": "Lahore", "budget": 5000.0,
                                                          "timeline": "urgent", "payment": "cod"}, got)
check("number words", ps.extract(["teen pieces bhej do"]).get("quantity") == 3)
check("qty: key form", ps.extract(["qty: 12"]).get("quantity") == 12)
check("phone / price digits are not a quantity",
      "quantity" not in ps.extract(["03001234567 pe call karo", "price 2500 hai?"]))
check("part of a price is not a quantity ('Rs 2,500 wale')", "quantity" not in ps.extract(["Rs 2,500 wale suit dikhao"]))
check("newest wins", ps.extract(["Karachi", "nahi Islamabad bhejna"]).get("city") == "Islamabad")
check("budget: 'under 3000'", ps.extract(["under 3000 kuch dikhao"]).get("budget") == 3000.0)
check("tiny numbers are not a budget", "budget" not in ps.extract(["under 5"]))
check("online payment", ps.extract(["easypaisa se pay karunga"]).get("payment") == "online")
check("soon", ps.extract(["eid se pehle chahiye"]).get("timeline") == "soon")
check("city needs a word boundary", "city" not in ps.extract(["multani mitti chahiye"]))
check("nothing found", ps.extract(["hello", ""]) == {})

print("== units: concerns ==")
samples = {"price": "bohat mehnga hai", "trust": "original hai ya copy?", "delivery_time": "kitne din lagenge",
           "delivery_cost": "delivery charges kitne", "cod": "cash on delivery milegi?",
           "size_fit": "size chart bhejo", "quality": "quality kaisi hai", "compare": "daraz pe sasta mil raha",
           "later": "soch ke batata hoon"}
for kind, text in samples.items():
    check("concern: " + kind, kind in ps.objections_in(text), ps.objections_in(text))
check("no concern in a plain order", ps.objections_in("2 black shoes chahiye Lahore") == [])
check("word start: 'benefit' / 'oversize' do not match", ps.objections_in("benefit oversized") == [])
check("all nine kinds have a label + suggestion",
      len(ps.OBJECTION_KINDS) == 9 and all(ps.SUGGESTIONS.get(k) and ps.OBJECTIONS[k]["label"]
                                            for k in ps.OBJECTION_KINDS))
check("suggestions never quote a price or promise a discount",
      not any(ch.isdigit() for text in ps.SUGGESTIONS.values() for ch in text)
      and not any("discount" in text.lower() for text in ps.SUGGESTIONS.values()))

print("== units: catalog / score ==")
items = [{"id": 1, "name": "Black Leather Shoes", "_tokens": ["black", "leather", "shoes"]},
         {"id": 2, "name": "Shoes", "_tokens": ["shoes"]},
         {"id": 3, "name": "Red Kurta", "_tokens": ["red", "kurta"]}]
check("match: full name / all words, longest first",
      [i["id"] for i in ps.match_products("black leather shoes aur red kurta", items)] == [1, 3, 2])
check("match: words in any order", [i["id"] for i in ps.match_products("kurta red wala", items)] == [3])
check("match: partial words do not match", ps.match_products("red shirt", items) == [])
check("score: nothing", ps.score({}) == 0)
full = {"purchase_intent": "high", "qualifiers": {"product": "x", "quantity": 2, "city": "Lahore",
                                                  "budget": 1, "timeline": "urgent", "payment": "cod"},
        "quote_open": True}
check("score: capped at 100", ps.score(full) == 100)
check("score: bought -> 100", ps.score({"bought": True}) == 100)
check("labels", ps.label_for(ps.HOT_AT) == "hot" and ps.label_for(ps.WARM_AT) == "warm"
      and ps.label_for(0) == "cold")
check("stage: product -> interested", ps.stage_hint({"qualifiers": {"product": "x"}}) == "interested")
check("stage: price concern -> negotiating", ps.stage_hint({"objection_kinds": ["price"]}) == "negotiating")
check("stage: bought -> won", ps.stage_hint({"bought": True, "quote_open": True}) == "won")
check("stage: idle chat stays new", ps.stage_hint({"purchase_intent": "low"}) == "new")
check("ask_next: first missing, configured order",
      ps.ask_next({"qualifiers": {"product": "x"}}, ["product", "city", "quantity"]) == "city")
check("ask_next: not a buying chat -> nothing", ps.ask_next({"qualifiers": {"city": "Lahore"}}, ["quantity"]) is None)
check("ask_next: bought -> nothing", ps.ask_next({"qualifiers": {"product": "x"}, "bought": True}, ["city"]) is None)
check("clean_qualifiers drops junk + duplicates",
      ps.clean_qualifiers(["city", "x", "city", "budget"]) == ["city", "budget"] and ps.clean_qualifiers("x") is None)
view = ps.playbook_view({"price": {"reply": "Owner answer", "enabled": True}, "trust": {"reply": "", "enabled": True},
                         "later": {"reply": "Off answer", "enabled": False}})
check("playbook view: 9 rows, suggestion shown separately",
      len(view) == 9 and view[0]["reply"] == "Owner answer" and view[0]["suggestion"])
saved = {"price": {"reply": "Owner answer", "enabled": True}, "later": {"reply": "Off", "enabled": False}}
check("approved answer: only saved + enabled (never the suggestion)",
      ps.approved_answer(saved, "price") == "Owner answer" and ps.approved_answer(saved, "later") == ""
      and ps.approved_answer(saved, "trust") == "")
check("rules: one question, approved answer, no invented price / discount",
      "ONE detail" in ps.SALES_RULES and "approved_answer" in ps.SALES_RULES
      and "never offer a discount" in ps.SALES_RULES)

print("== wiring ==")
app_src = read("app.py")
check("app registers the blueprint", "from portal_sales import bp as portal_sales_bp" in app_src
      and "aux_app.register_blueprint(portal_sales_bp)" in app_src)
conn_src = read("connector_api.py")
hook = conn_src.find("portal_sales.on_inbound(")
check("ingest hook after intelligence, inside a savepoint",
      hook > conn_src.find("portal_intelligence.maybe_analyze(") > 0
      and "portal_txn.savepoint(cur, conn, \"of_hook\")" in conn_src[hook - 400:hook])
brain_src = read("portal_brain.py")
check("brain: sales note in a savepoint + rules only when present",
      "portal_sales.context_for(" in brain_src and "portal_txn.savepoint(cur, None, \"of_sales_ctx\")" in brain_src
      and "system_prompt += portal_sales.SALES_RULES" in brain_src and 'if "sales" in context:' in brain_src)
check("brain policy still forbids discount promises", '"extra discount"' in brain_src)
src = read("portal_sales.py")
check("no commit inside the ingest path", "commit(" not in src[src.index("def on_inbound"):src.index("def context_for")])


def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="sales237_")
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

    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)
    contact = "923001112233@c.us"
    conv = sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name) VALUES"
               " (7, %s, 'Ali Khan') RETURNING id", (contact,))[0][0]
    other = sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name) VALUES"
                " (8, '923009998877@c.us', 'Other') RETURNING id")[0][0]

    def msg(conversation, direction, body, client=7):
        return sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body)"
                   " VALUES (%s, %s, %s, %s) RETURNING id", (conversation, client, direction, body))[0][0]

    def hook(conversation, client=7):
        c = connect()
        try:
            with c.cursor() as cur:
                import portal_txn
                with portal_txn.savepoint(cur, c, "of_hook"):
                    out = ps.on_inbound(cur, client, conversation, "")
                cur.execute("SELECT 1")
                usable = cur.fetchone() == (1,)
            c.commit()
            return out, usable
        finally:
            c.close()

    # --- bare database: no catalog / intelligence / links ------------------
    msg(conv, "in", "Salam, 2 pcs chahiye Lahore mein")
    ps._CATALOG_CACHE.clear()
    out, usable = hook(conv)
    check("db: bare database -> lead stored, transaction usable",
          usable and out and out["qualifiers"] == {"quantity": 2, "city": "Lahore"} and out["products"] == []
          and out["purchase_intent"] == "" and sql("SELECT score FROM portal_sales_leads WHERE conversation_id = %s",
                                                   (conv,))[0][0] == out["score"], out)
    check("db: auto stage off by default -> pipeline untouched",
          sql("SELECT to_regclass('portal_contact_stage')")[0][0] is None)
    check("db: unknown conversation -> nothing", hook(999999)[0] is None)
    check("db: another workspace's chat is not read", hook(other, client=7)[0] is None)

    # --- seed catalog + intelligence ---------------------------------------
    import portal_catalog
    import portal_intelligence
    import portal_checkout
    import portal_negotiation
    c = connect()
    portal_catalog._ensure_catalog_tables(c)
    with c.cursor() as cur:
        portal_intelligence._ensure_ddl(cur)
    c.commit()
    portal_checkout._ensure_checkout_tables(c)
    portal_negotiation._ensure_negotiation_tables(c)
    c.close()
    shoes = sql("INSERT INTO portal_catalog (client_id, name, kind, price_text, price, stock, notes) VALUES"
                " (7, 'Black Leather Shoes', 'product', 'Rs 2,500', 2500, 4, 'Size 6-11') RETURNING id")[0][0]
    kurta = sql("INSERT INTO portal_catalog (client_id, name, kind, price_text, price) VALUES"
                " (7, 'Red Kurta', 'product', 'Rs 1,800', 1800) RETURNING id")[0][0]
    noprice = sql("INSERT INTO portal_catalog (client_id, name, kind, price_text) VALUES"
                  " (7, 'Gift Box', 'product', 'ask') RETURNING id")[0][0]
    hidden = sql("INSERT INTO portal_catalog (client_id, name, kind, price, is_active) VALUES"
                 " (7, 'Old Sandal', 'product', 900, FALSE) RETURNING id")[0][0]
    foreign = sql("INSERT INTO portal_catalog (client_id, name, kind, price) VALUES"
                  " (8, 'Foreign Item', 'product', 100) RETURNING id")[0][0]
    sql("INSERT INTO portal_intelligence (client_id, conversation_id, intent, sentiment, language,"
        " purchase_intent, urgency) VALUES (7, %s, 'purchase', 'neutral', 'roman_urdu', 'high', 'low')",
        (conv,), fetch=False)
    msg(conv, "out", "Ji kaunsa item?")
    msg(conv, "in", "black leather shoes, bohat mehnga hai thora kam karo")
    ps._CATALOG_CACHE.clear()
    out, usable = hook(conv)
    check("db: product matched from the catalog + intent + concern",
          usable and out["qualifiers"].get("product") == "Black Leather Shoes" and out["purchase_intent"] == "high"
          and out["objection_kinds"] == ["price"] and out["current_objections"] == ["price"]
          and out["stage_hint"] == "negotiating" and out["label"] == "hot", out)
    stored = sql("SELECT label, stage_hint, objections, qualifiers FROM portal_sales_leads WHERE conversation_id = %s",
                 (conv,))[0]
    check("db: stored lead row", stored[0] == "hot" and stored[1] == "negotiating" and "price" in stored[2]
          and stored[3]["city"] == "Lahore", stored)
    ps._CATALOG_CACHE.clear()
    check("db: inactive / foreign products are never matched",
          [i["id"] for i in ps.match_products("old sandal foreign item", ps.catalog(connect().cursor(), 7))] == [])

    # concerns accumulate over the chat (older ones kept after the window)
    ps.OBJECTION_MESSAGES = 1
    msg(conv, "in", "original hai na?")
    out, _ = hook(conv)
    kinds = sql("SELECT objections FROM portal_sales_leads WHERE conversation_id = %s", (conv,))[0][0]
    check("db: concerns accumulate across the chat", set(kinds) == {"price", "trust"}, kinds)
    ps.OBJECTION_MESSAGES = 6

    # --- auto stage: forward only ------------------------------------------
    sql("INSERT INTO portal_sales_settings (client_id, auto_stage) VALUES (7, TRUE)", fetch=False)
    out, _ = hook(conv)
    check("db: auto stage moves the pipeline forward + logs it",
          out.get("stage_moved") is True and sql("SELECT stage FROM portal_contact_stage WHERE contact_id = %s",
                                                 (contact,))[0][0] == "negotiating"
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'pipeline.stage_changed'"
                  " AND actor_kind = 'system' AND note = %s",
                  ("Contact moved to 'negotiating': " + contact + ".",))[0][0] == 1)
    out, _ = hook(conv)
    check("db: no repeat move / log", out.get("stage_moved") is False
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'pipeline.stage_changed'")[0][0] == 1)
    sql("UPDATE portal_contact_stage SET stage = 'won' WHERE contact_id = %s", (contact,), fetch=False)
    hook(conv)
    check("db: never moves a won contact", sql("SELECT stage FROM portal_contact_stage WHERE contact_id = %s",
                                                (contact,))[0][0] == "won")
    c = connect()
    with c.cursor() as cur:
        check("db: never backward (negotiating -> interested refused)",
              ps.advance_stage(cur, 7, "x@c.us", "negotiating") is True
              and ps.advance_stage(cur, 7, "x@c.us", "interested") is False
              and ps.advance_stage(cur, 7, "x@c.us", "won") is False)
    c.rollback()
    c.close()
    sql("UPDATE portal_sales_settings SET auto_stage = FALSE WHERE client_id = 7", fetch=False)

    # --- brain note ---------------------------------------------------------
    c = connect()
    with c.cursor() as cur:
        note = ps.context_for(cur, 7, conv, contact, "price kam karo")
        check("brain note: stage, known, concern without an approved answer",
              note and note["objection"] == {"kind": "price", "concern": "Price is too high", "approved_answer": ""}
              and note["known"]["product"] == "Black Leather Shoes" and note["ask_next"] == "", note)
    c.rollback()
    c.close()
    sql("INSERT INTO portal_sales_playbook (client_id, kind, reply) VALUES (7, 'price', 'Quality ke hisab se"
        " yeh best rate he.')", fetch=False)
    sql("UPDATE portal_sales_settings SET qualifiers = '[\"product\", \"payment\"]'::jsonb WHERE client_id = 7",
        fetch=False)
    c = connect()
    with c.cursor() as cur:
        note = ps.context_for(cur, 7, conv, contact, "black leather shoes ya red kurta? price kam karo")
        check("brain note: approved answer + next question + compare (catalog fields only)",
              note["objection"]["approved_answer"] == "Quality ke hisab se yeh best rate he."
              and note["ask_next"] == "Payment"
              and note["compare"] == [
                  {"name": "Black Leather Shoes", "price": 2500.0, "in_stock": True, "notes": "Size 6-11"},
                  {"name": "Red Kurta", "price": 1800.0, "in_stock": None, "notes": ""}], note)
        sql("UPDATE portal_sales_settings SET brain_context = FALSE WHERE client_id = 7", fetch=False)
        check("brain note: switched off -> None", ps.context_for(cur, 7, conv, contact, "price?") is None)
        sql("UPDATE portal_sales_settings SET brain_context = TRUE WHERE client_id = 7", fetch=False)
        idle = sql("INSERT INTO portal_conversations (client_id, contact_id) VALUES (7, 'idle@c.us')"
                   " RETURNING id")[0][0]
        msg(idle, "in", "hello")
        check("brain note: plain chat -> None", ps.context_for(cur, 7, idle, "idle@c.us", "hello") is None)
    c.rollback()
    c.close()

    import portal_brain
    import portal_llm
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

    real = (portal_llm.chat_json, portal_llm.usage_scope)
    portal_llm.chat_json, portal_llm.usage_scope = fake_chat, Scope
    # the other brain tools have their own suites (bare tables here)
    tools = {name: getattr(portal_brain, name) for name in (
        "tool_customer_orders", "tool_search_kb", "tool_business_facts", "tool_customer_memory",
        "tool_customer_profile")}
    for name in tools:
        setattr(portal_brain, name, (lambda *a, **k: {}) if name == "tool_customer_profile"
                else (lambda *a, **k: []))
    try:
        c = connect()
        with c.cursor() as cur:  # production: the brain creates its tables first
            portal_brain._DDL_READY = False
            portal_brain._ensure_ddl(cur)
        c.commit()
        with c.cursor() as cur:  # the production cursor kind (portal_db._conn)
            payload, grounding = portal_brain._reason(cur, 7, conv, contact, "Ali", "price kam karo", "")
            check("brain: SALES note in context + rules appended + grounding tagged",
                  payload and "sales" in seen["user"] and ps.SALES_RULES in seen["system"]
                  and "sales_context" in grounding["tools"]
                  and grounding["sales"]["objection"] == "price" and grounding["sales"]["approved_answer"] is True,
                  grounding)
            payload, grounding = portal_brain._reason(cur, 7, idle, "idle@c.us", "", "hello", "")
            check("brain: no sales note -> prompt unchanged", "sales" not in seen["user"]
                  and ps.SALES_RULES not in seen["system"] and "sales_context" not in grounding["tools"])
            cur.execute("SELECT 1")
            check("brain: transaction still usable", cur.fetchone() == (1,))
        c.rollback()
        c.close()
    finally:
        portal_llm.chat_json, portal_llm.usage_scope = real
        for name, fn in tools.items():
            setattr(portal_brain, name, fn)

    # --- HTTP ---------------------------------------------------------------
    app = Flask("sales")
    app.register_blueprint(ps.bp)
    owner = {"client_id": 7, "user_id": 3, "role": "owner", "email": "o@x.test"}
    agent = dict(owner, role="agent", user_id=4)
    ps.authenticate_portal_request = lambda: dict(owner)
    client = app.test_client()
    base = "/api/v1/portal/sales"
    res = client.get(base + "/settings")
    body = res.get_json()
    check("http: settings + playbook + qualifier list", res.status_code == 200 and body["can_edit"] is True
          and body["settings"]["qualifiers"] == ["product", "payment"] and len(body["playbook"]) == 9
          and body["playbook"][0]["reply"].startswith("Quality") and len(body["qualifiers"]) == 6, body)
    res = client.put(base + "/settings", json={"auto_stage": True, "qualifiers": ["city", "quantity"]})
    check("http: settings save merges", res.status_code == 200 and res.get_json()["settings"] ==
          {"auto_stage": True, "brain_context": True, "qualifiers": ["city", "quantity"]})
    check("http: settings save is logged",
          sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'sales.settings'")[0][0] == 1)
    for bad in ({"auto_stage": "yes"}, {"qualifiers": ["city", "zip"]}, {"qualifiers": "city"}):
        check("http: bad settings 400 " + json.dumps(bad), client.put(base + "/settings", json=bad).status_code == 400)
    res = client.put(base + "/playbook/trust", json={"reply": "  Hum   asal product bhejte hain. "})
    check("http: playbook save (whitespace tidied)", res.status_code == 200 and
          [p for p in res.get_json()["playbook"] if p["kind"] == "trust"][0]["reply"] == "Hum asal product bhejte hain.")
    check("http: unknown concern 404", client.put(base + "/playbook/weather", json={"reply": "x"}).status_code == 404)
    check("http: too long 400", client.put(base + "/playbook/trust", json={"reply": "x" * 700}).status_code == 400)
    check("http: enabled must be bool", client.put(base + "/playbook/trust",
                                                    json={"reply": "x", "enabled": "no"}).status_code == 400)
    ps.authenticate_portal_request = lambda: dict(agent)
    check("http: agents read settings", client.get(base + "/settings").get_json()["can_edit"] is False)
    check("http: agents cannot change settings / answers",
          client.put(base + "/settings", json={"auto_stage": False}).status_code == 403
          and client.put(base + "/playbook/price", json={"reply": "x"}).status_code == 403)
    res = client.get(base + "/conversations/%d" % conv)
    body = res.get_json()
    check("http: lead card (agent): concerns with approved answers, catalog choices priced only",
          res.status_code == 200 and body["lead"]["label"] == "hot"
          and {c["kind"] for c in body["lead"]["concerns"]} >= {"price", "trust"}
          and [c for c in body["lead"]["concerns"] if c["kind"] == "trust"][0]["approved_answer"]
          == "Hum asal product bhejte hain."
          and [i["id"] for i in body["catalog"]] == [shoes, kurta]
          and body["can_discount"] is False and body["max_discount_percent"] == 25
          and body["lead"]["missing"] == [] and body["quote_days"] == ps.QUOTE_DAYS, body)
    check("http: another workspace's chat -> 404", client.get(base + "/conversations/%d" % other).status_code == 404)

    quote = {"conversation_id": conv, "items": [{"catalog_id": shoes, "qty": 2}, {"catalog_id": kurta}]}
    check("http: agent discount -> 403",
          client.post(base + "/quotes", json=dict(quote, discount_percent=5)).status_code == 403)
    res = client.post(base + "/quotes", json=quote)
    link = (res.get_json() or {}).get("link") or {}
    check("http: agent quote without discount, priced from the catalog",
          res.status_code == 200 and link["total"] == 6800.0 and link["discount"] == 0
          and link["items"] == [{"name": "Black Leather Shoes", "qty": 2, "price": 2500.0},
                                {"name": "Red Kurta", "qty": 1, "price": 1800.0}]
          and link["title"].startswith("Quote: ") and link["token"] and link["expires_at"], link)
    check("http: quote is a normal checkout link for this contact (recovery follows up)",
          sql("SELECT contact_id, status FROM portal_checkout_links WHERE id = %s", (link["id"],))[0]
          == (contact, "open"))
    check("http: quote logged on the conversation",
          sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'sales.quote' AND conversation_id = %s",
              (conv,))[0][0] == 1)
    ps.authenticate_portal_request = lambda: dict(owner)
    res = client.post(base + "/quotes", json=dict(quote, discount_percent=10, expires_in_days=7, title="Eid offer"))
    link = res.get_json()["link"]
    check("http: owner discount within the limit", res.status_code == 200 and link["discount"] == 680.0
          and link["total"] == 6120.0 and link["title"] == "Eid offer", link)
    res = client.post(base + "/quotes", json=dict(quote, discount_percent=30))
    check("http: above the negotiation limit -> 400", res.status_code == 400
          and "25%" in res.get_json()["error"]["message"])
    sql("INSERT INTO portal_negotiation_settings (client_id, max_percent) VALUES (7, 40)", fetch=False)
    check("http: the owner's own limit applies",
          client.post(base + "/quotes", json=dict(quote, discount_percent=30)).status_code == 200)
    for name, bad in (("no price", {"items": [{"catalog_id": noprice}]}),
                      ("inactive", {"items": [{"catalog_id": hidden}]}),
                      ("foreign", {"items": [{"catalog_id": foreign}]}),
                      ("qty 0", {"items": [{"catalog_id": shoes, "qty": 0}]}),
                      ("no items", {"items": []}),
                      ("11 items", {"items": [{"catalog_id": shoes}] * 11}),
                      ("bad discount", {"discount_percent": "5"}),
                      ("bad expiry", {"expires_in_days": 90})):
        check("http: quote 400 - " + name, client.post(base + "/quotes", json=dict(quote, **bad)).status_code == 400)
    check("http: quote for another workspace's chat -> 404",
          client.post(base + "/quotes", json=dict(quote, conversation_id=other)).status_code == 404)
    check("http: no stage move after quote for a won contact",
          sql("SELECT stage FROM portal_contact_stage WHERE contact_id = %s", (contact,))[0][0] == "won")

    sql("UPDATE portal_checkout_links SET status = 'paid' WHERE id = %s", (link["id"],), fetch=False)
    msg(other, "in", "black leather shoes chahiye, mehnga hai", client=8)
    check("db: workspace 8 has its own lead", hook(other, client=8)[0] is not None)
    res = client.get(base + "/overview")
    body = res.get_json()
    lead = [entry for entry in body["leads"] if entry["conversation_id"] == conv][0]
    check("http: overview leads + concern stats + totals",
          res.status_code == 200 and lead["bought"] is True and lead["product"] == "Black Leather Shoes"
          and {s["kind"] for s in body["concerns"]} >= {"price", "trust"}
          and [s for s in body["concerns"] if s["kind"] == "price"][0]["rate"] == 100
          and [s for s in body["concerns"] if s["kind"] == "price"][0]["has_answer"] is True
          and body["totals"]["hot"]["bought"] == 1 and body["days"] == ps.OVERVIEW_DAYS, body)
    check("http: overview never lists another workspace", all(entry["conversation_id"] != other
                                                              for entry in body["leads"]))
    ps.authenticate_portal_request = lambda: None
    check("http: signed out -> 401", client.get(base + "/overview").status_code == 401)
    ps.authenticate_portal_request = lambda: dict(owner, via_api_key=True)
    check("http: API keys are refused (human only)", client.get(base + "/overview").status_code == 403)


db_half()
sys.exit(1 if summary("sales") else 0)
