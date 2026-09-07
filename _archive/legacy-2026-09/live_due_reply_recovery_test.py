import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json


PROJECT_ROOT = Path(__file__).resolve().parent
STATE_PATH = PROJECT_ROOT / ".live_due_reply_recovery_state.json"

load_dotenv(PROJECT_ROOT / ".env")


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            "Prepare, verify, or clean a controlled live due-reply "
            "recovery test"
        )
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True
    )

    prepare_parser = subparsers.add_parser(
        "prepare",
        help="Create one persisted reply-ready job"
    )
    prepare_parser.add_argument(
        "--channel-account-id",
        type=int,
        required=True
    )
    prepare_parser.add_argument(
        "--external-user-id",
        default=None,
        help=(
            "Stable target identity. If omitted, the most recently updated "
            "active contact for the account is selected."
        ),
    )

    set_name_parser = subparsers.add_parser(
        "set-display-name",
        help=(
            "Set the exact WhatsApp-visible target name as a routing hint; "
            "stable JID/LID verification is still mandatory"
        )
    )
    set_name_parser.add_argument(
        "--display-name",
        required=True,
        help="Exact name visible in the WhatsApp chat header/sidebar",
    )

    subparsers.add_parser(
        "verify",
        help="Verify that the runtime delivered and marked the test job sent"
    )
    subparsers.add_parser(
        "cleanup",
        help="Delete only rows created by this controlled test"
    )

    return parser.parse_args()


def ensure_no_existing_state():
    if STATE_PATH.exists():
        raise RuntimeError(
            f"Test state already exists at {STATE_PATH}. Run cleanup first."
        )


def ensure_account_is_not_leased(cursor, channel_account_id):
    cursor.execute(
        """
        SELECT worker_id, lease_expires_at
        FROM channel_account_leases
        WHERE channel_account_id = %s
          AND owner_token IS NOT NULL
          AND lease_expires_at > CURRENT_TIMESTAMP
        """,
        (channel_account_id,)
    )
    live_lease = cursor.fetchone()

    if live_lease is not None:
        raise RuntimeError(
            "Preparation blocked: channel account is owned by "
            f"{live_lease[0]} until {live_lease[1]}. Stop workers first."
        )


def resolve_target(
    cursor,
    channel_account_id,
    external_user_id
):
    cursor.execute(
        """
        SELECT id, client_id, platform, account_name, status
        FROM channel_accounts
        WHERE id = %s
        """,
        (channel_account_id,)
    )
    account = cursor.fetchone()

    if account is None:
        raise RuntimeError(
            f"Channel account {channel_account_id} does not exist"
        )

    if str(account[4]).lower() != "active":
        raise RuntimeError(
            f"Channel account {channel_account_id} is not active"
        )

    cursor.execute(
        """
        SELECT
            cc.id,
            cc.external_user_id,
            cc.display_name,
            cv.id
        FROM channel_contacts cc
        JOIN conversations cv
          ON cv.channel_contact_id = cc.id
        WHERE cc.channel_account_id = %s
          AND cc.status = 'active'
          AND (
              %s IS NULL
              OR cc.external_user_id = %s
          )
        ORDER BY cv.updated_at DESC, cc.id DESC
        LIMIT 1
        """,
        (
            channel_account_id,
            external_user_id,
            external_user_id,
        )
    )
    contact = cursor.fetchone()

    if contact is None:
        raise RuntimeError(
            "No matching active channel contact/conversation was found"
        )

    return {
        "channel_account_id": account[0],
        "client_id": account[1],
        "platform": account[2],
        "account_name": account[3],
        "channel_contact_id": contact[0],
        "external_user_id": contact[1],
        "display_name": contact[2],
        "conversation_id": contact[3],
    }


