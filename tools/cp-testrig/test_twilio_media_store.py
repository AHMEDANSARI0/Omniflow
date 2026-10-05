"""§214: Twilio number setup from the panel + customer media store.

Covers:
  * media store settings (defaults, clamping, validation, JSON strings);
  * magic-byte sniffing (images / audio only; SVG / HTML never served);
  * capture: Telegram inline bytes, Instagram links (download + reuse of
    bytes media understanding already fetched), copies off, too large,
    unsupported, video = link only, download failure, SSRF, budget,
    platform off, outbound, max per message, savepoint rollback;
  * bounds (retention + quota, oldest first) and usage;
  * Instagram fresh-link parsing (image / video / file / payload, http
    refused, event ids skipped, API errors fail soft);
  * owner API (tenant scope, content: copy / link / refresh / 410, safe
    headers, link route, human-only delete + audit, settings GET/PUT);
  * wiring: connector capture after the message row, _media_fetched never
    leaks, tick retention sweep, Memory purge forgets files, app.py;
  * Twilio: webhook base order (env > panel > request), clean_webhook_base,
    number states (connected / partial / elsewhere / app / trunk /
    not_set), REST call shape (Basic auth, form body, Twilio error text),
    admin list + confirmed connect (refuses app / trunk, needs a base,
    audited), signature candidates + TwiML action base;
  * website: BFF routes, safe content proxy, MediaCard, storage section,
    Twilio section, webhook_base field.
"""
import base64
import io
import json
import os
import urllib.error

from flask import Flask

import test_lib
from test_lib import (FakeCur, PrincipalStub, check, human_principal,
                      install_db_stub, summary)

import platform_settings
import portal_inbound_media as im

RIG = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BACKEND = os.path.join(RIG, "omniflow-backend-patch")


def src(rel):
    with open(os.path.join(RIG, rel), encoding="utf8") as handle:
        return handle.read()


def bsrc(name):
    with open(os.path.join(BACKEND, name), encoding="utf8") as handle:
        return handle.read()


def raw(value):
    """psycopg2.Binary -> bytes (or the value itself)."""
    return getattr(value, "adapted", value)


JPEG = b"\xff\xd8\xff\xe0" + b"j" * 200
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 50
OGG = b"OggS" + b"o" * 120
SVG = b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>"

im._DDL_READY = True
im._CS_READY = True
os.environ.pop("OF_MEDIA_STORE_MODE", None)

print("== settings ==")
check("defaults", im.default_settings() == {
    "keep_copies": True, "retention_days": 30, "quota_mb": 50},
    im.default_settings())
check("clamped + bad types ignored", im.clean_settings(
    {"keep_copies": "yes", "retention_days": 9999, "quota_mb": 5}) == {
    "keep_copies": True, "retention_days": im.MAX_RETENTION_DAYS,
    "quota_mb": 10}, im.clean_settings({"retention_days": 9999}))
check("json string accepted", im.clean_settings(
    json.dumps({"keep_copies": False, "quota_mb": 20}))["quota_mb"] == 20
    and im.clean_settings(json.dumps({"keep_copies": False}))
    ["keep_copies"] is False, "json")
check("garbage -> defaults", im.clean_settings("{nope") ==
      im.default_settings() and im.clean_settings(None) ==
      im.default_settings(), "garbage")
cur_settings = im.default_settings()
for bad, why in (({"keep_copies": "no"}, "bool"),
                 ({"retention_days": 0}, "low"),
                 ({"retention_days": im.MAX_RETENTION_DAYS + 1}, "high"),
                 ({"quota_mb": 9}, "quota low"),
                 ({"quota_mb": True}, "bool as int"),
                 ({"quota_mb": 20.5}, "float"),
                 ("x", "not object")):
    merged, problem = im.validate_update(bad, cur_settings)
    check("validate rejects " + why, merged is None and problem, problem)
merged, problem = im.validate_update({"retention_days": 7, "quota_mb": 100},
                                     cur_settings)
check("validate merges", merged == {"keep_copies": True,
                                    "retention_days": 7, "quota_mb": 100}
      and problem == "", merged)
check("limits exposed", set(im.limits()) == {
    "mode", "max_file_bytes", "max_quota_mb", "max_retention_days"}
    and im.limits()["max_file_bytes"] <= 4400 * 1000, im.limits())

print("== sniffing: bytes decide ==")
check("jpeg", im.sniff("image", JPEG) == "image/jpeg", "jpeg")
check("png", im.sniff("image", PNG) == "image/png", "png")
check("webp", im.sniff("image", b"RIFF\x00\x00\x00\x00WEBPVP8 ") ==
      "image/webp", "webp")
check("gif", im.sniff("image", b"GIF89a....") == "image/gif", "gif")
check("svg never an image", im.sniff("image", SVG) == "", "svg")
check("html never an image", im.sniff("image", b"<html>") == "", "html")
check("ogg", im.sniff("audio", OGG) == "audio/ogg", "ogg")
check("mp3 id3", im.sniff("audio", b"ID3\x03....") == "audio/mpeg", "id3")
check("mp3 frame", im.sniff("audio", b"\xff\xfb\x90\x00") == "audio/mpeg",
      "frame")
check("m4a", im.sniff("audio", b"\x00\x00\x00\x20ftypM4A ") ==
      "audio/mp4", "m4a")
check("wav", im.sniff("audio", b"RIFF\x00\x00\x00\x00WAVEfmt ") ==
      "audio/wav", "wav")
check("webm", im.sniff("audio", b"\x1a\x45\xdf\xa3....") == "audio/webm",
      "webm")
check("amr", im.sniff("audio", b"#!AMR\n") == "audio/amr", "amr")
check("jpeg is not audio", im.sniff("audio", JPEG) == "", "cross")
check("video never sniffed", im.sniff("video", JPEG) == "", "video")
check("empty", im.sniff("image", b"") == "", "empty")
for entry, want in (({"type": "image"}, "image"), ({"type": "audio"}, "audio"),
                    ({"type": "voice"}, "audio"), ({"type": "video"}, "video"),
                    ({"type": "ig_reel"}, "video"),
                    ({"mime": "video/mp4"}, "video"),
                    ({"type": "file"}, "file"), ({"type": "share"}, "file")):
    check("classify " + json.dumps(entry), im.classify(entry) == want,
          im.classify(entry))

