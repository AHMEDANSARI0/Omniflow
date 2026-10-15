import argparse
import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor


PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(PROJECT_ROOT / ".env")

CONFIRMATION_TEXT = "BACKFILL_AS_CANCELLED"


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
            "Safely classify and backfill historical inbound messages that "
            "predate durable reply jobs"
        )
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True
    )

    for command in ("plan", "verify"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument(
            "channel_account_id",
            type=int
        )

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument(
        "channel_account_id",
        type=int
    )
    apply_parser.add_argument(
        "--confirm",
        required=True,
        help=(
            f"Required exact value: {CONFIRMATION_TEXT}"
        )
    )

    arguments = parser.parse_args()

    if arguments.channel_account_id <= 0:
        parser.error(
            "channel_account_id must be positive"
        )

    if (
        arguments.command == "apply"
        and arguments.confirm != CONFIRMATION_TEXT
    ):
        parser.error(
            f"--confirm must equal {CONFIRMATION_TEXT}"
        )

    return arguments


def ensure_account_and_no_live_lease(
    cursor,
    channel_account_id
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
    lease = cursor.fetchone()

    if lease is not None:
        raise RuntimeError(
            "Repair blocked: account is owned by "
            f"{lease['worker_id']} until {lease['lease_expires_at']}"
        )

    return account


def load_missing_rows(
    cursor,
    channel_account_id
):
    cursor.execute(
        """
        SELECT
            inbound.id AS inbound_message_id,
            inbound.external_message_id,
            inbound.created_at,
            LEFT(inbound.content, 120) AS inbound_preview,
            cc.external_user_id,
            response.id AS assistant_message_id,
            LEFT(response.content, 120) AS assistant_preview
        FROM messages inbound
        JOIN conversations cv
          ON cv.id = inbound.conversation_id
        JOIN channel_contacts cc
          ON cc.id = cv.channel_contact_id
        LEFT JOIN message_reply_jobs existing_job
          ON existing_job.inbound_message_id = inbound.id
        LEFT JOIN LATERAL (
            SELECT
                candidate.id,
                candidate.content
            FROM messages candidate
            WHERE candidate.conversation_id
                = inbound.conversation_id
              AND candidate.role = 'assistant'
              AND candidate.id > inbound.id
              AND candidate.id < COALESCE(
                  (
                      SELECT MIN(next_user.id)
                      FROM messages next_user
                      WHERE next_user.conversation_id
                          = inbound.conversation_id
                        AND next_user.role = 'user'
                        AND next_user.id > inbound.id
                  ),
                  9223372036854775807
              )
            ORDER BY candidate.id
            LIMIT 1
        ) response ON TRUE
        WHERE cc.channel_account_id = %s
          AND inbound.role = 'user'
          AND inbound.external_message_id IS NOT NULL
          AND existing_job.id IS NULL
        ORDER BY inbound.id
        """,
        (channel_account_id,)
    )
    return [
        dict(row)
        for row in cursor.fetchall()
    ]


def print_plan(account, rows):
    print("\nLEGACY REPLY-JOB BACKFILL PLAN")
    print(f"Channel account: {account['id']}")
    print(f"Client: {account['client_id']}")
    print(f"Platform: {account['platform']}")
    print(f"Account name: {account['account_name']}")
    print(f"Missing reply jobs: {len(rows)}\n")

    for row in rows:
        classification = (
            "LEGACY_ANSWERED"
            if row["assistant_message_id"] is not None
            else "UNANSWERED_REVIEW_REQUIRED"
        )
        print(
            f"Inbound {row['inbound_message_id']} | "
            f"external={row['external_message_id']} | "
            f"contact={row['external_user_id']} | "
            f"created={row['created_at']}"
        )
        print(f"  classification={classification}")
        print(f"  inbound={row['inbound_preview']}")
        print(
            "  assistant="
            f"{row['assistant_preview']}"
        )

    answered = sum(
        1
        for row in rows
        if row["assistant_message_id"] is not None
    )
    unanswered = len(rows) - answered
    print("\nPLAN SUMMARY")
    print(f"Legacy answered: {answered}")
    print(f"Unanswered/review required: {unanswered}")
    print(
        "Planned action: insert cancelled ledger jobs only for "
        "LEGACY_ANSWERED rows"
    )
    print("Customer messages to send: 0")
    print("AI calls: 0")

    return answered, unanswered


def command_plan(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                account = ensure_account_and_no_live_lease(
                    cursor,
                    channel_account_id
                )
                rows = load_missing_rows(
                    cursor,
                    channel_account_id
                )
                print_plan(account, rows)

    finally:
        conn.close()


def ensure_cancelled_status_supported(cursor):
    cursor.execute(
        """
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'message_reply_jobs'::regclass
          AND contype = 'c'
        """
    )
    definitions = [
        str(row["definition"] or "")
        for row in cursor.fetchall()
    ]
    status_definitions = [
        definition
        for definition in definitions
        if "status" in definition.lower()
    ]

    if status_definitions and not any(
        "cancelled" in definition.lower()
        for definition in status_definitions
    ):
        raise RuntimeError(
            "message_reply_jobs status constraint does not support "
            "cancelled; no rows were changed"
        )


def command_apply(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                account = ensure_account_and_no_live_lease(
                    cursor,
                    channel_account_id
                )
                rows = load_missing_rows(
                    cursor,
                    channel_account_id
                )
                answered, unanswered = print_plan(
                    account,
                    rows
                )

                if not rows:
                    print("\nNothing to repair")
                    return

                if unanswered:
                    raise RuntimeError(
                        "Repair aborted: at least one missing-job inbound "
                        "has no assistant response and requires manual review"
                    )

                ensure_cancelled_status_supported(
                    cursor
                )

                cursor.execute(
                    """
                    INSERT INTO message_reply_jobs (
                        inbound_message_id,
                        status,
                        reply_text,
                        last_error,
                        next_attempt_at
                    )
                    SELECT
                        inbound.id,
                        'cancelled',
                        response.content,
                        (
                            'Legacy answered inbound backfilled as cancelled; '
                            'outbound provider ID predates durable tracking'
                        ),
                        CURRENT_TIMESTAMP
                    FROM messages inbound
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    LEFT JOIN message_reply_jobs existing_job
                      ON existing_job.inbound_message_id = inbound.id
                    JOIN LATERAL (
                        SELECT candidate.content
                        FROM messages candidate
                        WHERE candidate.conversation_id
                            = inbound.conversation_id
                          AND candidate.role = 'assistant'
                          AND candidate.id > inbound.id
                          AND candidate.id < COALESCE(
                              (
                                  SELECT MIN(next_user.id)
                                  FROM messages next_user
                                  WHERE next_user.conversation_id
                                      = inbound.conversation_id
                                    AND next_user.role = 'user'
                                    AND next_user.id > inbound.id
                              ),
                              9223372036854775807
                          )
                        ORDER BY candidate.id
                        LIMIT 1
                    ) response ON TRUE
                    WHERE cc.channel_account_id = %s
                      AND inbound.role = 'user'
                      AND inbound.external_message_id IS NOT NULL
                      AND existing_job.id IS NULL
                    ON CONFLICT (inbound_message_id)
                    DO NOTHING
                    RETURNING id, inbound_message_id
                    """,
                    (channel_account_id,)
                )
                inserted = cursor.fetchall()

                if len(inserted) != answered:
                    raise RuntimeError(
                        "Backfill count changed during transaction: "
                        f"planned={answered}, inserted={len(inserted)}"
                    )

                remaining = load_missing_rows(
                    cursor,
                    channel_account_id
                )

                if remaining:
                    raise RuntimeError(
                        f"Backfill incomplete: {len(remaining)} rows remain"
                    )

                print("\nBACKFILL RESULT")
                print(f"Cancelled ledger jobs inserted: {len(inserted)}")
                print("Customer messages sent: 0")
                print("AI calls: 0")
                print("Remaining missing jobs: 0")
                print("\n✅ LEGACY REPLY JOB BACKFILL PASSED")

    finally:
        conn.close()


def command_verify(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                account = ensure_account_and_no_live_lease(
                    cursor,
                    channel_account_id
                )
                rows = load_missing_rows(
                    cursor,
                    channel_account_id
                )
                print(f"Channel account: {account['id']}")
                print(f"Remaining missing reply jobs: {len(rows)}")

                cursor.execute(
                    """
                    SELECT job.status, COUNT(*) AS count
                    FROM message_reply_jobs job
                    JOIN messages inbound
                      ON inbound.id = job.inbound_message_id
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                    GROUP BY job.status
                    ORDER BY job.status
                    """,
                    (channel_account_id,)
                )
                distribution = {
                    row["status"]: row["count"]
                    for row in cursor.fetchall()
                }
                print(f"Reply job distribution: {distribution}")

                if rows:
                    raise RuntimeError(
                        "Reply-job invariant is still incomplete"
                    )

                print("Customer messages sent: 0")
                print("\n✅ LEGACY REPLY JOB BACKFILL VERIFIED")

    finally:
        conn.close()


def main():
    arguments = parse_arguments()

    if arguments.command == "plan":
        command_plan(arguments.channel_account_id)
    elif arguments.command == "apply":
        command_apply(arguments.channel_account_id)
    elif arguments.command == "verify":
        command_verify(arguments.channel_account_id)
    else:
        raise RuntimeError(
            f"Unsupported command: {arguments.command}"
        )


if __name__ == "__main__":
    main()