def prepare(arguments):
    ensure_no_existing_state()

    if arguments.channel_account_id <= 0:
        raise ValueError(
            "--channel-account-id must be positive"
        )

    external_user_id = (
        str(arguments.external_user_id).strip()
        if arguments.external_user_id is not None
        else None
    )

    if external_user_id == "":
        external_user_id = None

    token = uuid4().hex[:12]
    external_message_id = (
        f"live-due-recovery-{token}"
    )
    inbound_content = (
        f"[SIMULATED CRASH RECOVERY {token}]"
    )
    reply_text = (
        "Automatic recovery test passed. This text was delivered from a "
        "persisted reply job without a new inbound WhatsApp message."
    )
    metadata = {
        "live_due_reply_recovery_test": token,
        "simulated_crash": True,
    }

    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                ensure_account_is_not_leased(
                    cursor,
                    arguments.channel_account_id
                )
                target = resolve_target(
                    cursor,
                    arguments.channel_account_id,
                    external_user_id
                )

                cursor.execute(
                    """
                    INSERT INTO messages (
                        conversation_id,
                        role,
                        content,
                        external_message_id,
                        direction,
                        message_type,
                        metadata
                    )
                    VALUES (
                        %s,
                        'user',
                        %s,
                        %s,
                        'inbound',
                        'text',
                        %s
                    )
                    RETURNING id
                    """,
                    (
                        target["conversation_id"],
                        inbound_content,
                        external_message_id,
                        Json(metadata),
                    )
                )
                inbound_message_id = cursor.fetchone()[0]

                cursor.execute(
                    """
                    INSERT INTO message_reply_jobs (
                        inbound_message_id,
                        status,
                        reply_text,
                        next_attempt_at
                    )
                    VALUES (
                        %s,
                        'reply_ready',
                        %s,
                        CURRENT_TIMESTAMP
                    )
                    RETURNING id
                    """,
                    (
                        inbound_message_id,
                        reply_text,
                    )
                )
                reply_job_id = cursor.fetchone()[0]

                assistant_metadata = dict(metadata)
                assistant_metadata[
                    "source_platform"
                ] = target["platform"]
                assistant_metadata[
                    "recovered_reply_job"
                ] = True

                cursor.execute(
                    """
                    INSERT INTO messages (
                        conversation_id,
                        role,
                        content,
                        direction,
                        message_type,
                        metadata
                    )
                    VALUES (
                        %s,
                        'assistant',
                        %s,
                        'outbound',
                        'text',
                        %s
                    )
                    RETURNING id
                    """,
                    (
                        target["conversation_id"],
                        reply_text,
                        Json(assistant_metadata),
                    )
                )
                assistant_message_id = cursor.fetchone()[0]

    finally:
        conn.close()

    state = {
        "token": token,
        "channel_account_id": target[
            "channel_account_id"
        ],
        "client_id": target["client_id"],
        "platform": target["platform"],
        "external_user_id": target[
            "external_user_id"
        ],
        "display_name": target["display_name"],
        "conversation_id": target[
            "conversation_id"
        ],
        "inbound_message_id": inbound_message_id,
        "assistant_message_id": assistant_message_id,
        "reply_job_id": reply_job_id,
        "external_message_id": external_message_id,
        "reply_text": reply_text,
    }
    STATE_PATH.write_text(
        json.dumps(state, indent=2),
        encoding="utf-8"
    )

    print("Controlled reply-ready job created")
    print(
        f"Channel account: {state['channel_account_id']}"
    )
    print(f"Client: {state['client_id']}")
    print(f"Platform: {state['platform']}")
    print(
        f"External user: {state['external_user_id']}"
    )
    print(
        f"Display name: {state['display_name']}"
    )
    print(f"Reply job: {state['reply_job_id']}")
    print("Initial status: reply_ready")
    print("AI calls required: 0")
    print(f"State file: {STATE_PATH}")
    print(
        "\nDo not send a WhatsApp message. Start only the single leased "
        f"worker with: python run_channel.py {state['channel_account_id']}"
    )