print("== capture ==")


def settings_row(value=None):
    return [{"media_store": None if value is None else json.dumps(value)}]


def ig_item(media, mid="m_1", direction="in"):
    return {"channel": "instagram", "from": "ig:555", "id": mid,
            "direction": direction, "media": media}


def inserts(cur):
    return [e for e in cur.executed if str(e[0]).startswith(
        "INSERT INTO portal_inbound_media")]


# Telegram: inline bytes
cur = FakeCur([[], settings_row(), [], [], [{"used": 100}], []])
item = {"channel": "telegram", "from": "tg:9", "id": "tg-77",
        "direction": "in", "media": [{"type": "image", "mime": "image/jpeg"}]}
stored = im.capture(cur, 7, 55, item, [JPEG])
ins = inserts(cur)
check("telegram bytes stored", stored == 1 and len(ins) == 1, cur.executed)
p = ins[0][1] if ins else ()
check("insert fields (tenant, conversation, ref, sniffed mime)",
      p[:9] == (7, 55, "telegram", "tg:9", "tg-77", 0, "image",
                "image/jpeg", len(JPEG))
      and raw(p[10]) == JPEG and p[11] == "stored" and p[13] is True, p)
check("savepoint wraps capture", cur.executed[0][0] ==
      "SAVEPOINT of_inbound_media" and cur.executed[-1][0] ==
      "RELEASE SAVEPOINT of_inbound_media", [e[0] for e in cur.executed])
check("idempotent per provider ref", "ON CONFLICT (client_id, channel,"
      " external_id, media_index)" in ins[0][0] and "DO NOTHING" in ins[0][0],
      "conflict")
check("bounds applied after a copy", any("make_interval" in str(e[0])
                                         for e in cur.executed), "bounds")

# Instagram: link downloaded for storage
calls = []


def fake_fetch(url, cap=0):
    calls.append(url)
    return OGG, "audio/ogg"


im.fetch = fake_fetch
cur = FakeCur([[], settings_row(), [], [], [{"used": 0}], []])
stored = im.capture(cur, 7, 56, ig_item(
    [{"type": "audio", "url": "https://cdn.fbsbx.com/v/a.ogg"}]), None)
p = inserts(cur)[0][1]
check("instagram link downloaded + stored", stored == 1 and calls ==
      ["https://cdn.fbsbx.com/v/a.ogg"] and p[7] == "audio/ogg"
      and p[9] == "https://cdn.fbsbx.com/v/a.ogg" and p[11] == "stored", p)

# bytes already fetched by media understanding are reused
calls.clear()
item = ig_item([{"type": "image", "url": "https://cdn.fbsbx.com/i.jpg"}])
item["_media_fetched"] = {0: (JPEG, "image/jpeg")}
cur = FakeCur([[], settings_row(), [], [], [{"used": 0}], []])
stored = im.capture(cur, 7, 56, item, None)
check("media-AI bytes reused (no second download)", stored == 1
      and calls == [] and raw(inserts(cur)[0][1][10]) == JPEG, calls)

# copies off -> reference only, no bounds work
cur = FakeCur([[], settings_row({"keep_copies": False}), [], []])
stored = im.capture(cur, 7, 56, ig_item(
    [{"type": "image", "url": "https://cdn.fbsbx.com/i.jpg"}]), None)
p = inserts(cur)[0][1]
check("copies off -> link row", stored == 0 and p[10] is None
      and p[11] == "link" and p[12] == "copies_off"
      and len(cur.executed) == 4, cur.executed)

# too large (inline)
_max = im.MAX_FILE_BYTES
im.MAX_FILE_BYTES = 100
cur = FakeCur([[], settings_row(), [], []])
item = {"channel": "telegram", "from": "tg:9", "id": "tg-78",
        "direction": "in", "media": [{"type": "image"}]}
stored = im.capture(cur, 7, 55, item, [JPEG])
p = inserts(cur)[0][1]
check("oversize inline -> too_large, no bytes", stored == 0
      and p[10] is None and p[11] == "too_large" and p[12] == "too_large",
      p)
im.MAX_FILE_BYTES = _max

# download says too large
im.fetch = lambda url, cap=0: (_ for _ in ()).throw(ValueError("too_large"))
cur = FakeCur([[], settings_row(), [], []])
im.capture(cur, 7, 56, ig_item(
    [{"type": "image", "url": "https://cdn.fbsbx.com/big.jpg"}]), None)
p = inserts(cur)[0][1]
check("oversize link -> too_large", p[11] == "too_large"
      and p[9] == "https://cdn.fbsbx.com/big.jpg", p)

# download failure keeps the link
im.fetch = lambda url, cap=0: (_ for _ in ()).throw(
    ValueError("media host answered HTTP 403"))
cur = FakeCur([[], settings_row(), [], []])
im.capture(cur, 7, 56, ig_item(
    [{"type": "audio", "url": "https://cdn.fbsbx.com/a.ogg"}]), None)
p = inserts(cur)[0][1]
check("download failure -> link + note", p[11] == "link"
      and p[12] == "download_failed", p)

# unsupported bytes (SVG claiming to be an image) are never kept
cur = FakeCur([[], settings_row(), [], []])
item = {"channel": "telegram", "from": "tg:9", "id": "tg-79",
        "direction": "in", "media": [{"type": "image"}]}
im.capture(cur, 7, 55, item, [SVG])
p = inserts(cur)[0][1]
check("svg not stored", p[10] is None and p[11] == "failed"
      and p[12] == "unsupported", p)

# video = link only (no download attempt)
calls.clear()
im.fetch = fake_fetch
cur = FakeCur([[], settings_row(), [], []])
im.capture(cur, 7, 56, ig_item(
    [{"type": "video", "url": "https://cdn.fbsbx.com/v.mp4"}]), None)
p = inserts(cur)[0][1]
check("video kept as link", calls == [] and p[6] == "video"
      and p[11] == "link" and p[10] is None, p)

# plain http links are ignored (no source)
cur = FakeCur([[], settings_row(), [], []])
im.capture(cur, 7, 56, ig_item(
    [{"type": "image", "url": "http://cdn.example.com/i.jpg"}]), None)
