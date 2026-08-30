from pathlib import Path
import py_compile
import shutil


ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / "src" / "channels" / "whatsapp_web.py"
BURST_TEST = ROOT / "test_whatsapp_burst_adapter.py"

OLD_ADAPTER = '''            if unread_limit is not None:
                try:
                    unread_limit = max(
                        1,
                        int(unread_limit)
                    )
                except (TypeError, ValueError):
                    unread_limit = 1

                inbound_candidates = [
                    message
                    for message in unseen_candidates
                    if message.get(
                        "direction",
                        "unknown"
                    ) != "outbound"
                ]
                candidates = inbound_candidates[
                    -unread_limit:
                ]
            else:
                # For a manually opened/new chat with no prior cursor, preserve
                # startup safety by considering only the newest unseen message.
                candidates = unseen_candidates[-1:]
'''

NEW_ADAPTER = '''            if unread_limit is not None:
                try:
                    unread_limit = max(
                        1,
                        int(unread_limit)
                    )
                except (TypeError, ValueError):
                    unread_limit = 1

                # WhatsApp's sidebar sometimes exposes only a binary unread
                # dot and reports count=1 even when several messages arrived.
                # In a chat with prior replies, every unseen inbound container
                # after the newest outbound container belongs to the current
                # unanswered burst. This is safer and more complete than
                # trusting the badge count. Database external-ID idempotency is
                # still the durable guard if a previously handled message is
                # present in the visible snapshot.
                last_outbound_index = None

                for index, message in enumerate(
                    normalized_visible
                ):
                    if message.get(
                        "direction",
                        "unknown"
                    ) == "outbound":
                        last_outbound_index = index

                burst_candidates = []

                if last_outbound_index is not None:
                    burst_candidates = [
                        message
                        for message in normalized_visible[
                            last_outbound_index + 1:
                        ]
                        if (
                            message.get("id")
                            not in self.seen_message_ids
                            and message.get(
                                "direction",
                                "unknown"
                            ) != "outbound"
                        )
                    ]

                if burst_candidates:
                    candidates = burst_candidates
                else:
                    inbound_candidates = [
                        message
                        for message in unseen_candidates
                        if message.get(
                            "direction",
                            "unknown"
                        ) != "outbound"
                    ]
                    candidates = inbound_candidates[
                        -unread_limit:
                    ]
            else:
                # For a manually opened/new chat with no prior cursor, preserve
                # startup safety by considering only the newest unseen message.
                candidates = unseen_candidates[-1:]
'''

OLD_TEST_FIXTURE = '''    bot.pending_unread_chat = {
        "chat_name": "Unread Burst Customer",
        "unread_count": 3,
        "visible_messages": [
            bot.message(
                "unread-history",
                "lid:unread-customer",
                "Old history",
            ),
            bot.message(
                "unread-1",
                "lid:unread-customer",
                "U1",
            ),
'''

NEW_TEST_FIXTURE = '''    bot.pending_unread_chat = {
        "chat_name": "Unread Burst Customer",
        # Reproduce the live WhatsApp behavior: the UI reports a binary unread
        # count of 1 even though three new messages follow the prior outbound.
        "unread_count": 1,
        "visible_messages": [
            bot.message(
                "unread-history",
                "lid:unread-customer",
                "Old history",
            ),
            bot.message(
                "prior-outbound",
                "lid:unread-customer",
                "Previous bot reply",
                direction="outbound",
            ),
            bot.message(
                "unread-1",
                "lid:unread-customer",
                "U1",
            ),
'''

OLD_TEST_OUTPUT = '''    print("Unread-chat rapid messages captured in order: 3/3")
    print("Outbound DOM messages skipped: 1")
'''

NEW_TEST_OUTPUT = '''    print("Unread-chat rapid messages captured in order: 3/3")
    print("Binary unread count=1 expanded via unanswered burst: 3/3")
    print("Outbound DOM messages skipped: 1")
'''


def prepare(path, replacements, label):
    if not path.is_file():
        raise RuntimeError(f"Missing required file: {path}")

    original = path.read_text(encoding="utf-8")
    updated = original
    changes = 0

    for old_text, new_text in replacements:
        if new_text in updated:
            continue

        count = updated.count(old_text)
        if count != 1:
            raise RuntimeError(
                f"{label}: expected one supported old block, found {count}. "
                "No files were changed."
            )

        updated = updated.replace(old_text, new_text, 1)
        changes += 1

    return {
        "path": path,
        "label": label,
        "original": original,
        "updated": updated,
        "changes": changes,
    }


def install(plans):
    written = []

    try:
        for plan in plans:
            path = plan["path"]

            if not plan["changes"]:
                print(f"{plan['label']}: already installed")
                continue

            backup = path.with_suffix(
                path.suffix + ".pre_gold_burst.bak"
            )
            if not backup.exists():
                shutil.copy2(path, backup)

            temporary = path.with_suffix(path.suffix + ".gold_burst.tmp")
            temporary.write_text(plan["updated"], encoding="utf-8")
            temporary.replace(path)
            written.append(plan)

            print(f"{plan['label']}: installed")
            print(f"  backup: {backup}")

        py_compile.compile(str(ADAPTER), doraise=True)
        py_compile.compile(str(BURST_TEST), doraise=True)

    except Exception:
        for plan in reversed(written):
            plan["path"].write_text(
                plan["original"],
                encoding="utf-8"
            )
        raise


def main():
    print("GOLD unread-burst patch")
    print(f"Project root: {ROOT}")

    # Validate every expected block before changing either file.
    plans = [
        prepare(
            ADAPTER,
            [(OLD_ADAPTER, NEW_ADAPTER)],
            "WhatsApp adapter"
        ),
        prepare(
            BURST_TEST,
            [
                (OLD_TEST_FIXTURE, NEW_TEST_FIXTURE),
                (OLD_TEST_OUTPUT, NEW_TEST_OUTPUT),
            ],
            "Unread burst regression"
        ),
    ]

    install(plans)

    print("Compile checks: passed")
    print("\nRun these tests now:")
    print("  python test_whatsapp_adapter.py")
    print("  python test_whatsapp_burst_adapter.py")
    print("\nPATCH INSTALLED SUCCESSFULLY")


if __name__ == "__main__":
    main()