"""Tests for V2 B23: voice inbound + voicemail recordings.

Twilio points the owner's number at POST /api/v1/public/voice/incoming
(greeting + <Record>) and the recording lands via /voice/record; the
caller is matched to a conversation by phone digits so the voicemail
shows in the right workspace, and the portal streams the audio back
through /portal/voice/recordings/<sid> (Basic-auth media proxy).
"""
import json
import os

from flask import Flask

import platform_settings
import portal_voice
import test_lib
from test_lib import (check, install_db_stub, PrincipalStub, summary)

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

app = Flask("voice-inbound")
app.register_blueprint(portal_voice.bp)
app.register_blueprint(portal_voice.public_bp)
client = app.test_client()

portal_voice._DDL_READY = True
portal_voice._twilio_fetch_media = lambda keys, url: b"MP3BYTES"
KEYS = {"account_sid": "AC1", "auth_token": "tok",
        "from_number": "+15550001"}
platform_settings.get_group = lambda group: dict(KEYS) if group == "voice" else {}

print("== incoming call webhook ==")

r = client.post("/api/v1/public/voice/incoming", data={"From": "+923001234567"})
check("incoming missing sid 400", r.status_code == 400, r.status_code)
r = client.post("/api/v1/public/voice/incoming", data={"CallSid": "CA1"})
check("incoming missing from 400", r.status_code == 400, r.status_code)

conn = install_db_stub(portal_voice, [[{"client_id": 1, "id": 5}], []])
r = client.post("/api/v1/public/voice/incoming",
                data={"CallSid": "CA1", "From": "+923001234567"})
body = r.get_data(as_text=True)
check("incoming 200 xml", r.status_code == 200
      and "xml" in r.content_type, (r.status_code, r.content_type))
check("incoming twiml record", "<Record" in body
      and "/api/v1/public/voice/record" in body
      and "maxLength" in body, body[:160])
check("incoming greeting", "leave your message" in body, body[:160])
inserts = [e for e in conn.cur.executed if "INSERT" in e[0]]
check("incoming insert", len(inserts) == 1
      and inserts[0][1] == (1, "5", "+923001234567", "CA1",
                            "in-progress", "Inbound call"),
      inserts)
check("incoming direction sql", "'inbound'" in inserts[0][0], "sql")
check("incoming match query", any(
    "portal_conversations" in e[0] and "regexp_replace" in e[0]
    for e in conn.cur.executed), "match")

conn = install_db_stub(portal_voice, [[], []])
r = client.post("/api/v1/public/voice/incoming",
                data={"CallSid": "CA2", "From": "923009999999"})
inserts = [e for e in conn.cur.executed if "INSERT" in e[0]]
check("incoming unknown caller client 0", r.status_code == 200
      and inserts and inserts[0][1][0] == 0, inserts)

platform_settings.get_group = lambda group: (
    {"greeting": "Shukriya! Apna message chhor dein.", **KEYS}
    if group == "voice" else {})
conn = install_db_stub(portal_voice, [[], []])
r = client.post("/api/v1/public/voice/incoming",
                data={"CallSid": "CA3", "From": "+923001234567"})
check("incoming custom greeting", "Shukriya" in r.get_data(as_text=True),
      r.get_data(as_text=True)[:160])
platform_settings.get_group = lambda group: dict(KEYS) if group == "voice" else {}

print("== recording webhook ==")

r = client.post("/api/v1/public/voice/record", data={"CallSid": "CA1"})
check("record missing url 400", r.status_code == 400, r.status_code)

conn = install_db_stub(portal_voice,
                       [[{"client_id": 1, "contact_id": "5"}], []])
r = client.post("/api/v1/public/voice/record",
                data={"CallSid": "CA1", "RecordingDuration": "42",
                      "RecordingUrl": "https://api.twilio.com/RE1",
                      "From": "+923001234567"})
updates = [e for e in conn.cur.executed if "UPDATE" in e[0]]
check("record 200 xml", r.status_code == 200
      and "xml" in r.content_type, r.status_code)
check("record update", len(updates) == 1
      and updates[0][1] == ("https://api.twilio.com/RE1", 42, "CA1"),
      updates)
check("record audit", any("voice.inbound" in json.dumps(e)
                          for e in conn.cur.executed), "audit")