p = inserts(cur)[0][1]
check("http link refused", calls == [] and p[9] == "" and p[11] == "failed"
      and p[12] == "no_source", p)

# budget exhausted -> link only
cur = FakeCur([[], settings_row(), [], []])
im.capture(cur, 7, 56, ig_item(
    [{"type": "image", "url": "https://cdn.fbsbx.com/i.jpg"}]), None,
    im.Budget(0))
p = inserts(cur)[0][1]
check("budget exhausted -> no download", calls == [] and p[11] == "link", p)

# at most MAX_PER_MESSAGE rows per message
cur = FakeCur([[], settings_row()] + [[]] * im.MAX_PER_MESSAGE + [[]])
im.capture(cur, 7, 56, ig_item(
    [{"type": "video", "url": "https://cdn.fbsbx.com/v%d.mp4" % n}
     for n in range(7)]), None)
check("max per message", len(inserts(cur)) == im.MAX_PER_MESSAGE,
      len(inserts(cur)))

# platform off / outbound / no media -> no SQL at all
os.environ["OF_MEDIA_STORE_MODE"] = "off"
cur = FakeCur([])
check("platform off -> nothing", im.capture(cur, 7, 56, ig_item(
    [{"type": "image", "url": "https://x.example/i.jpg"}]), None) == 0
    and cur.executed == [], cur.executed)
os.environ.pop("OF_MEDIA_STORE_MODE")
cur = FakeCur([])
check("outbound -> nothing", im.capture(cur, 7, 56, ig_item(
    [{"type": "image"}], direction="out"), None) == 0
    and cur.executed == [], cur.executed)
check("no media -> nothing", im.capture(cur, 7, 56, {"direction": "in"},
                                        None) == 0 and cur.executed == [],
      "none")

# failure rolls back to the savepoint and never raises
cur = FakeCur([[], settings_row(), RuntimeError("disk full"), []])
item = {"channel": "telegram", "from": "tg:9", "id": "tg-80",
        "direction": "in", "media": [{"type": "image"}]}
try:
    result = im.capture(cur, 7, 55, item, [JPEG])
    raised = False
except Exception:
    raised, result = True, None
check("failure -> rollback to savepoint, 0, no raise", not raised
      and result == 0 and cur.executed[-1][0] ==
      "ROLLBACK TO SAVEPOINT of_inbound_media", cur.executed)

# real fetch(): SSRF guard refuses private hosts
import importlib

im_real = importlib.reload(im)
im = im_real
im._DDL_READY = True
im._CS_READY = True
for bad in ("https://127.0.0.1/a.jpg", "https://10.0.0.5/a.jpg",
            "https://localhost/a.jpg", "ftp://cdn.example.com/a"):
    try:
        im.fetch(bad)
        ok = False
    except ValueError:
        ok = True
    check("fetch refuses " + bad, ok, bad)

print("== bounds + usage ==")
cur = FakeCur([[], [{"used": 5}]])
im.enforce_bounds(cur, 7, {"retention_days": 12, "quota_mb": 10})
check("retention by days, tenant-scoped", cur.executed[0][1] == (7, 12)
      and "content IS NOT NULL" in cur.executed[0][0]
      and len(cur.executed) == 2, cur.executed)
cur = FakeCur([[], [{"used": 10 * 1024 * 1024 + 500}], []])
im.enforce_bounds(cur, 7, {"retention_days": 30, "quota_mb": 10})
check("over quota -> oldest copies released", len(cur.executed) == 3
      and cur.executed[2][1] == (7, 7, 500)
      and "ORDER BY id" in cur.executed[2][0]
      and "note = 'quota'" in cur.executed[2][0], cur.executed)
cur = FakeCur([[{"used": 2048, "copies": 2, "files": 5}]])
check("usage", im.usage(cur, 7) == {"used_bytes": 2048, "copies": 2,
                                    "files": 5}
      and cur.executed[0][1] == (7,), cur.executed)

print("== forget contact ==")
cur = FakeCur([[{"id": 1}, {"id": 2}]])
check("forget deletes the contact's files", im.forget_contact(
    cur, 7, "ig:555") == 2 and cur.executed[0][1] == (7, "ig:555"),
    cur.executed)
cur = FakeCur([])
check("forget needs a contact", im.forget_contact(cur, 7, " ") == 0
      and cur.executed == [], "empty")

print("== instagram fresh link ==")
import portal_instagram

ig_calls = []
portal_instagram._load_settings = lambda cur, client_id: {
    "access_token": "IGTOKEN"}


def meta(method, path, token, payload=None):
    ig_calls.append((method, path, token))
    return {"attachments": {"data": [
        {"image_data": {"url": "https://cdn.fbsbx.com/new.jpg"}},
        {"video_data": {"url": "https://cdn.fbsbx.com/new.mp4"}},
        {"file_url": "https://cdn.fbsbx.com/f.pdf"},
        {"payload": {"url": "https://cdn.fbsbx.com/p.jpg"}},
        {"image_data": {"url": "http://insecure.example/x.jpg"}},
    ]}}


portal_instagram._meta_request = meta
check("image url", im.refresh_instagram_url(None, 7, "m_1=", 0) ==
      "https://cdn.fbsbx.com/new.jpg", ig_calls)
check("graph path + token", ig_calls[0] == (
    "GET", "/m_1%3D?fields=attachments", "IGTOKEN"), ig_calls)
check("video url", im.refresh_instagram_url(None, 7, "m_1", 1) ==
      "https://cdn.fbsbx.com/new.mp4", "video")
check("file url", im.refresh_instagram_url(None, 7, "m_1", 2) ==
      "https://cdn.fbsbx.com/f.pdf", "file")
check("payload url", im.refresh_instagram_url(None, 7, "m_1", 3) ==
      "https://cdn.fbsbx.com/p.jpg", "payload")
check("http link refused", im.refresh_instagram_url(None, 7, "m_1", 4) ==
      "", "http")
check("index out of range (many) -> none",
      im.refresh_instagram_url(None, 7, "m_1", 9) == "", "range")
portal_instagram._meta_request = lambda *a, **k: {"attachments": {
    "data": [{"image_data": {"url": "https://cdn.fbsbx.com/only.jpg"}}]}}
