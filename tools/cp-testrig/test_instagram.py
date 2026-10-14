"""Deterministic contract checks for the Instagram adapter.

These checks stay provider-free: Graph calls and the database are not touched.
The route suite can additionally stub portal_instagram._meta_request and use
Flask's test client in a deployment test run.
"""

import hashlib
import hmac
import json

import portal_instagram
from test_lib import check, summary


print("== Instagram pure adapter contracts ==")

payload = {
    "object": "instagram",
    "entry": [{
        "id": "1789001",
        "messaging": [
            {
                "sender": {"id": "441", "name": "Ayesha"},
                "recipient": {"id": "1789001"},
                "timestamp": 1700000000000,
                "message": {"mid": "mid-text", "text": "Assalam o alaikum"},
            },
            {
                "sender": {"id": "441"},
                "recipient": {"id": "1789001"},
                "message": {"mid": "mid-media", "attachments": [{
                    "type": "image",
                    "payload": {"url": "https://cdn.example/image.jpg"},
                }]},
            },
            {
                "sender": {"id": "441"},
                "recipient": {"id": "1789001"},
                "postback": {"title": "Track order", "payload": "track"},
            },
            {
                "sender": {"id": "1789001"},
                "recipient": {"id": "441"},
                "message": {"mid": "echo", "text": "echo", "is_echo": True},
            },
        ],
    }],
}

events = portal_instagram.normalize_instagram_events(payload)
check("text/media/postback count", len(events) == 3, events)
check("Instagram contact canonical id", events[0]["from"] == "ig:441", events[0])
check("provider id retained", events[0]["id"] == "mid-text", events[0])
check("media normalized", events[1]["media"][0]["url"].startswith("https://"), events[1])
check("postback normalized", events[2]["postback"]["payload"] == "track", events[2])
check("echo ignored", all(row["id"] != "echo" for row in events), events)

raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
signature = hmac.new(b"app-secret", raw, hashlib.sha256).hexdigest()
check("Meta signature accepts valid digest", portal_instagram.verify_meta_signature(
    raw, "sha256=" + signature, "app-secret"
), "signature")
check("Meta signature rejects body replay", not portal_instagram.verify_meta_signature(
    raw + b"x", "sha256=" + signature, "app-secret"
), "signature")
check("Meta signature rejects sha1", not portal_instagram.verify_meta_signature(
    raw, "sha1=" + signature, "app-secret"
), "signature")

text_command = {
    "payload": {"external_user_id": "ig:441", "body": "Your order is ready"}
}
graph = portal_instagram._outbound_graph_payload("send_message", text_command, "1789001")
check("Graph recipient unwrapped", graph["recipient"]["id"] == "441", graph)
check("Graph text contract", graph["message"]["text"] == "Your order is ready", graph)

interactive = portal_instagram._outbound_graph_payload("send_interactive", {
    "payload": {
        "external_user_id": "ig:441",
        "body": "Choose one",
        "interactive": {"quick_replies": [{"title": "Track", "payload": "track"}]},
    }
}, "1789001")
check("Graph quick reply contract", interactive["message"]["quick_replies"][0]["content_type"] == "text", interactive)

media = portal_instagram._outbound_graph_payload("send_media", {
    "payload": {
        "external_user_id": "ig:441",
        "kind": "image",
        "media_url": "https://cdn.example/image.jpg",
    }
}, "1789001")
check("Graph media attachment contract", media["message"]["attachment"]["payload"]["url"].startswith("https://"), media)

summary("instagram")
