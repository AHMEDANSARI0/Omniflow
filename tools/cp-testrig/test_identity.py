"""Customer Identity engine (MASTER-UPGRADE engine 1): normalisation
tables, resolve/merge/split/handles/duplicates on a scripted DB, the
owner API (auth + status codes), legacy import + read-model sync, and the
web wiring pins (BFF routes, portal.ts client, profile card, duplicates
panel, English copy)."""
import os

from flask import Flask

import portal_identity
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)

IDENT_A = {"id": 5, "client_id": 1, "display_name": "Ali Khan",
           "primary_contact_id": "923001234567@s.whatsapp.net",
           "status": "active", "merged_into": None, "created_at": None,
           "updated_at": None}
IDENT_B = {"id": 8, "client_id": 1, "display_name": "",
           "primary_contact_id": "03001234567", "status": "active",
           "merged_into": None, "created_at": None, "updated_at": None}
MERGED_B = dict(IDENT_B, status="merged", merged_into=5)


def handle(hid, identity_id, channel, value, raw=None, source="system"):
    return {"id": hid, "identity_id": identity_id, "channel": channel,
            "handle": value, "raw_handle": raw if raw is not None else value,
            "confidence": 1, "source": source, "created_at": None}


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def fresh(script, migrated=True):
    portal_identity._DDL_READY = True
    if migrated:
        portal_identity._MIGRATED.add(1)
    else:
        portal_identity._MIGRATED.discard(1)
    return install_db_stub(portal_identity, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL,
            migrated=True):
    fresh(script, migrated=migrated)
    app = Flask("identity-test")
    app.register_blueprint(portal_identity.bp)
    with PrincipalStub(portal_identity, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "DELETE":
            return client.delete(path)
    return None


def sqls(conn):
    return [e[0] for e in conn.cur.executed]


# ---------- normalisation (pure) ----------

print("== normalisation ==")
PHONES = (
    ("923001234567@s.whatsapp.net", "923001234567"),
    ("923001234567:12@s.whatsapp.net", "923001234567"),
    ("92300@c.us", ""),
    ("+92 300 1234567", "923001234567"),
    ("03001234567", "923001234567"),
    ("0300-1234567", "923001234567"),
    ("0092 300 1234567", "923001234567"),
    ("+1 (415) 555-2671", "14155552671"),
    ("120363001@g.us", ""),
    ("1234567890@lid", ""),
    ("abc", ""),
    ("12345", ""),
    ("", ""),
    (None, ""),
)
for raw, want in PHONES:
    check("phone " + repr(raw) + " -> " + repr(want),
          portal_identity.normalize_phone(raw) == want,
          portal_identity.normalize_phone(raw))
check("default country code from env (digits only)",
      portal_identity.DEFAULT_COUNTRY_CODE.isdigit(),
      portal_identity.DEFAULT_COUNTRY_CODE)
check("phone with explicit country code override",
      portal_identity.normalize_phone("0415 555 2671", "61") == "614155552671",
      portal_identity.normalize_phone("0415 555 2671", "61"))

HANDLES = (
    (("whatsapp", "923001234567@s.whatsapp.net"), ("whatsapp", "923001234567")),
    (("wa", "03001234567"), ("whatsapp", "923001234567")),
    (("whatsapp", "1234567890@lid"), ("whatsapp", "lid:1234567890")),
    (("phone", "+92-300-1234567"), ("phone", "923001234567")),
    (("email", " Mailto:Ali.Khan@Example.COM "), ("email", "ali.khan@example.com")),
    (("email", "not-an-email"), ("", "")),
    (("instagram", "https://www.instagram.com/@Ali.Khan_1/?hl=en"),
     ("instagram", "ali.khan_1")),
    (("instagram", "@ali khan"), ("", "")),
    (("facebook", "fb.com/ali.khan"), ("facebook", "ali.khan")),
    (("tiktok", "@Ali_K"), ("tiktok", "ali_k")),
    (("web", "  Visitor   ABC-123 "), ("web", "visitor abc-123")),
    (("other", "loyalty 778"), ("other", "loyalty 778")),
    (("pigeon", "x"), ("", "")),
    (("email", "x" * 201), ("", "")),
)
for (channel, raw), want in HANDLES:
    got = portal_identity.normalize_handle(channel, raw)
    check("handle " + channel + " " + repr(raw)[:40], got == want, got)

check("name needs two words + 5 chars",
      portal_identity.normalize_name("  ALI   KHAN!! ") == "ali khan"
      and portal_identity.normalize_name("Ali") == ""
      and portal_identity.normalize_name("A B") == "", "-")
check("channel vocab + owner channels exclude whatsapp",
      "whatsapp" in portal_identity.CHANNELS
      and "whatsapp" not in portal_identity.OWNER_CHANNELS
      and set(portal_identity.OWNER_CHANNELS) <= set(portal_identity.CHANNELS),
      portal_identity.OWNER_CHANNELS)

# ---------- resolve ----------

print("== resolve ==")
conn = fresh([[IDENT_A]])
got = portal_identity.resolve(conn.cur, 1, "whatsapp",
                              "923001234567@s.whatsapp.net")
check("resolve hits the handle join with the normalised digits",
      got["id"] == 5 and conn.cur.executed[0][1] == (1, "whatsapp",
                                                     "923001234567")
      and "JOIN" in sqls(conn)[0], conn.cur.executed[0])

conn = fresh([[MERGED_B], [IDENT_A]])
got = portal_identity.resolve(conn.cur, 1, "whatsapp", "03001234567")
check("resolve follows merged_into to the survivor", got["id"] == 5
      and conn.cur.executed[1][1] == (5, 1), conn.cur.executed[1])

conn = fresh([[], [IDENT_A], [{"id": 44}]])
got = portal_identity.resolve(conn.cur, 1, "whatsapp", "03001234567")
check("whatsapp id falls back to the phone alias and attaches itself",
      got["id"] == 5 and conn.cur.executed[1][1] == (1, "phone", "923001234567")
      and conn.cur.executed[2][1][:4] == (1, 5, "whatsapp", "923001234567"),
      conn.cur.executed[2])

conn = fresh([[], [], [{"id": 9, "client_id": 1, "display_name": "Sara",
                        "primary_contact_id": "923009999999",
                        "status": "active", "merged_into": None,
                        "created_at": None, "updated_at": None}],
              [{"id": 1}], [{"id": 2}]])
got = portal_identity.resolve(conn.cur, 1, "whatsapp", "923009999999",
                              display_name="  Sara  ")
check("unknown whatsapp id -> new identity + whatsapp handle + phone alias",
      got["id"] == 9 and "INSERT INTO portal_identities" in sqls(conn)[2]
      and conn.cur.executed[2][1] == (1, "Sara", "923009999999")
      and conn.cur.executed[3][1][2:4] == ("whatsapp", "923009999999")
      and conn.cur.executed[4][1][2:4] == ("phone", "923009999999")
      and "ON CONFLICT (client_id, channel, handle) DO NOTHING"
      in sqls(conn)[3], conn.cur.executed)

conn = fresh([[], []])
check("resolve create=False never inserts",
      portal_identity.resolve(conn.cur, 1, "whatsapp", "923009999999",
                              create=False) is None
      and len(conn.cur.executed) == 2, len(conn.cur.executed))
check("resolve rejects junk without touching the DB",
      portal_identity.resolve(fresh([]).cur, 1, "whatsapp", "abc") is None
      and portal_identity.resolve(fresh([]).cur, 1, "carrier", "x") is None, "-")

conn = fresh([[IDENT_A], [handle(1, 5, "whatsapp", "923001234567",
                                 "923001234567@s.whatsapp.net"),
                          handle(2, 5, "phone", "923001234567",
                                 "923001234567@s.whatsapp.net"),
                          handle(3, 5, "whatsapp", "923005555555"),
                          handle(4, 5, "email", "ali@example.com")]])
check("linked_contact_ids = other whatsapp raw ids only",
      portal_identity.linked_contact_ids(conn.cur, 1,
                                         "923001234567@s.whatsapp.net")
      == ["923005555555"], "-")
conn = fresh([[], []])
check("linked_contact_ids unknown contact -> [] (read only)",
      portal_identity.linked_contact_ids(conn.cur, 1, "923007777777") == []
      and len(conn.cur.executed) == 2, len(conn.cur.executed))

# ---------- merge / split ----------

print("== merge ==")
KEEP_HANDLES = [handle(1, 5, "whatsapp", "923001234567",
                       "923001234567@s.whatsapp.net"),
                handle(2, 5, "phone", "923001234567",
                       "923001234567@s.whatsapp.net"),
                handle(3, 5, "whatsapp", "923001234567", "03001234567")]
conn = fresh([[IDENT_A], [IDENT_B], [], [], [], KEEP_HANDLES, [], []])
got = portal_identity.merge(conn.cur, 1, "923001234567@s.whatsapp.net",
                            "03001234567", actor_user_id=11)
ex = conn.cur.executed
check("merge moves handles onto the kept identity",
      "SET identity_id = %s" in ex[2][0] and ex[2][1] == (5, 1, 8), ex[2])
check("merge marks the other identity merged (kept for history)",
      "status = 'merged', merged_into = %s" in ex[3][0]
      and ex[3][1] == (5, 8, 1), ex[3])
check("merge fills a blank display name from the merged identity",
      "display_name = CASE WHEN display_name = ''" in ex[4][0], ex[4][0][:80])
check("merge syncs the legacy read model (portal_contact_identities)",
      "portal_contact_identities" in ex[6][0]
      and ex[6][1] == (1, "923001234567@s.whatsapp.net", "idn:5",
                       1, "03001234567", "idn:5")
      and "ON CONFLICT (client_id, channel, contact_id)" in ex[6][0], ex[6])
check("merge audit identity.merged", ex[7][1][1] == "identity.merged"
      and ex[7][1][3] == 11 and "03001234567" in ex[7][1][5], ex[7][1])
check("merge returns the survivor with handles",
      got["id"] == 5 and len(got["handles"]) == 3, got.get("id"))

conn = fresh([[IDENT_A], [IDENT_A], KEEP_HANDLES, [], []])
got = portal_identity.merge(conn.cur, 1, "923001234567@s.whatsapp.net",
                            "03001234567")
check("merge of an already-linked pair is a no-op (no UPDATEs)",
      got["id"] == 5
      and not any(s.lstrip().startswith("UPDATE") for s in sqls(conn)),
      sqls(conn))

check("merge with junk contact -> None",
      portal_identity.merge(fresh([]).cur, 1, "abc", "03001234567") is None, "-")

print("== split ==")
conn = fresh([[IDENT_A], KEEP_HANDLES,
              [{"id": 21, "client_id": 1, "display_name": "",
                "primary_contact_id": "03001234567", "status": "active",
                "merged_into": None, "created_at": None, "updated_at": None}],
              [], [], [], [handle(3, 21, "whatsapp", "923001234567",
                                  "03001234567")]])
got = portal_identity.split(conn.cur, 1, "03001234567", actor_user_id=11)
ex = conn.cur.executed
check("split creates a fresh identity for the contact",
      "INSERT INTO portal_identities" in ex[2][0]
      and ex[2][1] == (1, "", "03001234567"), ex[2])
check("split moves the contact's whatsapp handle + phone alias",
      "id = ANY(%s)" in ex[3][0] and ex[3][1] == (21, 1, [3, 2]), ex[3])
check("split forgets the legacy row for that contact",
      "DELETE FROM portal_contact_identities" in ex[4][0]
      and ex[4][1] == (1, "03001234567"), ex[4])
check("split audit identity.split", ex[5][1][1] == "identity.split", ex[5][1])
check("split returns the new identity", got["id"] == 21
      and got["handles"][0]["identity_id"] == 21, got)

conn = fresh([[IDENT_A], [handle(1, 5, "whatsapp", "923001234567",
                                 "923001234567@s.whatsapp.net")]])
check("split of an unlinked contact -> None",
      portal_identity.split(conn.cur, 1, "923001234567@s.whatsapp.net")
      is None, "-")

# ---------- handles ----------

print("== handles ==")
conn = fresh([[IDENT_A], [], KEEP_HANDLES, [{"id": 31}], []])
status, result = portal_identity.add_handle(
    conn.cur, 1, "923001234567@s.whatsapp.net", "email", "Ali@Example.com",
    actor_user_id=11)
check("add_handle inserts the normalised alias",
      status == "ok" and result["handle"] == "ali@example.com"
      and result["id"] == 31 and conn.cur.executed[3][1][2:5]
      == ("email", "ali@example.com", "Ali@Example.com"), (status, result))
check("add_handle audit identity.handle_added",
      conn.cur.executed[4][1][1] == "identity.handle_added",
      conn.cur.executed[4][1])

conn = fresh([[IDENT_A], [IDENT_B]])
status, result = portal_identity.add_handle(
    conn.cur, 1, "923001234567@s.whatsapp.net", "email", "ali@example.com")
check("add_handle never steals another person's handle -> conflict",
      status == "conflict" and result == "03001234567", (status, result))

conn = fresh([[IDENT_A], [IDENT_A], KEEP_HANDLES
              + [handle(4, 5, "email", "ali@example.com")]])
status, result = portal_identity.add_handle(
    conn.cur, 1, "923001234567@s.whatsapp.net", "email", "ALI@example.com")
check("add_handle of an existing alias is idempotent",
      status == "ok" and result["id"] == 4, (status, result))

check("add_handle rejects whatsapp channel + junk",
      portal_identity.add_handle(fresh([]).cur, 1, "x", "whatsapp",
                                 "923001111111")[0] == "invalid"
      and portal_identity.add_handle(fresh([]).cur, 1, "x", "email",
                                     "nope")[0] == "invalid", "-")

many = [handle(100 + i, 5, "other", "h" + str(i)) for i in range(
    portal_identity.MAX_HANDLES)]
conn = fresh([[IDENT_A], [], many])
check("add_handle enforces the per-identity cap",
      portal_identity.add_handle(conn.cur, 1, "923001234567@s.whatsapp.net",
                                 "email", "new@example.com")[0] == "limit", "-")

conn = fresh([[{"id": 4, "channel": "email", "handle": "ali@example.com"}],
              [], []])
check("remove_handle deletes + audits",
      portal_identity.remove_handle(conn.cur, 1, 4, 11) == "ok"
      and "DELETE FROM portal_identity_handles" in sqls(conn)[1]
      and conn.cur.executed[2][1][1] == "identity.handle_removed", sqls(conn))
conn = fresh([[{"id": 1, "channel": "whatsapp", "handle": "923001234567"}]])
check("remove_handle protects whatsapp ids",
      portal_identity.remove_handle(conn.cur, 1, 1) == "protected", "-")
check("remove_handle 404", portal_identity.remove_handle(
    fresh([[]]).cur, 1, 99) == "not_found", "-")

conn = fresh([[], []])
portal_identity.dismiss(conn.cur, 1, "b-contact", "a-contact", 11)
check("dismiss stores the sorted pair + audits",
      conn.cur.executed[0][1] == (1, "a-contact", "b-contact")
      and "ON CONFLICT (client_id, contact_a, contact_b) DO NOTHING"
      in sqls(conn)[0]
      and conn.cur.executed[1][1][1] == "identity.dismissed", conn.cur.executed)

# ---------- duplicates ----------

print("== duplicates ==")
CONTACTS = [
    {"contact_id": "923001234567@s.whatsapp.net", "contact_name": "Ali Khan",
     "last_at": None},
    {"contact_id": "03001234567", "contact_name": "Ali K", "last_at": None},
    {"contact_id": "923005555555", "contact_name": "Ali Khan", "last_at": None},
    {"contact_id": "923006666666", "contact_name": "Sara Ahmed",
     "last_at": None},
    {"contact_id": "923007777777", "contact_name": "sara  ahmed",
     "last_at": None},
    {"contact_id": "923008888888", "contact_name": "Ali", "last_at": None},
]
conn = fresh([CONTACTS, [], []])
result = portal_identity.duplicates(conn.cur, 1, 50)
pairs = {(s["contact_a"], s["contact_b"]): s for s in result["suggestions"]}
check("duplicates scans contacts grouped by contact_id (scoped, capped)",
      "GROUP BY contact_id" in sqls(conn)[0]
      and conn.cur.executed[0][1] == (1, portal_identity.SCAN_MAX), sqls(conn)[0])
check("same phone behind two ids -> 0.95 same_phone",
      pairs.get(("923001234567@s.whatsapp.net", "03001234567"), {}).get("reason")
      == "same_phone"
      and pairs[("923001234567@s.whatsapp.net", "03001234567")]["confidence"]
      == 0.95, pairs.keys())
check("same two-word name -> 0.4 same_name (case/space insensitive)",
      pairs.get(("923006666666", "923007777777"), {}).get("reason")
      == "same_name"
      and pairs.get(("923001234567@s.whatsapp.net", "923005555555"), {})
      .get("reason") == "same_name", pairs.keys())
check("single first names never pair", not any(
    "923008888888" in p for p in pairs), pairs.keys())
check("strongest evidence first + counts",
      result["suggestions"][0]["reason"] == "same_phone"
      and result["scanned"] == 6 and result["total"] == 3
      and result["linked_identities"] == 0, result)

conn = fresh([CONTACTS,
              [handle(1, 5, "whatsapp", "923001234567",
                      "923001234567@s.whatsapp.net"),
               handle(3, 5, "whatsapp", "923001234567", "03001234567")],
              [{"contact_a": "923006666666", "contact_b": "923007777777"}]])
result = portal_identity.duplicates(conn.cur, 1, 50)
pairs = {(s["contact_a"], s["contact_b"]) for s in result["suggestions"]}
check("already-linked pair + dismissed pair are skipped",
      ("923001234567@s.whatsapp.net", "03001234567") not in pairs
      and ("923006666666", "923007777777") not in pairs
      and result["linked_identities"] == 1, pairs)

conn = fresh([CONTACTS, [], []])
result = portal_identity.duplicates(conn.cur, 1, 50, contact="923007777777")
check("contact filter keeps only that contact's hints",
      len(result["suggestions"]) == 1
      and result["suggestions"][0]["contact_b"] == "923007777777", result)
conn = fresh([CONTACTS, [], []])
check("limit clamps", len(portal_identity.duplicates(conn.cur, 1, 1)
                          ["suggestions"]) == 1, "-")

# ---------- legacy import ----------

print("== legacy import ==")
conn = fresh([[{"identity_key": "id:a-b", "contact_id": "a-contact"},
               {"identity_key": "id:a-b", "contact_id": "b-contact"},
               {"identity_key": "id:zz", "contact_id": "lonely"}],
              []], migrated=False)
# a-contact / b-contact are not phone numbers -> resolve() rejects them,
# merge returns None and the import simply moves on (fail-soft).
try:
    linked = portal_identity.migrate_legacy(conn.cur, 1)
    ok = True
except Exception as error:  # pragma: no cover
    ok = False
    linked = error
check("legacy import skips unusable ids without raising", ok and linked == 0,
      linked)
check("legacy import re-keys stale single rows",
      any("SET identity_key = %s" in s for s in sqls(conn)), sqls(conn))
check("legacy import runs once per workspace per process",
      portal_identity.migrate_legacy(fresh([], migrated=True).cur, 1) == 0, "-")

conn = fresh([[{"identity_key": "id:x", "contact_id": "923001234567@s.whatsapp.net"},
               {"identity_key": "id:x", "contact_id": "03001234567"}],
              [IDENT_A], [IDENT_B], [], [], [], KEEP_HANDLES, []],
             migrated=False)
linked = portal_identity.migrate_legacy(conn.cur, 1)
check("legacy pair becomes one identity (merge source=legacy, no audit)",
      linked == 1 and "portal_contact_identities" in sqls(conn)[-1]
      and not any("portal_action_log" in s for s in sqls(conn)), sqls(conn)[-1])

conn = fresh([[], [], []], migrated=False)
portal_identity._import_legacy_guarded(conn.cur, 1)
check("guarded import wraps the legacy import in a savepoint",
      sqls(conn)[0] == "SAVEPOINT idn_legacy"
      and sqls(conn)[-1] == "RELEASE SAVEPOINT idn_legacy", sqls(conn))
conn = fresh([[], Exception("boom"), []], migrated=False)
portal_identity._import_legacy_guarded(conn.cur, 1)
check("guarded import rolls back to the savepoint on failure (fail-soft)",
      sqls(conn)[-1] == "ROLLBACK TO SAVEPOINT idn_legacy"
      and 1 in portal_identity._MIGRATED, sqls(conn))
conn = fresh([], migrated=True)
portal_identity._import_legacy_guarded(conn.cur, 1)
check("guarded import is a no-op once done", conn.cur.executed == [], "-")

# ---------- API ----------

print("== api ==")
r = run_api([], "GET", "/api/v1/portal/identity")
check("GET identity 400 without contact", r.status_code == 400, r.status_code)
r = run_api([[IDENT_A], KEEP_HANDLES, [{"contact_id": "03001234567",
                                        "contact_name": "Ali K"}],
             CONTACTS, [handle(1, 5, "whatsapp", "923001234567",
                               "923001234567@s.whatsapp.net"),
                        handle(3, 5, "whatsapp", "923001234567",
                               "03001234567")], []],
            "GET", "/api/v1/portal/identity?contact=923001234567@s.whatsapp.net")
body = r.get_json()
check("GET identity 200 card", r.status_code == 200
      and body["identity"]["id"] == 5
      and body["identity"]["contacts"] == ["923001234567@s.whatsapp.net",
                                           "03001234567"]
      and body["identity"]["linked"] == [{"contact_id": "03001234567",
                                          "name": "Ali K"}]
      and len(body["identity"]["handles"]) == 3
      and body["channels"] == list(portal_identity.OWNER_CHANNELS)
      and body["limits"]["max_handles"] == portal_identity.MAX_HANDLES, body)
check("GET identity includes only this contact's duplicate hints",
      [s["reason"] for s in body["suggestions"]] == ["same_name"]
      and body["suggestions"][0]["contact_b"] == "923005555555",
      body["suggestions"])
r = run_api([], "GET", "/api/v1/portal/identity?contact=abc")
check("GET identity 400 for junk contact", r.status_code == 400, r.status_code)

r = run_api([[IDENT_A], [], KEEP_HANDLES, [{"id": 31}], []], "POST",
            "/api/v1/portal/identity/handles",
            {"contact": "923001234567@s.whatsapp.net", "channel": "email",
             "handle": "Ali@Example.com"})
check("POST handle 200", r.status_code == 200
      and r.get_json()["handle"]["handle"] == "ali@example.com", r.get_json())
r = run_api([[IDENT_A], [IDENT_B]], "POST", "/api/v1/portal/identity/handles",
            {"contact": "923001234567@s.whatsapp.net", "channel": "email",
             "handle": "ali@example.com"})
check("POST handle 409 identity_conflict with the other contact",
      r.status_code == 409
      and r.get_json()["error"]["code"] == "identity_conflict"
      and r.get_json()["other_contact"] == "03001234567", r.get_json())
r = run_api([], "POST", "/api/v1/portal/identity/handles",
            {"contact": "x", "channel": "whatsapp", "handle": "1"})
check("POST handle 400 whatsapp channel not addable", r.status_code == 400,
      r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/handles", {"contact": "x"})
check("POST handle 400 missing fields", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/handles",
            {"contact": "x", "channel": "email", "handle": "a@b.co"},
            principal=API_KEY_PRINCIPAL)
check("POST handle 403 for API keys", r.status_code == 403, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/handles",
            {"contact": "x", "channel": "email", "handle": "a@b.co"},
            principal=None)
check("POST handle 401 signed out", r.status_code == 401, r.status_code)

r = run_api([[{"id": 4, "channel": "email", "handle": "a@b.co"}], [], []],
            "DELETE", "/api/v1/portal/identity/handles/4")
check("DELETE handle 200", r.status_code == 200, r.status_code)
r = run_api([[]], "DELETE", "/api/v1/portal/identity/handles/99")
check("DELETE handle 404", r.status_code == 404, r.status_code)
r = run_api([[{"id": 1, "channel": "whatsapp", "handle": "1"}]], "DELETE",
            "/api/v1/portal/identity/handles/1")
check("DELETE whatsapp handle 400 (use split)", r.status_code == 400,
      r.status_code)

r = run_api([[IDENT_A], [IDENT_B], [], [], [], KEEP_HANDLES, [], []], "POST",
            "/api/v1/portal/identity/merge",
            {"keep": "923001234567@s.whatsapp.net", "merge": "03001234567"})
check("POST merge 200 returns the survivor", r.status_code == 200
      and r.get_json()["identity"]["id"] == 5
      and len(r.get_json()["identity"]["handles"]) == 3, r.get_json())
r = run_api([], "POST", "/api/v1/portal/identity/merge",
            {"keep": "a", "merge": "a"})
check("POST merge 400 same", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/merge", {"keep": "a"})
check("POST merge 400 blank", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/merge",
            {"keep": "abc", "merge": "def"})
check("POST merge 400 unusable ids", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/merge",
            {"keep": "a", "merge": "b"}, principal=API_KEY_PRINCIPAL)
check("POST merge 403 API key", r.status_code == 403, r.status_code)

r = run_api([[IDENT_A], KEEP_HANDLES,
             [{"id": 21, "client_id": 1, "display_name": "",
               "primary_contact_id": "03001234567", "status": "active",
               "merged_into": None, "created_at": None, "updated_at": None}],
             [], [], [], [handle(3, 21, "whatsapp", "923001234567",
                                 "03001234567")]],
            "POST", "/api/v1/portal/identity/split", {"contact": "03001234567"})
check("POST split 200", r.status_code == 200
      and r.get_json()["identity"]["id"] == 21, r.get_json())
r = run_api([[IDENT_A], [handle(1, 5, "whatsapp", "923001234567",
                                "923001234567@s.whatsapp.net")]],
            "POST", "/api/v1/portal/identity/split",
            {"contact": "923001234567@s.whatsapp.net"})
check("POST split 404 when not linked", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/split", {})
check("POST split 400", r.status_code == 400, r.status_code)

r = run_api([CONTACTS, [], []], "GET",
            "/api/v1/portal/identity/duplicates?limit=2")
body = r.get_json()
check("GET duplicates 200 (limit honoured, counts present)",
      r.status_code == 200 and len(body["suggestions"]) == 2
      and body["scanned"] == 6 and body["total"] == 3, body)
r = run_api([CONTACTS, [], []], "GET",
            "/api/v1/portal/identity/duplicates?limit=abc",
            principal=API_KEY_PRINCIPAL)
check("GET duplicates readable by API keys, bad limit -> default",
      r.status_code == 200, r.status_code)
r = run_api([], "GET", "/api/v1/portal/identity/duplicates", principal=None)
check("GET duplicates 401", r.status_code == 401, r.status_code)

r = run_api([[], []], "POST", "/api/v1/portal/identity/dismiss",
            {"contact_a": "b", "contact_b": "a"})
check("POST dismiss 200", r.status_code == 200, r.status_code)
r = run_api([], "POST", "/api/v1/portal/identity/dismiss",
            {"contact_a": "a", "contact_b": "a"})
check("POST dismiss 400 same", r.status_code == 400, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
SMOKE = "/tmp/smoke971/"
RIG13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


APP = read(SMOKE + "app.py")
check("blueprint registered", "from portal_identity import bp as"
      " portal_identity_bp" in APP
      and "aux_app.register_blueprint(portal_identity_bp)" in APP, "-")
SRC = read(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "..", "omniflow-backend-patch", "portal_identity.py"))
check("engine keeps the legacy read model in sync (profile linked_channels)",
      "_legacy_sync" in SRC and "portal_contact_identities" in SRC
      and "def migrate_legacy" in SRC, "-")
check("engine never moves conversations (safe merge is reversible)",
      "portal_db.CONV_TABLE" in SRC
      and "UPDATE \" + portal_db._q(portal_db.CONV_TABLE)" not in SRC, "-")
check("all writes audited", all(a in SRC for a in (
    '"identity.merged"', '"identity.split"', '"identity.handle_added"',
    '"identity.handle_removed"', '"identity.dismissed"')), "-")
check("writes human-only, reads any principal",
      SRC.count("= _human_or_error()") == 5
      and SRC.count("= _principal_or_error()") == 3,
      SRC.count("= _principal_or_error()"))
check("no hardcoded country code / limits", "OF_DEFAULT_COUNTRY_CODE" in SRC
      and "OF_IDENTITY_HANDLES_MAX" in SRC and "OF_IDENTITY_SCAN_MAX" in SRC,
      "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts identity client", all(t in LIB for t in (
    "export interface CustomerIdentity", "export interface IdentityHandle",
    "export interface IdentitySuggestion",
    "export async function getCustomerIdentity",
    "export async function addIdentityHandle",
    "export async function removeIdentityHandle",
    "export async function mergeIdentity",
    "export async function splitIdentity",
    "export async function listIdentityDuplicates",
    "export async function dismissIdentityPair")), "-")
check("portal.ts identity paths", all(t in LIB for t in (
    "api/v1/portal/identity?contact=", "api/v1/portal/identity/handles",
    "api/v1/portal/identity/merge", "api/v1/portal/identity/split",
    "api/v1/portal/identity/duplicates", "api/v1/portal/identity/dismiss")),
      "-")
BFF = "app/api/omniflow/portal/identity/"
for rel, tokens in (
        ("route.ts", ("getCustomerIdentity", "export async function GET")),
        ("handles/route.ts", ("addIdentityHandle", "export async function POST",
                              "409")),
        ("handles/[id]/route.ts", ("removeIdentityHandle",
                                   "export async function DELETE",
                                   "params: Promise<{ id: string }>")),
        ("merge/route.ts", ("mergeIdentity", "export async function POST")),
        ("split/route.ts", ("splitIdentity", "export async function POST")),
        ("duplicates/route.ts", ("listIdentityDuplicates",
                                 "export async function GET")),
        ("dismiss/route.ts", ("dismissIdentityPair",
                              "export async function POST"))):
    src = read(RIG13 + BFF + rel)
    check("BFF " + rel, bool(src) and all(t in src for t in tokens)
          and "requirePortalAccessToken" in src, rel)
    depth = rel.count("/") + 5
    check("BFF depth " + rel, ('"' + "../" * depth + "lib/omniflow/portal"
                               + '"') in src, depth)

CARD = read(RIG13 + "app/dashboard/(portal)/customers/profile/"
            "CustomerIdentityCard.tsx")
PANEL = read(RIG13 + "app/dashboard/(portal)/customers/DuplicatesPanel.tsx")
PROFILE = read(RIG13 + "app/dashboard/(portal)/customers/profile/"
               "ProfileClient.tsx")
CUSTOMERS = read(RIG13 + "app/dashboard/(portal)/customers/CustomersClient.tsx")
check("Identity card: handles + add form + link/unlink + hints", all(
    t in CARD for t in ("/api/omniflow/portal/identity", "identity/handles",
                        "identity/merge", "identity/split", "identity/dismiss",
                        "Not the same person", "Unlink", "confidence")), "-")
check("Identity card surfaces the 409 conflict as a link offer",
      "other_contact" in CARD and "identity_conflict" in CARD, "-")
check("Duplicates panel: workspace review with link / dismiss",
      all(t in PANEL for t in ("identity/duplicates",
                               '"/api/omniflow/portal/identity/" + path',
                               '"merge" | "dismiss"', "same_phone",
                               "same_name", "Not the same",
                               "Link as same person")), "-")
check("profile mounts the card + customers mounts the panel",
      "CustomerIdentityCard" in PROFILE and "DuplicatesPanel" in CUSTOMERS, "-")
UI = CARD + PANEL
check("identity UI: English copy", "karein" not in UI and "nahi" not in UI
      and "hai" not in UI.replace("hair", "").replace("chain", ""), "-")
check("identity UI: no emoji-capable glyphs", all(
    code not in UI for code in ("\\u25b6", "\\u261d", "\\u2714", "\\u26a1",
                                "\\u2699", "\\u2709", "\\u260e", "\\u2733",
                                "\\u263a", "\\u27a1")), "-")

raise SystemExit(1 if summary("identity") else 0)