check("single attachment answers any index",
      im.refresh_instagram_url(None, 7, "m_1", 2) ==
      "https://cdn.fbsbx.com/only.jpg", "single")
ig_calls.clear()
portal_instagram._meta_request = meta
check("event ids skipped", im.refresh_instagram_url(
    None, 7, "event:1:2", 0) == "" and ig_calls == [], ig_calls)
portal_instagram._load_settings = lambda cur, client_id: {"access_token": ""}
check("no token -> none", im.refresh_instagram_url(None, 7, "m_1", 0) ==
      "" and ig_calls == [], ig_calls)
portal_instagram._load_settings = lambda cur, client_id: {
    "access_token": "IGTOKEN"}


def meta_fail(*_a, **_k):
    raise portal_instagram.MetaGraphError(400, "message too old")


portal_instagram._meta_request = meta_fail
check("graph error fails soft", im.refresh_instagram_url(
    None, 7, "m_1", 0) == "", "error")

print("== owner API ==")
app = Flask("media-store")
app.register_blueprint(im.bp)
client = app.test_client()
im._DDL_READY = True
im._CS_READY = True

PrincipalStub(im, principal=None)
check("list 401", client.get("/api/v1/portal/conversations/55/media")
      .status_code == 401, "401")
PrincipalStub(im, principal=human_principal(client_id=7))
install_db_stub(im, [[]], client_id=7)
r = client.get("/api/v1/portal/conversations/55/media")
check("other tenant's conversation -> 404", r.status_code == 404,
      r.status_code)
row = {"id": 3, "kind": "image", "mime": "image/jpeg", "size_bytes": 204,
       "status": "stored", "note": "", "channel": "instagram",
       "external_id": "m_1", "has_copy": True, "has_link": True,
       "created_at": "2026-10-01 10:00:00+05"}
conn = install_db_stub(im, [[{"id": 55}], [row, dict(
    row, id=4, kind="video", has_copy=False, status="link"), dict(
    row, id=5, channel="telegram", external_id="", has_copy=False,
    has_link=False, status="expired", note="retention")]], client_id=7)
r = client.get("/api/v1/portal/conversations/55/media")
media = (r.get_json() or {}).get("media") or []
check("list 200", r.status_code == 200 and [m["id"] for m in media] ==
      [3, 4, 5], r.get_json())
check("list tenant-scoped", conn.cur.executed[0][1][:2] in ((55, 7),
                                                            (7, 55))
      and 7 in conn.cur.executed[1][1], conn.cur.executed)
check("no raw urls / bytes / provider ids leak", all(
    "source_url" not in m and "content" not in m and "external_id" not in m
    for m in media), media)
check("expired telegram file cannot open; instagram can refresh",
      media[2]["can_open"] is False and media[1]["can_refresh"] is True
      and media[0]["has_copy"] is True, media)

install_db_stub(im, [[]], client_id=7)
check("content 404", client.get("/api/v1/portal/inbound-media/3/content")
      .status_code == 404, "404")
install_db_stub(im, [[dict(row, kind="video", content=None,
                           source_url="https://cdn/v.mp4")]], client_id=7)
check("content refuses video (open link)", client.get(
    "/api/v1/portal/inbound-media/3/content").status_code == 409, "409")
install_db_stub(im, [[dict(row, content=memoryview(JPEG),
                           source_url="")]], client_id=7)
r = client.get("/api/v1/portal/inbound-media/3/content")
check("stored copy served", r.status_code == 200 and r.data == JPEG
      and r.headers["Content-Type"] == "image/jpeg", r.status_code)
check("safe headers", r.headers.get("X-Content-Type-Options") == "nosniff"
      and "sandbox" in r.headers.get("Content-Security-Policy", "")
      and r.headers.get("Content-Disposition", "").startswith("inline")
      and "customer-image.jpg" in r.headers.get("Content-Disposition", ""),
      dict(r.headers))
install_db_stub(im, [[dict(row, content=SVG, source_url="")]], client_id=7)
check("stored non-media bytes never served", client.get(
    "/api/v1/portal/inbound-media/3/content").status_code == 410, "410")

# no copy: provider link still valid -> served + kept
im.fetch = lambda url, cap=0: (JPEG, "image/jpeg")
conn = install_db_stub(im, [[dict(row, content=None, has_copy=False,
                                  source_url="https://cdn.fbsbx.com/i.jpg")],
                            settings_row(), [], [], [{"used": 0}]],
                       client_id=7)
r = client.get("/api/v1/portal/inbound-media/3/content")
saved = [e for e in conn.cur.executed if "SET content = %s" in str(e[0])]
check("link fetched, served and kept", r.status_code == 200
      and r.data == JPEG and saved and raw(saved[0][1][0]) == JPEG
      and saved[0][1][-2:] == (3, 7), conn.cur.executed)

# no copy, link expired, Instagram refresh succeeds
fetched_urls = []


def fetch_second(url, cap=0):
    fetched_urls.append(url)
    if "old" in url:
        raise ValueError("media host answered HTTP 403")
    return OGG, "audio/ogg"


im.fetch = fetch_second
portal_instagram._meta_request = lambda *a, **k: {"attachments": {
    "data": [{"audio_data": {"url": "https://cdn.fbsbx.com/fresh.ogg"}}]}}
conn = install_db_stub(im, [[dict(row, kind="audio", content=None,
                                  source_url="https://cdn.fbsbx.com/old.ogg")],
                            [], settings_row(), [], [], [{"used": 0}]],
                       client_id=7)
r = client.get("/api/v1/portal/inbound-media/3/content")
check("expired link -> graph refresh -> served", r.status_code == 200
      and r.data == OGG and r.headers["Content-Type"] == "audio/ogg"
      and fetched_urls == ["https://cdn.fbsbx.com/old.ogg",
                           "https://cdn.fbsbx.com/fresh.ogg"], fetched_urls)
check("refreshed link remembered", any(
    "url_refreshed_at" in str(e[0]) and e[1][0] ==
    "https://cdn.fbsbx.com/fresh.ogg" for e in conn.cur.executed),
    conn.cur.executed)

portal_instagram._meta_request = meta_fail
im.fetch = lambda url, cap=0: (_ for _ in ()).throw(ValueError("gone"))
install_db_stub(im, [[dict(row, content=None, source_url="https://c/old")]],
                client_id=7)
