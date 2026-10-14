"""§223 secrets vault - unit contract + real-PostgreSQL route/migration flow.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
The database half uses `pgserver` (a real PostgreSQL 16) when it is
installed and is skipped otherwise; the unit half always runs.
"""
import hashlib
import hmac
import os
import sys

from test_lib import check, summary, human_principal, PrincipalStub

KEY_A = "a" * 20 + "-vault-test-key-A-0123456789"
KEY_B = "b" * 20 + "-vault-test-key-B-9876543210"
KEY_C = "c" * 20 + "-vault-test-key-C-lost-lost-"


def set_keys(current="", old=""):
    for name, value in (("OF_SECRETS_KEY", current), ("OF_SECRETS_KEY_OLD", old)):
        if value:
            os.environ[name] = value
        else:
            os.environ.pop(name, None)


set_keys()
import portal_vault as V  # noqa: E402

print("== vault unit ==")
check("no key: problem key_missing", V.status()["problem"] == "key_missing")
check("no key: seal is passthrough", V.seal("tok-123") == "tok-123")
check("no key: plain unseal passthrough", V.unseal("tok-123") == "tok-123")
set_keys("short-key")
check("short key refused", V.status()["problem"] == "key_too_short"
      and V.seal("x1") == "x1" and not V.status()["configured"])
set_keys(KEY_A)
st = V.status()
check("key A configured", st["configured"] and st["problem"] == ""
      and len(st["key_id"]) == 8 and st["algorithm"] == "AES-256-GCM")
s1, s2 = V.seal("EAAG-secret-token"), V.seal("EAAG-secret-token")
check("sealed format", s1.startswith("ofv1:" + st["key_id"] + ":"), s1[:20])
check("random nonce (two seals differ)", s1 != s2)
check("roundtrip", V.unseal(s1) == "EAAG-secret-token" and V.unseal(s2) == "EAAG-secret-token")
check("plaintext never inside the token", "secret-token" not in s1)
check("unicode roundtrip", V.unseal(V.seal("پاس ورڈ ✓ key")) == "پاس ورڈ ✓ key")
check("empty stays empty", V.seal("") == "" and V.seal(None) == "" and V.unseal(None) == "")
check("seal is idempotent", V.seal(s1) == s1)
body = s1.split(":", 2)[2]
flipped = s1[:-2] + ("A" if s1[-2] != "A" else "B") + s1[-1]
check("tampered token -> empty", V.unseal(flipped) == "")
check("malformed token -> empty", V.unseal("ofv1:broken") == "")
set_keys(KEY_B)
check("other key cannot open -> empty", V.unseal(s1) == "")
set_keys(KEY_B, KEY_A)
check("rotation: old key still opens", V.unseal(s1) == "EAAG-secret-token")
st = V.status()
check("status lists old key id", len(st["old_key_ids"]) == 1 and st["old_key_ids"][0] == V.key_id_of(s1))
known = V._all_keys()
check("classify old_key", V._classify(s1, st["key_id"], known) == "old_key")
check("classify plain/sealed/unreadable",
      V._classify("raw", st["key_id"], known) == "plain"
      and V._classify(V.seal("n"), st["key_id"], known) == "sealed"
      and V._classify("ofv1:deadbeef:AAAA", st["key_id"], known) == "unreadable")
set_keys(KEY_A)
check("secret names", all(V.is_secret_setting(k) for k in (
    "llm.api_key", "voice.auth_token", "email.smtp_password", "email.brevo_api_key",
    "payments.secret_key", "payments.webhook_secret", "payments.publishable_key",
    "video.zoom_client_secret", "stt.api_key", "embeddings.api_key", "vision.api_key")))
check("non-secret names", not any(V.is_secret_setting(k) for k in (
    "llm.model", "llm.base_url", "ai.kill_switch", "voice.account_sid",
    "voice.from_number", "email.smtp_host", "llm.prices_json")))
