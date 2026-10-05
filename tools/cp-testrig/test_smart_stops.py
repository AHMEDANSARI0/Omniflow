"""§236 follow-up smart stops, on a real database (pgserver).

A series stops by itself when the customer opts out (always), buys (link
paid / advance paid / shipped, gateway payment, COD confirmed - per-series
switch) or a person takes over (teammate reply, handoff - per-series
switch); a follow-up waits when another series wrote to the chat within the
workspace gap. Stopped enrollments keep a reason and can be resumed (not
opt-outs). Signal tables that do not exist never stop anything, and a
broken one fails soft. Plus the keyword-series and "off = not enrolling"
semantics, settings / update / stats / export.
"""
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
os.environ.pop("OF_SEQ_GAP_HOURS", None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_sequences as seqs  # noqa: E402

print("== unit ==")
check("default gap 4h (follow-ups only)", seqs.GAP_HOURS_DEFAULT == 4)
check("_gap_of: NULL -> default, value kept, clamped", seqs._gap_of({"gap_hours": None}) == 4
      and seqs._gap_of({"gap_hours": 0}) == 0 and seqs._gap_of({"gap_hours": 9}) == 9
      and seqs._gap_of({"gap_hours": True}) == 4 and seqs._gap_of({"gap_hours": 99999}) == seqs.MAX_DELAY_HOURS)
row_on = {"stop_on_purchase": True, "stop_on_human": True}
row_off = {"stop_on_purchase": False, "stop_on_human": False}
sr = seqs.stop_reason_for
check("opt-out stops even with both switches off",
      sr(row_off, {"opted_out": True, "purchased": True, "human": True}) == "opted_out")
check("purchase before human", sr(row_on, {"purchased": True, "human": True}) == "purchased")
check("switch off -> no purchase stop", sr(row_off, {"purchased": True}) is None)
check("human switch", sr(row_on, {"human": True}) == "human_took_over" and sr(row_off, {"human": True}) is None)
check("NULL flags (old rows) count as on", sr({}, {"human": True}) == "human_took_over")
check("no signal -> keep going", sr(row_on, None) is None and sr(row_on, {}) is None)
check("every reason has a note", all(r in seqs.STOP_NOTES for r in ("opted_out", "purchased", "human_took_over")))


def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="stops236_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()
    portal_db.CMD_TABLE = "portal_connector_commands"

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
    seqs._SEQ_DDL_READY = False
    seqs._SIGNAL_TABLES_SEEN.clear()
    c = connect()
    seqs._ensure_seq_tables(c)
    c.close()
    cid = 7
    counter = [0]

    def series(name, flags=None, keyword=None, enabled=True, steps=((0, "Hi {name}"), (24, "Follow up"), (24, "Last"))):
        flags = flags or {}
        sid = sql("INSERT INTO portal_sequences (client_id, name, enabled, trigger_keyword, stop_on_purchase,"
                  " stop_on_human) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                  (cid, name, enabled, keyword, flags.get("purchase", True), flags.get("human", True)))[0][0]
        for number, (delay, body) in enumerate(steps, start=1):
            sql("INSERT INTO portal_sequence_steps (client_id, sequence_id, step_no, delay_hours, body)"
                " VALUES (%s, %s, %s, %s, %s)", (cid, sid, number, delay, body), fetch=False)
        return sid

    def chat(client=cid):
        counter[0] += 1
        contact = "92300%07d@c.us" % counter[0]
        conv = sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name) VALUES"
                   " (%s, %s, 'Ali Khan') RETURNING id", (client, contact))[0][0]
        sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body) VALUES"
            " (%s, %s, 'in', 'salam')", (conv, client), fetch=False)
        return conv, contact

    def enroll(sid, conv, contact, step=1, joined_hours=3):
        return sql("INSERT INTO portal_sequence_enrollments (client_id, sequence_id, conversation_id, contact_id,"
                   " contact_name, current_step, next_at, enrolled_at) VALUES (%s, %s, %s, %s, 'Ali Khan', %s,"
                   " NOW() - interval '1 minute', NOW() - make_interval(hours => %s)) RETURNING id",
                   (cid, sid, conv, contact, step, joined_hours))[0][0]

    def deliver():
        c = connect()
        try:
            with c.cursor() as cur:
                sent = seqs.deliver_due_sequence_steps(cur, cid, c)
            c.commit()
            return sent
        finally:
            c.close()

    def state(eid):
        return sql("SELECT status, stop_reason, current_step, stopped_at IS NOT NULL FROM"
                   " portal_sequence_enrollments WHERE id = %s", (eid,))[0]

    def sends(contact):
        return sql("SELECT COUNT(*) FROM portal_connector_commands WHERE client_id = %s"
                   " AND payload->>'external_user_id' = %s AND requested_by IS NULL", (cid, contact))[0][0]

    def park_others():
        sql("UPDATE portal_sequence_enrollments SET status = 'completed' WHERE status = 'active'", fetch=False)

    # --- no signal tables yet: nothing stops, delivery works -------------
    s_main = series("Main")
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    check("db: no checkout/handoff tables -> follow-up sent", deliver() == 1 and sends(contact) == 1)
    check("db: probe found none of the optional tables", seqs._SIGNAL_TABLES_SEEN == set(), seqs._SIGNAL_TABLES_SEEN)
    check("db: step advanced", state(eid)[2] == 2)

    # --- opted out: always stops ------------------------------------------
    park_others()
    s_off = series("Switches off", {"purchase": False, "human": False})
    conv, contact = chat()
    eid = enroll(s_off, conv, contact)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (%s, %s)", (cid, contact), fetch=False)
    check("db: opted out -> nothing sent", deliver() == 0 and sends(contact) == 0)
    st = state(eid)
    check("db: stopped with reason opted_out + stopped_at", st[0] == "stopped" and st[1] == "opted_out" and st[3], st)
    check("db: step log row 'stopped'", sql("SELECT action, step_no FROM portal_sequence_step_log"
                                            " WHERE enrollment_id = %s", (eid,)) == [("stopped", 2)])
    check("db: audit sequence.stopped with the reason in words",
          sql("SELECT note FROM portal_action_log WHERE action = 'sequence.stopped' AND conversation_id = %s",
              (conv,))[0][0].endswith("the customer opted out."))

    # --- tenant isolation: another workspace's opt-out does not count -----
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (8, %s)", (contact,), fetch=False)
    check("db: opt-out in another workspace -> still sent", deliver() == 1 and state(eid)[0] == "active")

    # --- a teammate replied ------------------------------------------------
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_connector_commands (client_id, action, payload, requested_by) VALUES"
        " (%s, 'send_message', jsonb_build_object('conversation_id', %s::bigint, 'body', 'Hi, Sara here'), 42)",
        (cid, conv), fetch=False)
    check("db: teammate reply -> stopped human_took_over", deliver() == 0 and state(eid)[:2] == ("stopped", "human_took_over"))
    park_others()
    conv, contact = chat()
    eid = enroll(s_off, conv, contact)
    sql("INSERT INTO portal_connector_commands (client_id, action, payload, requested_by) VALUES"
        " (%s, 'send_message', jsonb_build_object('external_user_id', %s::text), 42)", (cid, contact), fetch=False)
    check("db: switch off -> teammate reply does not stop", deliver() == 1 and state(eid)[0] == "active")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_connector_commands (client_id, action, payload, requested_by, created_at) VALUES"
        " (%s, 'send_message', jsonb_build_object('conversation_id', %s::bigint), 42, NOW() - interval '5 hours')",
        (cid, conv), fetch=False)
    sql("INSERT INTO portal_connector_commands (client_id, action, payload, requested_by) VALUES"
        " (%s, 'send_message', jsonb_build_object('conversation_id', %s::bigint), NULL)", (cid, conv), fetch=False)
    check("db: reply before joining + automated sends never count", deliver() == 1 and state(eid)[0] == "active")

    # --- handoff -----------------------------------------------------------
    import portal_escalation
    c = connect()
    with c.cursor() as cur:
        portal_escalation._ensure_ddl(cur)
    c.commit()
    c.close()
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_escalations (client_id, conversation_id, reason) VALUES (%s, %s, 'needs_human')",
        (cid, conv), fetch=False)
    check("db: handoff table appears later -> probed again and the handoff stops the series",
          deliver() == 0 and state(eid)[:2] == ("stopped", "human_took_over"))
    check("db: probe cache now has handoffs", "handoffs" in seqs._SIGNAL_TABLES_SEEN)

    # --- purchases ---------------------------------------------------------
    import portal_checkout
    import portal_payments
    import portal_cod
    c = connect()
    portal_checkout._ensure_checkout_tables(c)
    portal_payments._ensure_intents_table(c)
    portal_cod._ensure_cod_tables(c)
    c.close()

    def link(contact, status="open", paid=0, hours_ago=0):
        return sql("INSERT INTO portal_checkout_links (client_id, contact_id, token, total, status, paid_amount,"
                   " created_at) VALUES (%s, %s, md5(random()::text), 1000, %s, %s,"
                   " NOW() - make_interval(hours => %s)) RETURNING id", (cid, contact, status, paid, hours_ago))[0][0]

    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    link(contact, "open")
    check("db: unpaid open link -> still sent", deliver() == 1 and state(eid)[0] == "active")
    check("db: all four signal tables now cached", seqs._SIGNAL_TABLES_SEEN == set(seqs.SIGNAL_TABLES))
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    link(contact, "paid", 1000)
    check("db: paid link -> stopped purchased", deliver() == 0 and state(eid)[:2] == ("stopped", "purchased"))
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    link(contact, "open", 300)
    check("db: advance paid -> stopped purchased", deliver() == 0 and state(eid)[1] == "purchased")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    link(contact, "paid", 1000, hours_ago=10)
    check("db: an order from before joining does not stop", deliver() == 1 and state(eid)[0] == "active")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    lid = link(contact, "open")
    sql("INSERT INTO portal_payment_intents (client_id, link_id, token, status) VALUES (%s, %s, md5(random()::text),"
        " 'paid')", (cid, lid), fetch=False)
    check("db: gateway payment -> stopped purchased", deliver() == 0 and state(eid)[1] == "purchased")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_cod_requests (client_id, conversation_id, contact_id, status) VALUES (%s, %s, %s,"
        " 'pending')", (cid, conv, contact), fetch=False)
    check("db: COD still pending -> sent", deliver() == 1)
    park_others()
    conv, contact = chat()
    eid2 = enroll(s_off, conv, contact)
    sql("INSERT INTO portal_cod_requests (client_id, conversation_id, contact_id, status, answered_at)"
        " VALUES (%s, %s, %s, 'confirmed', NOW())", (cid, conv, contact), fetch=False)
    check("db: COD confirmed + purchase switch off -> sent", deliver() == 1 and state(eid2)[0] == "active")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_cod_requests (client_id, conversation_id, contact_id, status, answered_at)"
        " VALUES (%s, %s, %s, 'confirmed', NOW())", (cid, conv, contact), fetch=False)
    check("db: COD confirmed -> stopped purchased", deliver() == 0 and state(eid)[1] == "purchased")

    # --- spacing between series -------------------------------------------
    park_others()
    s_other = series("Other")
    conv, contact = chat()
    other = enroll(s_other, conv, contact)
    sql("INSERT INTO portal_sequence_step_log (client_id, sequence_id, enrollment_id, step_no, action, created_at)"
        " VALUES (%s, %s, %s, 1, 'sent', NOW() - interval '1 hour')", (cid, s_other, other), fetch=False)
    sql("UPDATE portal_sequence_enrollments SET status = 'completed' WHERE id = %s", (other,), fetch=False)
    eid = enroll(s_main, conv, contact)
    check("db: follow-up within 4h of another series -> waits (nothing sent)", deliver() == 0 and sends(contact) == 0)
    wait = sql("SELECT EXTRACT(EPOCH FROM next_at - NOW()) / 3600.0, status FROM portal_sequence_enrollments"
               " WHERE id = %s", (eid,))[0]
    check("db: rescheduled to the other send + 4h (about 3h from now), still active",
          2.9 < float(wait[0]) < 3.1 and wait[1] == "active", wait)
    sql("UPDATE portal_sequence_enrollments SET next_at = NOW() - interval '1 minute' WHERE id = %s", (eid,),
        fetch=False)
    sql("INSERT INTO portal_sequence_settings (client_id, gap_hours) VALUES (%s, 0)", (cid,), fetch=False)
    check("db: workspace gap 0 -> sent right away", deliver() == 1)
    sql("UPDATE portal_sequence_settings SET gap_hours = NULL", fetch=False)
    park_others()
    conv, contact = chat()
    other = enroll(s_other, conv, contact)
    sql("INSERT INTO portal_sequence_step_log (client_id, sequence_id, enrollment_id, step_no, action)"
        " VALUES (%s, %s, %s, 1, 'sent')", (cid, s_other, other), fetch=False)
    sql("UPDATE portal_sequence_enrollments SET status = 'completed' WHERE id = %s", (other,), fetch=False)
    first = enroll(s_main, conv, contact, step=0)
    check("db: a series' FIRST message is never delayed by the gap", deliver() == 1 and state(first)[2] == 1)

    # --- off = not enrolling; keyword series --------------------------------
    park_others()
    s_paused = series("Switched off", enabled=False)
    conv, contact = chat()
    eid = enroll(s_paused, conv, contact)
    check("db: switched-off series keeps delivering to people already in it", deliver() == 1)
    park_others()
    sql("UPDATE portal_sequences SET enabled = FALSE", fetch=False)
    s_kw = series("Catalog", keyword="catalog")
    s_new = series("Welcome")
    conv, contact = chat()
    c = connect()
    seqs.maybe_enroll_new_contact(cid, conv, contact, "Ali", c)
    c.commit()
    c.close()
    got = {r[0] for r in sql("SELECT sequence_id FROM portal_sequence_enrollments WHERE conversation_id = %s",
                             (conv,))}
    check("db: new contact -> keyword-less series only (not the keyword series)", got == {s_new}, got)

    # --- broken signal table fails soft --------------------------------------
    park_others()
    sql("UPDATE portal_sequences SET enabled = FALSE", fetch=False)
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("ALTER TABLE portal_cod_requests RENAME COLUMN answered_at TO answered_old", fetch=False)
    check("db: stop check fails (old table shape) -> delivery still sends", deliver() == 1 and sends(contact) == 1)
    sql("ALTER TABLE portal_cod_requests RENAME COLUMN answered_old TO answered_at", fetch=False)

    # --- routes: resume, settings, update, stats, export ----------------------
    app = Flask("stops")
    app.register_blueprint(seqs.bp)
    principal = {"client_id": cid, "user_id": 3, "role": "owner", "email": "o@x.test"}
    seqs.authenticate_portal_request = lambda: dict(principal)
    client = app.test_client()
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_connector_commands (client_id, action, payload, requested_by) VALUES"
        " (%s, 'send_message', jsonb_build_object('conversation_id', %s::bigint), 42)", (cid, conv), fetch=False)
    deliver()
    rows = client.get("/api/v1/portal/sequences/%d/enrollments" % s_main).get_json()
    mine = [r for r in rows.get("enrollments", []) if r.get("id") == eid]
    check("api: list shows stopped + reason", mine and mine[0].get("status") == "stopped"
          and mine[0].get("stop_reason") == "human_took_over", mine)
    stats = client.get("/api/v1/portal/sequences/%d/stats" % s_main).get_json()
    check("api: stats count stopped per step", any(s.get("stopped", 0) >= 1 for s in stats.get("steps", [])), stats)
    export = client.get("/api/v1/portal/sequences/%d/enrollments/export" % s_main)
    check("api: export has a stop_reason column", "stop_reason" in export.get_data(as_text=True).splitlines()[0])
    r = client.post("/api/v1/portal/sequences/%d/enrollments/%d/resume" % (s_main, eid))
    st = state(eid)
    check("api: resume a stopped enrollment -> active, reason cleared", r.status_code == 200
          and st[0] == "active" and st[1] is None and not st[3], (r.status_code, st))
    check("db: after resume the old teammate reply no longer stops it", deliver() == 1 and state(eid)[0] == "active")
    park_others()
    conv, contact = chat()
    eid = enroll(s_main, conv, contact)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (%s, %s)", (cid, contact), fetch=False)
    deliver()
    r = client.post("/api/v1/portal/sequences/%d/enrollments/%d/resume" % (s_main, eid))
    check("api: an opted-out enrollment cannot be resumed (404)", r.status_code == 404 and state(eid)[0] == "stopped")

    sql("DELETE FROM portal_sequence_settings", fetch=False)
    body = client.get("/api/v1/portal/sequences/settings").get_json()
    check("api: settings show the default gap", body.get("gap_hours") == 4 and body.get("gap_hours_default") == 4, body)
    base = {"quiet_enabled": False, "quiet_start": 22, "quiet_end": 8, "utc_offset": 5}
    check("api: gap 6 saved", client.put("/api/v1/portal/sequences/settings", json=dict(base, gap_hours=6)).status_code
          == 200 and client.get("/api/v1/portal/sequences/settings").get_json().get("gap_hours") == 6)
    check("api: gap kept when not sent", client.put("/api/v1/portal/sequences/settings", json=base).status_code == 200
          and client.get("/api/v1/portal/sequences/settings").get_json().get("gap_hours") == 6)
    for bad in (200, -1, True, "4"):
        check("api: gap %r -> 400" % (bad,),
              client.put("/api/v1/portal/sequences/settings", json=dict(base, gap_hours=bad)).status_code == 400)
    check("api: gap null -> back to the default",
          client.put("/api/v1/portal/sequences/settings", json=dict(base, gap_hours=None)).status_code == 200
          and client.get("/api/v1/portal/sequences/settings").get_json().get("gap_hours") == 4)
    r = client.put("/api/v1/portal/sequences/%d" % s_main, json={"stop_on_purchase": False, "stop_on_human": False})
    flags = sql("SELECT stop_on_purchase, stop_on_human FROM portal_sequences WHERE id = %s", (s_main,))[0]
    check("api: update stop switches -> persisted (commit fixed)", r.status_code == 200 and flags == (False, False),
          (r.status_code, flags))
    check("api: non-bool switch -> 400",
          client.put("/api/v1/portal/sequences/%d" % s_main, json={"stop_on_human": "no"}).status_code == 400)
    listed = [s for s in client.get("/api/v1/portal/sequences").get_json().get("sequences", []) if s["id"] == s_main]
    check("api: list shows the switches", listed and listed[0].get("stop_on_purchase") is False
          and listed[0].get("stop_on_human") is False, listed)
    principal["client_id"] = 8
    r = client.put("/api/v1/portal/sequences/%d" % s_main, json={"stop_on_human": True})
    check("api: another workspace cannot change the series",
          r.status_code == 404 and sql("SELECT stop_on_human FROM portal_sequences WHERE id = %s", (s_main,))[0][0]
          is False, r.status_code)


db_half()
sys.exit(1 if summary("smart_stops") else 0)