r = client.get("/api/v1/portal/inbound-media/3/content")
check("instagram gone -> 410 with the 20-message hint",
      r.status_code == 410 and "latest messages" in r.get_data(as_text=True),
      r.get_data(as_text=True))
install_db_stub(im, [[dict(row, channel="telegram", content=None,
                           source_url="")]], client_id=7)
r = client.get("/api/v1/portal/inbound-media/3/content")
check("telegram without copy -> 410 (no instagram hint)",
      r.status_code == 410 and "Instagram" not in r.get_data(as_text=True),
      r.status_code)

print("== link route ==")
portal_instagram._meta_request = lambda *a, **k: {"attachments": {
    "data": [{"video_data": {"url": "https://cdn.fbsbx.com/new.mp4"}}]}}
conn = install_db_stub(im, [[dict(row, kind="video",
                                  source_url="https://cdn/old.mp4")], [], []],
                       client_id=7)
r = client.get("/api/v1/portal/inbound-media/4/link")
check("instagram link refreshed", r.status_code == 200 and r.get_json() == {
    "url": "https://cdn.fbsbx.com/new.mp4", "fresh": True}, r.get_json())
install_db_stub(im, [[dict(row, channel="telegram",
                           source_url="https://t.example/f.pdf")]],
                client_id=7)
r = client.get("/api/v1/portal/inbound-media/4/link")
check("stored link returned", r.get_json() == {
    "url": "https://t.example/f.pdf", "fresh": False}, r.get_json())
install_db_stub(im, [[dict(row, channel="telegram", source_url="")]],
                client_id=7)
check("no link -> 410", client.get("/api/v1/portal/inbound-media/4/link")
      .status_code == 410, "410")

print("== delete ==")
PrincipalStub(im, principal=dict(human_principal(client_id=7),
                                 via_api_key=True))
check("delete is human-only", client.delete(
    "/api/v1/portal/inbound-media/3").status_code == 403, "403")
PrincipalStub(im, principal=human_principal(client_id=7))
install_db_stub(im, [[]], client_id=7)
check("delete other tenant -> 404", client.delete(
    "/api/v1/portal/inbound-media/3").status_code == 404, "404")
conn = install_db_stub(im, [[{"id": 3}], []], client_id=7)
r = client.delete("/api/v1/portal/inbound-media/3")
check("delete 200 + audited", r.status_code == 200
      and conn.cur.executed[0][1] == (3, 7)
      and "media_store.deleted" in str(conn.cur.executed[1][1]),
      conn.cur.executed)

print("== settings API ==")
conn = install_db_stub(im, [settings_row({"quota_mb": 20}), [],
                            [{"used": 0}], [{"used": 1024, "copies": 1,
                                             "files": 3}]], client_id=7)
r = client.get("/api/v1/portal/media-store/settings")
body = r.get_json() or {}
check("settings GET", r.status_code == 200 and body.get("settings") == {
    "keep_copies": True, "retention_days": 30, "quota_mb": 20}
    and body.get("usage") == {"used_bytes": 1024, "copies": 1, "files": 3}
    and body.get("limits", {}).get("mode") == "on", body)
install_db_stub(im, [settings_row()], client_id=7)
r = client.put("/api/v1/portal/media-store/settings",
               json={"settings": {"quota_mb": 1}})
check("settings PUT validates", r.status_code == 400
      and "Storage limit" in r.get_data(as_text=True), r.status_code)
PrincipalStub(im, principal=dict(human_principal(client_id=7),
                                 via_api_key=True))
check("settings PUT human-only", client.put(
    "/api/v1/portal/media-store/settings",
    json={"settings": {"quota_mb": 20}}).status_code == 403, "403")
PrincipalStub(im, principal=human_principal(client_id=7))
conn = install_db_stub(im, [settings_row(), [], [], [{"used": 0}],
                            [{"used": 0, "copies": 0, "files": 0}], []],
                       client_id=7)
r = client.put("/api/v1/portal/media-store/settings",
               json={"settings": {"keep_copies": False, "retention_days": 7}})
saved = json.loads(conn.cur.executed[1][1][1])
check("settings PUT saves under media_store", r.status_code == 200
      and saved == {"media_store": {"keep_copies": False,
                                    "retention_days": 7, "quota_mb": 50}}
      and conn.cur.executed[1][1][0] == 7, saved)
check("settings PUT audited", "media_store.settings" in str(
    conn.cur.executed[-1][1]), conn.cur.executed[-1])


class Boom:
    def cursor(self):
        raise RuntimeError("db down")

    def close(self):
        pass


install_db_stub(im, [], client_id=7)
im.portal_db._conn = lambda: Boom()
check("db failure -> 503", client.get("/api/v1/portal/media-store/settings")
      .status_code == 503, "503")

print("== retention sweep ==")
im._LAST_PURGE.clear()
conn = install_db_stub(im, [settings_row(), [], [{"used": 0}]], client_id=7)
check("no sweep right after boot", im.maybe_purge(7) is False
      and conn.cur.executed == [], conn.cur.executed)
im._BOOT -= im.PURGE_EVERY_SECONDS + 1
check("sweep after the boot delay", im.maybe_purge(7) is True
      and len(conn.cur.executed) == 3, conn.cur.executed)
check("sweep throttled", im.maybe_purge(7) is False, "throttle")
check("sweep ignores bad client", im.maybe_purge(0) is False, "zero")
conn = install_db_stub(im, [], client_id=7)
im._LAST_PURGE.clear()
check("sweep failure never raises", im.maybe_purge(7) is False, "raise")

print("== wiring ==")
connector = bsrc("connector_api.py")
msgs_at = connector.find('"INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE)')
cap_at = connector.find("portal_inbound_media.capture(")
pop_at = connector.find('item.pop("_media_fetched", None)')
reply_at = connector.find("# One-reply law (B2)")
check("capture runs after the message row, before reply hooks",
      0 < msgs_at < cap_at < pop_at < reply_at, (msgs_at, cap_at, pop_at,
                                                 reply_at))
check("capture passes the detached blobs + store budget",
      "media_blobs.get(id(item)), store_budget, message_id)"
      in " ".join(connector.split()), "args")