def load_state():
    if not STATE_PATH.exists():
        raise RuntimeError(
            f"Test state does not exist: {STATE_PATH}"
        )

    return json.loads(
        STATE_PATH.read_text(encoding="utf-8")
    )


def set_display_name(arguments):
    state = load_state()
    display_name = str(
        arguments.display_name or ""
    ).strip()

    if not display_name:
        raise ValueError(
            "--display-name cannot be empty"
        )

    if len(display_name) > 255:
        raise ValueError(
            "--display-name cannot exceed 255 characters"
        )

    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE channel_contacts
                    SET
                        display_name = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE channel_account_id = %s
                      AND external_user_id = %s
                    """,
                    (
                        display_name,
                        state["channel_account_id"],
                        state["external_user_id"],
                    )
                )

                if cursor.rowcount != 1:
                    raise RuntimeError(
                        "Target channel contact could not be updated"
                    )

    finally:
        conn.close()

    state["display_name"] = display_name
    STATE_PATH.write_text(
        json.dumps(state, indent=2),
        encoding="utf-8"
    )

    print("Recovery routing display name updated")
    print(
        f"Channel account: {state['channel_account_id']}"
    )
    print(
        f"External user: {state['external_user_id']}"
    )
    print(f"Display name: {display_name}")
    print(
        "Stable JID/LID verification remains required before delivery"
    )


def verify():
    state = load_state()
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        status,
                        attempt_count,
                        outbound_external_message_id,
                        last_error,
                        sent_at
                    FROM message_reply_jobs
                    WHERE id = %s
                      AND inbound_message_id = %s
                    """,
                    (
                        state["reply_job_id"],
                        state["inbound_message_id"],
                    )
                )
                row = cursor.fetchone()

    finally:
        conn.close()

    if row is None:
        raise RuntimeError(
            "Controlled reply job no longer exists"
        )

    status, attempts, outbound_id, last_error, sent_at = row

    print(f"Reply job: {state['reply_job_id']}")
    print(f"Status: {status}")
    print(f"Attempts: {attempts}")
    print(f"Outbound external message ID: {outbound_id}")
    print(f"Last error: {last_error}")
    print(f"Sent at: {sent_at}")

    assert status == "sent"
    assert attempts >= 1
    assert outbound_id is not None
    assert last_error is None
    assert sent_at is not None

    print("Inbound WhatsApp event replay required: 0")
    print("AI generation calls required: 0")
    print("Cached persisted reply delivered: 1")
    print(
        "Delivery attempts include safe identity-routing retries: "
        f"{attempts}"
    )
    print(
        "\n✅ LIVE DUE REPLY RECOVERY VERIFIED"
    )


def cleanup():
    state = load_state()
    token = state["token"]
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM message_reply_jobs
                    WHERE inbound_message_id IN (
                        SELECT id
                        FROM messages
                        WHERE metadata->>'live_due_reply_recovery_test' = %s
                    )
                    """,
                    (token,)
                )
                deleted_jobs = cursor.rowcount

                cursor.execute(
                    """
                    DELETE FROM messages
                    WHERE metadata->>'live_due_reply_recovery_test' = %s
                    """,
                    (token,)
                )
                deleted_messages = cursor.rowcount

    finally:
        conn.close()

    STATE_PATH.unlink(missing_ok=True)

    print(f"Deleted reply jobs: {deleted_jobs}")
    print(f"Deleted messages: {deleted_messages}")
    print("Controlled live recovery rows cleaned up")


def main():
    arguments = parse_arguments()

    if arguments.command == "prepare":
        prepare(arguments)
    elif arguments.command == "set-display-name":
        set_display_name(arguments)
    elif arguments.command == "verify":
        verify()
    elif arguments.command == "cleanup":
        cleanup()
    else:
        raise RuntimeError(
            f"Unsupported command: {arguments.command}"
        )


if __name__ == "__main__":
    main()