row = {"a": V.seal("p1"), "b": "keep", "c": None}
opened = V.unseal_fields(row, ("a", "c", "missing"))
check("unseal_fields copies + opens", opened == {"a": "p1", "b": "keep", "c": ""}
      and row["a"].startswith("ofv1:") and V.unseal_fields(None, ("a",)) is None)
real_aes = V._aesgcm
V._aesgcm = lambda: None
check("library missing: problem reported", V.status()["problem"] == "library_missing"
      and not V.status()["library"])
check("library missing: seal passthrough", V.seal("tok") == "tok")
check("library missing: sealed -> empty (never ciphertext)", V.unseal(s1) == "")
V._aesgcm = real_aes

# ---------------------------------------------------------------------------
# Real PostgreSQL: routes store sealed, loaders return plain, migration.
# ---------------------------------------------------------------------------
try:
    import pgserver
    import psycopg2
except Exception:
    pgserver = None

if pgserver is None:
    print("  skip: pgserver not installed - database half not run")
else:
    print("== vault on real PostgreSQL ==")
    import shutil, tempfile
    data_dir = tempfile.mkdtemp(prefix="of_vault_pg_")
    server = pgserver.get_server(data_dir, cleanup_mode="stop")
    os.environ.update({"DB_HOST": data_dir, "DB_PORT": "5432", "DB_NAME": "postgres",
                       "DB_USER": "postgres", "DB_PASSWORD": "",
                       "PGSSLMODE": "disable", "OMNIFLOW_SERVICE_KEY": "svc-test-key"})
    import importlib
    # the rig folder ships a portal_db stub; this half needs the real one
    sys.path.insert(0, os.getcwd())
    sys.modules.pop("portal_db", None)
    import portal_db
    check("real portal_db in use", os.path.dirname(os.path.abspath(portal_db.__file__)) == os.getcwd())
    for name in ("platform_settings", "admin_providers", "portal_instagram",
                 "portal_wati", "portal_catalog", "portal_courier",
                 "portal_payments", "portal_webhooks"):
        if name in sys.modules:
            importlib.reload(sys.modules[name])
    import platform_settings as PS
    import admin_providers as AP
    import portal_instagram as IG
    import portal_wati as WA
    import portal_catalog as CA
    import portal_courier as CO
    import portal_payments as PA
    import portal_webhooks as WH
    from flask import Flask

    def raw_conn():
        return psycopg2.connect(host=data_dir, dbname="postgres", user="postgres")

    def sql(query, params=None, fetch=True):
        c = raw_conn()
        try:
            with c.cursor() as cur:
                cur.execute(query, params)
                out = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return out
        finally:
            c.close()

    try:
        portal_db.ensure_tables()
    except Exception as error:
        print("  note: ensure_tables:", type(error).__name__, str(error)[:120])
    # core audit table lives in the main app schema (not the mirror)
    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT, action TEXT, actor_kind TEXT, actor_user_id BIGINT,"
        " conversation_id BIGINT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())",
        fetch=False)
    sql("INSERT INTO platform_clients (id, name) VALUES (1, 'Vault Shop')"
        " ON CONFLICT DO NOTHING", fetch=False) if sql(
        "SELECT to_regclass('platform_clients')")[0][0] else None

    app = Flask("vault_test")
    for bp in (AP.bp, IG.bp, IG.connector_bp, WA.bp, CA.bp, CO.bp, PA.bp, WH.bp):
        app.register_blueprint(bp)
    client = app.test_client()
    principal = human_principal(client_id=1)
    stubs = [PrincipalStub(m, principal) for m in (IG, WA, CA, CO, PA, WH, PA.portal_checkout)]
    ADMIN = {"X-Omniflow-Key": "svc-test-key"}
    # plan limits live in the main app schema; not under test here
    CO.portal_plans.enforce = lambda *args, **kwargs: None

    # -- 1. legacy rows written before §223 (no key) are plain -----------
    set_keys()
    r = client.put("/api/v1/admin/providers", headers=ADMIN,
                   json={"group": "llm", "values": {"api_key": "sk-legacy-1", "model": "m1"}})
    check("legacy admin save 200", r.status_code == 200, r.get_data(as_text=True)[:200])
    raw = dict(sql("SELECT key, value FROM platform_settings"))
    check("legacy key stored plain", raw.get("llm.api_key") == "sk-legacy-1")
    r = client.put("/api/v1/portal/wati/settings",
                   json={"base_url": "https://live-server.wati.io", "api_token": "wati-legacy", "enabled": True})
    check("legacy WATI save", r.status_code in (200, 201), r.get_data(as_text=True)[:200])
    r = client.post("/api/v1/portal/webhooks", json={"url": "https://example.com/hook", "events": "all"})
    hook_ok = r.status_code in (200, 201)
    check("legacy webhook create", hook_ok, r.get_data(as_text=True)[:200])
    legacy_hook_secret = ((r.get_json() or {}).get("webhook") or {}).get("secret", "")

    rep = client.get("/api/v1/admin/security/vault", headers=ADMIN).get_json()
    check("status: route 200 + not configured", rep["status"]["problem"] == "key_missing")
    check("status: plain counted", rep["totals"]["plain"] >= 3, rep["totals"])
    check("status: values never returned", "sk-legacy-1" not in str(rep) and "wati-legacy" not in str(rep))
    check("status: needs service key", client.get("/api/v1/admin/security/vault").status_code == 403)
    m = client.post("/api/v1/admin/security/vault/migrate", headers=ADMIN)
    check("migrate without key -> 409 + reason", m.status_code == 409
          and "OF_SECRETS_KEY" in m.get_json()["error"]["message"])

    # -- 2. key A: new saves are sealed, loaders return plain ------------
    set_keys(KEY_A)
    kid_a = V.status()["key_id"]
    r = client.put("/api/v1/portal/instagram/settings", json={
        "account_id": "1784", "page_id": "99", "access_token": "EAAG-ig-token",
        "app_secret": "ig-app-secret", "verify_token": "verify-me", "enabled": False})
    check("instagram save 200", r.status_code == 200, r.get_data(as_text=True)[:300])
    ig_public = (r.get_json() or {}).get("settings", {})
    check("instagram response masks the real token tail",
          str(ig_public.get("accessTokenMasked", "")).endswith("oken")
          and "ofv1" not in str(ig_public))
    ig_raw = sql("SELECT access_token, app_secret, verify_token FROM portal_instagram_accounts WHERE client_id = 1")[0]
    check("instagram token + secret sealed in DB", ig_raw[0].startswith("ofv1:" + kid_a)
          and ig_raw[1].startswith("ofv1:"))
    check("instagram verify_token stays plain (webhook lookup)", ig_raw[2] == "verify-me")
    c = portal_db._conn()
    with c.cursor() as cur:
        a = IG._load_settings(cur, 1)
        b = IG._load_by_verify_token(cur, "verify-me")
        d = IG._load_by_account(cur, "1784")
    c.close()
    check("instagram loaders return plain", a["access_token"] == "EAAG-ig-token"
          and b["app_secret"] == "ig-app-secret" and d["access_token"] == "EAAG-ig-token")

    # outbound DM dispatch must hand Meta the PLAIN token (never ciphertext)
    for ddl in ("ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'",
                "ADD COLUMN IF NOT EXISTS result_note TEXT",
                "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"):
        sql("ALTER TABLE portal_connector_commands " + ddl, fetch=False)
    sql("UPDATE portal_instagram_accounts SET enabled = TRUE WHERE client_id = 1", fetch=False)
    cmd_id = sql("INSERT INTO portal_connector_commands (client_id, action, payload, status, channel)"
                 " VALUES (1, 'send_message', %s, 'pending', 'instagram') RETURNING id",
                 ('{"external_user_id": "ig:555", "body": "Salam"}',))[0][0]
    seen = {}
    real_meta, real_ack = IG._meta_request, IG._ack_dispatch
    IG._meta_request = lambda method, path, token, payload=None: seen.update(token=token) or {"message_id": "mid.1"}
    IG._ack_dispatch = lambda *args, **kwargs: seen.update(ack=args[2])
    r = client.post("/api/v1/connector/instagram/commands/dispatch", headers=ADMIN,
                    json={"client_id": 1, "command_id": cmd_id})
    IG._meta_request, IG._ack_dispatch = real_meta, real_ack
    check("instagram dispatch sends the plain token to Meta",
          r.status_code == 200 and seen.get("token") == "EAAG-ig-token" and seen.get("ack") is True,
          (r.status_code, r.get_data(as_text=True)[:200], seen))

    r = client.put("/api/v1/portal/courier/settings", json={
        "provider": "leopards", "api_key": "leo-key", "api_password": "leo-pass", "enabled": True})
    check("courier settings save", r.status_code == 200, r.get_data(as_text=True)[:200])
    r = client.post("/api/v1/portal/courier/providers", json={
        "name": "Leopards 2", "adapter": "leopards", "api_key": "lp-key", "api_secret": "lp-secret",
        "enabled": True})
    check("courier provider create", r.status_code in (200, 201), r.get_data(as_text=True)[:200])
    co_raw = sql("SELECT api_key, api_password FROM portal_courier_settings WHERE client_id = 1")[0]
    pr_raw = sql("SELECT id, api_key, api_secret FROM portal_courier_providers WHERE client_id = 1")[0]
    check("courier creds sealed in DB", all(v.startswith("ofv1:") for v in co_raw + pr_raw[1:]))
    c = portal_db._conn()
    with c.cursor() as cur:
        cs = CO._load_settings(cur, 1)
        cp = CO._load_provider(cur, 1, pr_raw[0])
        cd = CO._default_provider(cur, 1)
    c.close()
    check("courier loaders plain", cs["api_key"] == "leo-key" and cs["api_password"] == "leo-pass"
          and cp["api_secret"] == "lp-secret" and cd["api_key"] == "lp-key")
    r = client.patch("/api/v1/portal/courier/providers/" + str(pr_raw[0]), json={"api_secret": "lp-secret-2"})
    if r.status_code == 405:
        r = client.put("/api/v1/portal/courier/providers/" + str(pr_raw[0]), json={"api_secret": "lp-secret-2"})
    check("courier provider update", r.status_code == 200, r.get_data(as_text=True)[:200])
    c = portal_db._conn()
    with c.cursor() as cur:
        check("courier update sealed + readable",
              CO._load_provider(cur, 1, pr_raw[0])["api_secret"] == "lp-secret-2"
              and sql("SELECT api_secret FROM portal_courier_providers WHERE id = %s", (pr_raw[0],))[0][0].startswith("ofv1:"))
    c.close()
    lst = client.get("/api/v1/portal/courier/providers").get_json() or {}
    check("courier list masks plain tail", any(str(p.get("api_secret_masked", "")).endswith("t-2")
                                               for p in lst.get("providers", [])), lst)

    r = client.put("/api/v1/portal/payments/settings", json={
        "provider": "jazzcash", "enabled": True, "sandbox": True, "merchant_id": "MC1",
        "password": "jc-pass", "salt": "jc-salt", "store_id": ""})
    check("payments save", r.status_code == 200, r.get_data(as_text=True)[:200])
    pay_raw = sql("SELECT password, salt FROM portal_payment_settings WHERE client_id = 1")[0]
    c = portal_db._conn()
    with c.cursor() as cur:
        pl = PA._load_settings(cur, 1)
    c.close()
    check("payments sealed in DB, plain via loader", all(v.startswith("ofv1:") for v in pay_raw)
          and pl["password"] == "jc-pass" and pl["salt"] == "jc-salt")

    r = client.put("/api/v1/portal/catalog/sync/settings", json={
        "source": "woo", "base_url": "https://shop.example.com", "api_key": "ck_1", "api_secret": "cs_1"})
    check("catalog sync save", r.status_code == 200, r.get_data(as_text=True)[:200])
    r = client.put("/api/v1/portal/catalog/sync/settings", json={
        "source": "woo", "base_url": "https://shop.example.com", "api_key": "", "api_secret": ""})
    check("catalog blank save keeps creds", r.status_code == 200)
    cat_raw = sql("SELECT api_key, api_secret FROM portal_catalog_sync WHERE client_id = 1")[0]
    c = portal_db._conn()
    with c.cursor() as cur:
        cl = CA._load_sync_settings(cur, 1)
    c.close()
    check("catalog sealed + kept + plain via loader", all(v.startswith("ofv1:") for v in cat_raw)
          and cl["api_key"] == "ck_1" and cl["api_secret"] == "cs_1")

    r = client.post("/api/v1/portal/webhooks", json={"url": "https://example.com/hook2", "events": "all"})
    new_secret = ((r.get_json() or {}).get("webhook") or {}).get("secret", "")
    hook_raw = sql("SELECT secret FROM portal_webhooks WHERE url = 'https://example.com/hook2'")[0][0]
    check("webhook secret shown once in plain, sealed in DB", len(new_secret) == 48
          and hook_raw.startswith("ofv1:") and new_secret not in hook_raw)
    expect = hmac.new(new_secret.encode(), b"{}", hashlib.sha256).hexdigest()
    check("webhook signature uses the plain secret", WH._sign(hook_raw, "{}") == expect)

    r = client.put("/api/v1/admin/providers", headers=ADMIN,
                   json={"group": "voice", "values": {"account_sid": "AC1", "auth_token": "tw-token"}})
    raw = dict(sql("SELECT key, value FROM platform_settings"))
    check("platform secret sealed, non-secret plain", raw["voice.auth_token"].startswith("ofv1:")
          and raw["voice.account_sid"] == "AC1")
    PS.invalidate_cache()
    check("platform readers unseal", PS.get_group("voice")["auth_token"] == "tw-token"
          and PS.get_setting("voice.auth_token") == "tw-token")
    prov = client.get("/api/v1/admin/providers", headers=ADMIN).get_data(as_text=True)
    check("admin list never leaks ciphertext or secret", "ofv1" not in prov and "tw-token" not in prov)
    r = client.put("/api/v1/admin/providers", headers=ADMIN,
                   json={"group": "voice", "values": {"auth_token": ""}})
    check("blank keeps sealed secret", "auth_token" in (r.get_json() or {}).get("kept_blank", []))

    # -- 3. migrate legacy plain rows under key A --------------------------
    rep = client.get("/api/v1/admin/security/vault", headers=ADMIN).get_json()
    check("before migrate: legacy plain remain", rep["remaining"] >= 3, rep["totals"])
    m = client.post("/api/v1/admin/security/vault/migrate", headers=ADMIN).get_json()
    check("migrate resealed legacy", m["totals"]["resealed"] >= 3 and m["remaining"] == 0, m["totals"])
    raw = dict(sql("SELECT key, value FROM platform_settings"))
    check("legacy llm key now sealed", raw["llm.api_key"].startswith("ofv1:") and raw["llm.model"] == "m1")
    PS.invalidate_cache()
    check("llm_config still reads the key", PS.llm_config()["api_key"] == "sk-legacy-1")
    c = portal_db._conn()
    with c.cursor() as cur:
        check("legacy WATI readable after migrate", WA._load_settings(cur, 1)["api_token"] == "wati-legacy")
    c.close()
    if hook_ok:
        legacy_raw = sql("SELECT secret FROM portal_webhooks WHERE url = 'https://example.com/hook'")[0][0]
        check("legacy webhook still signs identically", legacy_raw.startswith("ofv1:")
              and WH._sign(legacy_raw, "x") == hmac.new(legacy_hook_secret.encode(), b"x", hashlib.sha256).hexdigest())
    m2 = client.post("/api/v1/admin/security/vault/migrate", headers=ADMIN).get_json()
    check("second migrate is a no-op", m2["totals"]["resealed"] == 0 and m2["remaining"] == 0)
    audit = sql("SELECT note FROM portal_action_log WHERE action = 'security.vault_migrated' ORDER BY id")
    check("migration audited without values", audit and "resealed=" in audit[0][0]
          and "sk-legacy" not in str(audit))

    # -- 4. rotation A -> B -------------------------------------------------
    set_keys(KEY_B, KEY_A)
    rep = client.get("/api/v1/admin/security/vault", headers=ADMIN).get_json()
    check("rotation: old-key rows counted", rep["totals"]["old_key"] >= 10 and rep["totals"]["unreadable"] == 0,
          rep["totals"])
    m = client.post("/api/v1/admin/security/vault/migrate", headers=ADMIN).get_json()
    check("rotation: all re-sealed under B", m["remaining"] == 0 and m["totals"]["old_key"] == 0)
    set_keys(KEY_B)
    PS.invalidate_cache()
    c = portal_db._conn()
    with c.cursor() as cur:
        check("after rotation, old key removed: all readable",
              IG._load_settings(cur, 1)["access_token"] == "EAAG-ig-token"
              and CO._load_settings(cur, 1)["api_password"] == "leo-pass"
              and PA._load_settings(cur, 1)["salt"] == "jc-salt"
              and PS.get_group("llm")["api_key"] == "sk-legacy-1")
    c.close()

    # -- 5. key lost: integrations read as not configured, never ciphertext
    set_keys(KEY_C)
    PS.invalidate_cache()
    c = portal_db._conn()
    with c.cursor() as cur:
        lost = IG._load_settings(cur, 1)
    c.close()
    check("lost key: token reads empty (not ciphertext)", lost["access_token"] == "")
    check("lost key: llm not enabled", PS.llm_config()["enabled"] is False)
    rep = client.get("/api/v1/admin/security/vault", headers=ADMIN).get_json()
    check("lost key: unreadable counted", rep["totals"]["unreadable"] >= 10)
    m = client.post("/api/v1/admin/security/vault/migrate", headers=ADMIN).get_json()
    before = sql("SELECT access_token FROM portal_instagram_accounts")[0][0]
    check("lost key: migrate never touches unreadable", m["totals"]["resealed"] == 0
          and before.startswith("ofv1:"))
    set_keys(KEY_B)
    PS.invalidate_cache()
    c = portal_db._conn()
    with c.cursor() as cur:
        check("key restored: data intact", IG._load_settings(cur, 1)["access_token"] == "EAAG-ig-token")
    c.close()

    # a broken area is reported (no stale counts) and never blocks the others
    sql("CREATE TABLE portal_vault_broken (id INT PRIMARY KEY)", fetch=False)
    saved_fields = V.TABLE_FIELDS
    V.TABLE_FIELDS = tuple(saved_fields) + (("Broken area", "portal_vault_broken", ("id",), ("missing_col",)),)
    try:
        c = portal_db._conn()
        with c.cursor() as cur:
            rep = V.scan(cur, migrate=True)
        c.rollback()
        c.close()
    finally:
        V.TABLE_FIELDS = saved_fields
    broken = [a for a in rep["areas"] if a["table"] == "portal_vault_broken"][0]
    others = [a for a in rep["areas"] if a["present"] and a["table"] != "portal_vault_broken"]
    check("broken area flagged with zero counts",
          broken["error"] != "" and broken["plain"] == broken["sealed"] == broken["resealed"] == 0, broken)
    check("other areas still scanned after a broken one",
          sum(a["sealed"] for a in others) > 0 and all(a["error"] == "" for a in others), others)

    for stub in stubs:
        stub.restore()
    try:
        server.cleanup()
    except Exception:
        pass
    shutil.rmtree(data_dir, ignore_errors=True)

set_keys()
summary("vault")