check("store budget created in its own try", "store_budget ="
      " portal_inbound_media.Budget()" in connector, "budget")
check("tick runs the retention sweep",
      "portal_inbound_media.maybe_purge(tenant[\"client_id\"])" in connector,
      "tick")
mai_src = bsrc("portal_media_ai.py")
check("media understanding shares the bytes it fetched",
      'item.setdefault("_media_fetched", {})[index] = (' in mai_src, "mai")
memory_src = bsrc("portal_memory.py")
check("memory purge forgets files under a savepoint",
      "portal_inbound_media.forget_contact(cur, client_id, contact)" in
      memory_src and 'SAVEPOINT of_forget_media' in memory_src, "memory")
app_src = bsrc("app.py")
check("blueprint registered", "from portal_inbound_media import bp as"
      " portal_inbound_media_bp" in app_src and
      "aux_app.register_blueprint(portal_inbound_media_bp)" in app_src, "app")
check("events never store fetched bytes (record before enrich)",
      connector.find("portal_events.record_inbound(") <
      connector.find("portal_media_ai.enrich("), "order")

print("== twilio: webhook base ==")
import portal_voice

for value, want in (("https://cp.example.com/", "https://cp.example.com"),
                    ("https://cp.example.com/prefix", "https://cp.example.com/prefix"),
                    ("http://cp.example.com", ""),
                    ("https://cp.example.com/?a=1", ""),
                    ("https://cp.example.com/#x", ""),
                    ("https://u:p@cp.example.com", ""),
                    ("cp.example.com", ""), ("", "")):
    check("clean_webhook_base " + repr(value),
          platform_settings.clean_webhook_base(value) == want,
          platform_settings.clean_webhook_base(value))
check("voice group has webhook_base",
      "webhook_base" in platform_settings.GROUP_KEYS["voice"], "group")

flask_app = Flask("twilio-base")
_orig_vp = platform_settings.voice_platform
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = "https://env.example.com/"
platform_settings.voice_platform = lambda: {"webhook_base":
                                            "https://panel.example.com"}
with flask_app.test_request_context("/", base_url="https://req.example.net"):
    check("env wins", portal_voice.webhook_base() == (
        "https://env.example.com", "env"), portal_voice.webhook_base())
    os.environ.pop("OMNIFLOW_TWILIO_WEBHOOK_BASE")
    check("panel next", portal_voice.webhook_base() == (
        "https://panel.example.com", "panel"), portal_voice.webhook_base())
    check("TwiML actions follow the configured base",
          portal_voice._public_base() == "https://panel.example.com",
          portal_voice._public_base())
    platform_settings.voice_platform = lambda: {"webhook_base": ""}
    check("request host last", portal_voice.webhook_base() == (
        "https://req.example.net", "request"), portal_voice.webhook_base())
with flask_app.test_request_context("/", base_url="http://localhost:5000"):
    check("localhost is never a webhook base", portal_voice.webhook_base()
          == ("", "none"), portal_voice.webhook_base())
    os.environ["OMNIFLOW_SITE_URL"] = "https://site.example.com"
    check("TwiML base unchanged without a configured base",
          portal_voice._public_base() == "https://site.example.com",
          portal_voice._public_base())
    os.environ.pop("OMNIFLOW_SITE_URL")
platform_settings.voice_platform = lambda: {"webhook_base":
                                            "https://panel.example.com"}
with flask_app.test_request_context(
        "/api/v1/public/voice/incoming", method="POST",
        base_url="https://req.example.net"):
    cands = portal_voice._candidate_urls()
    check("signature accepts the panel base",
          "https://panel.example.com/api/v1/public/voice/incoming" in cands,
          cands)
platform_settings.voice_platform = _orig_vp

print("== twilio: number states ==")
BASE = "https://cp.example.com"
VOICE = BASE + "/api/v1/public/voice/incoming"
STATUS = BASE + "/api/v1/public/voice/webhook"
num = {"sid": "PN" + "a" * 32, "phone_number": "+14155550100",
       "friendly_name": "Main", "capabilities": {"voice": True}}
for extra, want in (({"voice_url": VOICE, "status_callback": STATUS},
                     "connected"),
                    ({"voice_url": VOICE + "/", "status_callback": STATUS},
                     "connected"),
                    ({"voice_url": VOICE, "status_callback": ""}, "partial"),
                    ({"voice_url": "https://demo.twilio.com/welcome/voice/"},
                     "elsewhere"),
                    ({}, "not_set"),
                    ({"voice_url": VOICE, "voice_application_sid": "AP1"},
                     "app"),
                    ({"trunk_sid": "TK1"}, "trunk")):
    state = portal_voice.twilio_number_state(dict(num, **extra), BASE)
    check("state " + want + " " + json.dumps(extra)[:40],
          state["state"] == want, state)
state = portal_voice.twilio_number_state(dict(
    num, voice_url="https://demo.twilio.com/welcome/voice/"), BASE)
check("elsewhere shows only the host", state["voice_host"] ==
      "demo.twilio.com" and "welcome" not in json.dumps(state), state)
check("no base -> never connected", portal_voice.twilio_number_state(
    dict(num, voice_url=VOICE, status_callback=STATUS), "")["state"] ==
    "elsewhere", "nobase")
check("sms-only number flagged", portal_voice.twilio_number_state(
    dict(num, capabilities={"voice": False}), BASE)["voice_capable"] is False,
    "caps")

print("== twilio: REST call ==")
sent = []


class FakeResp:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_orig_urlopen = portal_voice.urllib.request.urlopen


def fake_urlopen(req, timeout=0):
    sent.append(req)
    return FakeResp({"incoming_phone_numbers": [num, "junk"],
                     "next_page_uri": "/next"})


