import hashlib
import json
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
SESSION = ROOT / "whatsapp_sessions" / "account_1"
REPORT = ROOT / "whatsapp_dom_burst_diagnostic.json"
MARKERS = ("A6", "B6", "C6")

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from whatsapp import WhatsAppBot  # noqa: E402


def short_hash(value):
    value = str(value or "").strip()
    if not value:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def marker_from_text(value):
    value = str(value or "").strip()
    return value if value in MARKERS else "OTHER"


def capture_snapshot(bot, elapsed_seconds):
    parsed = bot.get_visible_chat_messages(limit=100)
    raw_texts = bot.page.locator(
        "#main span.selectable-text"
    ).all_inner_texts()

    raw_marker_counts = {
        marker: sum(
            1
            for text in raw_texts
            if str(text or "").strip() == marker
        )
        for marker in MARKERS
    }

    parsed_markers = []
    direction_counts = {
        "inbound": 0,
        "outbound": 0,
        "unknown": 0,
    }
    outbound_positions = []

    for position, message in enumerate(parsed, start=1):
        direction = str(
            message.get("direction") or "unknown"
        ).lower()
        if direction not in direction_counts:
            direction = "unknown"
        direction_counts[direction] += 1

        if direction == "outbound":
            outbound_positions.append(position)

        marker = marker_from_text(message.get("text"))
        if marker != "OTHER":
            parsed_markers.append(
                {
                    "position": position,
                    "marker": marker,
                    "direction": direction,
                    "message_id_hash": short_hash(
                        message.get("id")
                    ),
                    "chat_identifier_hash": short_hash(
                        message.get("chat_identifier")
                    ),
                }
            )

    return {
        "elapsed_seconds": round(elapsed_seconds, 2),
        "dom_message_containers": bot.page.locator(
            "#main [data-testid='msg-container']"
        ).count(),
        "parsed_message_count": len(parsed),
        "raw_marker_counts": raw_marker_counts,
        "parsed_markers": parsed_markers,
        "direction_counts": direction_counts,
        "last_outbound_position": (
            outbound_positions[-1]
            if outbound_positions
            else None
        ),
    }


def snapshot_signature(snapshot):
    comparable = dict(snapshot)
    comparable.pop("elapsed_seconds", None)
    return json.dumps(
        comparable,
        sort_keys=True,
        separators=(",", ":"),
    )


def print_snapshot(snapshot):
    raw = snapshot["raw_marker_counts"]
    parsed_markers = [
        (
            f"{item['marker']}@{item['position']}:"
            f"{item['direction']}:"
            f"{item['message_id_hash']}"
        )
        for item in snapshot["parsed_markers"]
    ]

    print(
        "Snapshot "
        f"t={snapshot['elapsed_seconds']:.2f}s | "
        f"containers={snapshot['dom_message_containers']} | "
        f"parsed={snapshot['parsed_message_count']} | "
        f"raw_markers=A6:{raw['A6']},B6:{raw['B6']},C6:{raw['C6']} | "
        f"parsed_markers={parsed_markers or ['NONE']} | "
        f"directions={snapshot['direction_counts']} | "
        f"last_outbound={snapshot['last_outbound_position']}"
    )


def main():
    if not SESSION.is_dir():
        raise RuntimeError(
            f"Account 1 session directory is missing: {SESSION}"
        )

    print("WhatsApp DOM burst diagnostic")
    print("Mode: browser observation only; no DB, AI, or outbound messages")
    print(f"Session: {SESSION}")
    print("Markers: A6, B6, C6")
    print()

    bot = WhatsAppBot(str(SESSION))
    snapshots = []
    raw_seen = set()
    parsed_seen = set()

    try:
        bot.start()
        bot.open_whatsapp("https://web.whatsapp.com")

        input(
            "In the opened WhatsApp Web window, click a different chat "
            "so the test-phone chat is NOT active. Ensure there are no "
            "other unread chats, then return here and press Enter..."
        )

        print(
            "Now send A6, B6, and C6 rapidly as three separate messages "
            "from the test phone. Waiting up to 90 seconds..."
        )

        unread_chat = None
        deadline = time.monotonic() + 90.0

        while time.monotonic() < deadline:
            unread_chat = bot.find_unread_chat()
            if unread_chat is not None:
                break
            bot.page.wait_for_timeout(250)

        if unread_chat is None:
            raise RuntimeError(
                "No unread chat was detected within 90 seconds"
            )

        detected_count = bot.last_unread_count
        print(f"Unread detected with reported count={detected_count}")

        if not bot.open_chat(unread_chat):
            raise RuntimeError("Unread chat could not be opened")

        print("Capturing changed DOM snapshots for 20 seconds...")
        started = time.monotonic()
        last_signature = None

        while time.monotonic() - started < 20.0:
            elapsed = time.monotonic() - started
            snapshot = capture_snapshot(bot, elapsed)

            for marker, count in snapshot[
                "raw_marker_counts"
            ].items():
                if count:
                    raw_seen.add(marker)

            for item in snapshot["parsed_markers"]:
                parsed_seen.add(item["marker"])

            signature = snapshot_signature(snapshot)
            if signature != last_signature:
                snapshots.append(snapshot)
                print_snapshot(snapshot)
                last_signature = signature

            bot.page.wait_for_timeout(400)

        report = {
            "markers": list(MARKERS),
            "unread_reported_count": detected_count,
            "raw_markers_seen": sorted(raw_seen),
            "parsed_markers_seen": sorted(parsed_seen),
            "snapshots": snapshots,
            "privacy_note": (
                "Non-marker chat text is excluded. Message and chat IDs "
                "are represented only by 12-character SHA-256 hashes."
            ),
        }
        REPORT.write_text(
            json.dumps(report, indent=2),
            encoding="utf-8"
        )

        print()
        print(f"Raw markers seen: {sorted(raw_seen)}")
        print(f"Parsed markers seen: {sorted(parsed_seen)}")
        print(f"Diagnostic report: {REPORT}")

        direction_boundary_ready = any(
            {
                item["marker"]
                for item in snapshot["parsed_markers"]
                if item["direction"] == "inbound"
            } == set(MARKERS)
            and snapshot["last_outbound_position"] is not None
            for snapshot in snapshots
        )

        if direction_boundary_ready:
            print(
                "RESULT: All three markers are parsed as inbound and a prior "
                "outbound boundary is detected. Direction classification is "
                "ready for the controlled live worker test."
            )
        elif raw_seen == set(MARKERS) and parsed_seen == set(MARKERS):
            print(
                "RESULT: The DOM and parser exposed all three markers, but "
                "direction/boundary classification is still incomplete. Do "
                "not launch the worker yet."
            )
        elif raw_seen == set(MARKERS):
            print(
                "RESULT: The DOM exposed all three markers, but the parser "
                "missed at least one. The DOM extraction layer is the fault."
            )
        else:
            print(
                "RESULT: The current DOM selector did not expose all three "
                "markers during the capture window. A DOM/store ingestion "
                "fallback is required."
            )

    finally:
        try:
            bot.stop()
        except Exception as error:
            print(f"Browser cleanup warning: {error}")


if __name__ == "__main__":
    main()
 