conn = install_db_stub(portal_voice, [[]])
r = client.post("/api/v1/public/voice/record",
                data={"CallSid": "CA9",
                      "RecordingUrl": "https://api.twilio.com/RE9"})
updates = [e for e in conn.cur.executed if "UPDATE" in e[0]]
check("record unknown sid no audit", r.status_code == 200
      and len(updates) == 1
      and not any("voice.inbound" in json.dumps(e)
                  for e in conn.cur.executed), r.status_code)

print("== list carries voicemail fields ==")

conn = install_db_stub(portal_voice, [
    [{"id": 3, "contact_id": "5", "phone": "+923001234567",
      "sid": "CA1", "status": "recorded", "message": "Inbound call",
      "direction": "inbound",
      "recording_url": "https://api.twilio.com/RE1",
      "duration_seconds": 42, "created_at": "now"}]])
PrincipalStub(portal_voice, principal=PRINCIPAL)
r = client.get("/api/v1/portal/voice/calls")
body = r.get_json()
check("voice list 200", r.status_code == 200, r.status_code)
call = body["calls"][0]
check("voice list direction", call["direction"] == "inbound", call)
check("voice list has_recording", call["has_recording"] is True, call)
check("voice list duration", call["duration_seconds"] == 42, call)
lists = [e for e in conn.cur.executed if "SELECT" in e[0]]
check("voice list select cols", lists
      and all(col in lists[0][0] for col in
              ("direction", "recording_url", "duration_seconds")), "sql")

print("== recording playback proxy ==")

install_db_stub(portal_voice, [[]])
r = client.get("/api/v1/portal/voice/recordings/CA9")
check("playback 404", r.status_code == 404, r.status_code)

platform_settings.get_group = lambda group: {}
install_db_stub(portal_voice,
                [[{"recording_url": "https://api.twilio.com/RE1"}]])
r = client.get("/api/v1/portal/voice/recordings/CA1")
check("playback 409 no keys", r.status_code == 409, r.status_code)
platform_settings.get_group = lambda group: dict(KEYS) if group == "voice" else {}

fetched = {}
def fake_fetch(keys, url):
    fetched["url"] = url
    fetched["sid"] = keys["account_sid"]
    return b"MP3BYTES"
portal_voice._twilio_fetch_media = fake_fetch
conn = install_db_stub(portal_voice,
                       [[{"recording_url": "https://api.twilio.com/RE1"}]])
r = client.get("/api/v1/portal/voice/recordings/CA1")
check("playback 200 audio", r.status_code == 200
      and "audio" in r.content_type
      and r.get_data(as_text=True) == "MP3BYTES", r.content_type)
check("playback media mp3", portal_voice._media_url("https://api.twilio.com/RE1").endswith(".mp3")
      and fetched["url"] == "https://api.twilio.com/RE1"
      and fetched["sid"] == "AC1", fetched)
check("playback lookup scoped", any(
    "client_id = %s OR direction = 'inbound'" in e[0]
    for e in conn.cur.executed), "sql")

print("== app wiring ==")

APP = open("./app.py", encoding="utf8").read()
check("app registers voice public bp",
      "from portal_voice import bp as portal_voice_bp" in APP
      and "portal_voice_public_bp" in APP, "wiring")

print("== website surface (vs /tmp/p13) ==")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
check("client voiceRecordingPath", "export function voiceRecordingPath(" in PORTAL, "path")
check("client fetchVoiceRecording", "export async function fetchVoiceRecording(" in PORTAL, "fetch")
check("client voicecall fields", 'direction: row.direction === "inbound"' in PORTAL
      and "has_recording === true" in PORTAL, "fields")

CARD = read("app/dashboard/(portal)/conversations/[id]/VoiceCard.tsx")
check("card recording player", "hasRecording" in CARD
      and "/api/omniflow/portal/voice/recordings/" in CARD
      and "<audio" in CARD, "player")
check("card direction badge", '"In" : "Out"' in CARD, "badge")

BFF = read("app/api/omniflow/portal/voice/recordings/[sid]/route.ts")
check("recording bff", "fetchVoiceRecording" in BFF
      and '"../../../../../../../lib/omniflow/portal"' in BFF, "7 ups")

summary("voice_inbound")