portal_voice.urllib.request.urlopen = fake_urlopen
KEYS = {"account_sid": "AC123", "auth_token": "tok"}
try:
    numbers, truncated = portal_voice.list_twilio_numbers(KEYS)
    req = sent[-1]
    check("list numbers", numbers == [num] and truncated is True, numbers)
    check("list url + page size", req.full_url.startswith(
        "https://api.twilio.com/2010-04-01/Accounts/AC123/"
        "IncomingPhoneNumbers.json?PageSize=") and req.get_method() == "GET",
        req.full_url)
    check("basic auth", req.get_header("Authorization") == "Basic " +
          base64.b64encode(b"AC123:tok").decode(), req.get_header(
              "Authorization"))
    portal_voice.connect_twilio_number(KEYS, "PN" + "a" * 32, BASE)
    req = sent[-1]
    form = dict(pair.split("=", 1) for pair in req.data.decode().split("&"))
    check("connect posts only the four voice routing fields",
          req.get_method() == "POST" and req.full_url.endswith(
              "/IncomingPhoneNumbers/PN" + "a" * 32 + ".json")
          and set(form) == {"VoiceUrl", "VoiceMethod", "StatusCallback",
                            "StatusCallbackMethod"}
          and form["VoiceMethod"] == "POST", form)
    check("connect urls", form["VoiceUrl"] == (
        "https%3A%2F%2Fcp.example.com%2Fapi%2Fv1%2Fpublic%2Fvoice%2Fincoming")
        and form["StatusCallback"].endswith("voice%2Fwebhook"), form)

    def http_error(req, timeout=0):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, io.BytesIO(json.dumps(
                {"code": 20003, "message": "Authenticate"}).encode()))

    portal_voice.urllib.request.urlopen = http_error
    try:
        portal_voice.list_twilio_numbers(KEYS)
        err = None
    except portal_voice.TwilioApiError as failure:
        err = failure
    check("twilio error text surfaced", err is not None and err.status == 401
          and err.message == "Authenticate", err and err.message)

    def down(req, timeout=0):
        raise urllib.error.URLError("dns")

    portal_voice.urllib.request.urlopen = down
    try:
        portal_voice.list_twilio_numbers(KEYS)
        err = None
    except portal_voice.TwilioApiError as failure:
        err = failure
    check("unreachable -> 502", err is not None and err.status == 502, err)
finally:
    portal_voice.urllib.request.urlopen = _orig_urlopen

print("== twilio: admin routes ==")
import admin_providers

admin_app = Flask("admin-twilio")
admin_app.register_blueprint(admin_providers.bp)
admin = admin_app.test_client()
H = {"X-Omniflow-Key": "x"}
_orig_keys = portal_voice._voice_keys
portal_voice._voice_keys = lambda: {"account_sid": "", "auth_token": ""}
check("list needs service key", admin.get("/api/v1/admin/voice/twilio")
      .status_code == 403, "403")
r = admin.get("/api/v1/admin/voice/twilio", headers=H)
check("list without twilio keys -> 409", r.status_code == 409
      and "Account SID" in r.get_data(as_text=True), r.status_code)
portal_voice._voice_keys = lambda: dict(KEYS)
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = BASE
portal_voice.list_twilio_numbers = lambda keys: ([
    dict(num, voice_url=VOICE, status_callback=STATUS),
    dict(num, sid="PN" + "b" * 32, phone_number="+14155550199")], False)
portal_voice._CS_READY = True
install_db_stub(admin_providers, [[{"client_id": 7,
                                    "number": "+14155550100",
                                    "enabled": True}]])
r = admin.get("/api/v1/admin/voice/twilio", headers=H)
body = r.get_json() or {}
check("list 200 with base + urls", r.status_code == 200
      and body.get("base_url") == BASE and body.get("base_source") == "env"
      and body.get("voice_url") == VOICE and body.get("status_url") == STATUS,
      body)
check("list states + assignment", [(n["state"], n["assigned_client_id"])
                                   for n in body.get("numbers", [])] ==
      [("connected", 7), ("not_set", None)], body.get("numbers"))
check("list never returns tokens", "tok" not in r.get_data(as_text=True)
      and "AC123" not in r.get_data(as_text=True), "secret")


def list_fail(keys):
    raise portal_voice.TwilioApiError(401, "Authenticate")


portal_voice.list_twilio_numbers = list_fail
r = admin.get("/api/v1/admin/voice/twilio", headers=H)
check("twilio failure -> 502 with its message", r.status_code == 502
      and "Twilio: Authenticate" in r.get_data(as_text=True), r.status_code)

connected = []
portal_voice.connect_twilio_number = lambda keys, sid, base: (
    connected.append((sid, base)) or dict(num, sid=sid, voice_url=VOICE,
                                          status_callback=STATUS))
portal_voice.get_twilio_number = lambda keys, sid: dict(num, sid=sid)
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN123"})
check("connect validates the sid", r.status_code == 400, r.status_code)
portal_voice.get_twilio_number = lambda keys, sid: dict(
    num, sid=sid, voice_application_sid="AP" + "c" * 32)
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN" + "a" * 32})
check("connect refuses a TwiML-app number", r.status_code == 409
      and "TwiML app" in r.get_data(as_text=True) and connected == [],
      r.get_data(as_text=True))
portal_voice.get_twilio_number = lambda keys, sid: dict(
    num, sid=sid, trunk_sid="TK1")
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN" + "a" * 32})
check("connect refuses a SIP-trunk number", r.status_code == 409
      and "SIP trunk" in r.get_data(as_text=True) and connected == [],
      r.status_code)
os.environ.pop("OMNIFLOW_TWILIO_WEBHOOK_BASE")
platform_settings.voice_platform = lambda: {"webhook_base": ""}
portal_voice.get_twilio_number = lambda keys, sid: dict(num, sid=sid)
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN" + "a" * 32},
               base_url="http://localhost")
check("connect needs a webhook base", r.status_code == 409
      and "no_webhook_base" in r.get_data(as_text=True) and connected == [],
      r.get_data(as_text=True))
platform_settings.voice_platform = lambda: {"webhook_base": BASE}
conn = install_db_stub(admin_providers, [[]])
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN" + "a" * 32})
check("connect 200", r.status_code == 200 and connected == [
    ("PN" + "a" * 32, BASE)] and (r.get_json() or {}).get("number", {})
    .get("state") == "connected", r.get_json())
check("connect audited (last 4 digits only)", any(
    "voice.twilio_connected" in str(e[1]) and "...0100" in str(e[1])
    and "+14155550100" not in str(e[1]) for e in conn.cur.executed),
    conn.cur.executed)


def get_missing(keys, sid):
    raise portal_voice.TwilioApiError(404, "not found")


portal_voice.get_twilio_number = get_missing
r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H,
               json={"sid": "PN" + "a" * 32})
check("number not in this account -> 404", r.status_code == 404, r.status_code)
platform_settings.voice_platform = _orig_vp
portal_voice._voice_keys = _orig_keys

values, problem = admin_providers._clean_group(
    "voice", {"webhook_base": "http://cp.example.com"})
check("admin rejects a non-https webhook base", values is None
      and "voice.webhook_base" in (problem or ""), problem)
values, problem = admin_providers._clean_group(
    "voice", {"webhook_base": "https://cp.example.com/?x=1"})
check("admin rejects a webhook base with a query", values is None, problem)
values, problem = admin_providers._clean_group(
    "voice", {"webhook_base": "https://cp.example.com/"})
check("admin stores a clean webhook base", problem is None
      and values == {"webhook_base": "https://cp.example.com"}, values)
values, problem = admin_providers._clean_group("voice", {"webhook_base": ""})
check("admin allows clearing the webhook base", problem is None
      and values == {"webhook_base": ""}, values)

print("== website ==")
P = "app/api/omniflow/portal/"
lib = src("lib/omniflow/portal.ts")
for fn in ("listConversationMedia", "getInboundMediaLink",
           "deleteInboundMedia", "getMediaStoreSettings",
           "saveMediaStoreSettings"):
    check("portal.ts " + fn, "export function " + fn + "(" in lib, fn)
check("410 mapped to an owner message", "response.status === 410" in lib
      and '"media_expired"' in lib, "410")
asset = src("lib/omniflow/portal-asset.ts")
check("binary helper", "export async function portalInboundMediaContent("
      in asset and 'redirect: "error"' in asset, "asset")
content = src(P + "inbound-media/[id]/content/route.ts")
check("content proxy only passes inert media types",
      "SAFE_TYPE" in content and "image\\/(jpeg|png|webp|gif)" in content
      and "svg" not in content.lower(), "safe type")
check("content proxy headers", '"X-Content-Type-Options": "nosniff"' in
      content and "sandbox" in content and "private, max-age=300" in content,
      "headers")
for rel, depth in (("conversations/[id]/media/route.ts", 7),
                   ("inbound-media/[id]/content/route.ts", 7),
                   ("inbound-media/[id]/link/route.ts", 7),
                   ("inbound-media/[id]/route.ts", 6),
                   ("media-store/settings/route.ts", 6)):
    text = src(P + rel)
    check("import depth " + rel, ('"' + "../" * depth + "lib/omniflow/")
          in text and ('"' + "../" * (depth + 1)) not in text, rel)
delete_route = src(P + "inbound-media/[id]/route.ts")
check("delete BFF checks origin", "withPortalToken(" in delete_route
      and "request\n  );" in delete_route, "origin")
settings_route = src(P + "media-store/settings/route.ts")
check("settings BFF whitelists fields", "settings.keep_copies" in
      settings_route and "settings.quota_mb" in settings_route
      and "}, request);" in settings_route, "whitelist")
card = src("app/dashboard/(portal)/conversations/[id]/MediaCard.tsx")
check("MediaCard hides when empty", "if (items.length === 0) return null;"
      in card, "empty")
check("MediaCard confirms delete", "window.confirm(" in card, "confirm")
check("MediaCard opens links safely", 'rel="noopener noreferrer"' in card
      and "dangerouslySetInnerHTML" not in card, "links")
thread = src("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
check("MediaCard mounted lazily", 'const MediaCard = dynamic(() =>'
      ' import("./MediaCard"));' in thread and
      "<MediaCard conversationId={Number(id)} />" in thread, "thread")
store = src("app/dashboard/(portal)/settings/MediaStoreSection.tsx")
vv = src("app/dashboard/(portal)/settings/VoiceVisionCard.tsx")
check("storage section in Voice and images", "<MediaStoreSection />" in vv
      and 'import MediaStoreSection from "./MediaStoreSection";' in vv, "vv")
check("storage section controls", "keep_copies" in store and
      "retention_days" in store and "quota_mb" in store and
      "max_quota_mb" in store, "controls")
admin_lib = src("lib/omniflow/admin-control-plane.ts")
check("admin lib twilio calls", "export async function"
      " listAdminTwilioNumbers(" in admin_lib and "export async function"
      " connectAdminTwilioNumber(" in admin_lib and
      'path = "api/v1/admin/voice/numbers"' in admin_lib, "admin lib")
A = "app/api/omniflow/admin/voice/twilio/"
list_route = src(A + "route.ts")
connect_route = src(A + "connect/route.ts")
check("admin BFF: origin + session", "sameOrigin(request)" in list_route
      and "requireAdminSession()" in list_route and
      "sameOrigin(request)" in connect_route and
      "requireAdminSession()" in connect_route, "admin bff")
check("admin BFF validates the sid", "/^PN[0-9a-fA-F]{32}$/" in
      connect_route, "sid")
check("admin BFF import depth", '"../../../../../../lib/' in list_route
      and '"../../../../../../../lib/' in connect_route, "depth")
section = src("app/admin/(panel)/integrations/TwilioNumbersSection.tsx")
panel = src("app/admin/(panel)/integrations/VoiceNumbersPanel.tsx")
check("twilio section mounted", "<TwilioNumbersSection" in panel, "panel")
check("connect is confirmed first", "window.confirm(" in section
      and section.find("window.confirm(") < section.find(
          '"/api/omniflow/admin/voice/twilio/connect"'), "confirm")
check("app / trunk numbers get no Connect button",
      'row.state !== "connected" && !blocked' in section, "blocked")
integrations = src("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("webhook address field", 'key: "webhook_base"' in integrations
      and "press Connect" in integrations, "field")
for rel in ("app/dashboard/(portal)/conversations/[id]/MediaCard.tsx",
            "app/dashboard/(portal)/settings/MediaStoreSection.tsx",
            "app/admin/(panel)/integrations/TwilioNumbersSection.tsx"):
    text = src(rel)
    bad = [ch for ch in "\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733"
           "\u263a\u25fc\u27a1" if ch in text]
    check("no emoji-capable glyphs " + rel.split("/")[-1], not bad, bad)

summary("twilio_media_store")
