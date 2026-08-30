import sys
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from conversation import ConversationManager  # noqa: E402
from memory import Memory  # noqa: E402


RUN_TOKEN = uuid4().hex[:12]
EXTERNAL_USER_ID = f"recovery-user-{RUN_TOKEN}"
FIRST_MESSAGE_ID = f"recovery-first-{RUN_TOKEN}"
SECOND_MESSAGE_ID = f"recovery-stale-{RUN_TOKEN}"


class FakeAI:
    def __init__(self):
        self.calls = 0
        self.prompts = []

    def generate_reply(self, user_content):
        self.calls += 1
        self.prompts.append(user_content)
        assert "Latest customer message" in user_content
        return f"Recovered AI reply {self.calls}"


def load_active_account(memory):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, client_id, platform
                    FROM channel_accounts
                    WHERE status = 'active'
                    ORDER BY id
                    LIMIT 1
                    """
                )
                row = cursor.fetchone()

    finally:
        memory._release_connection(conn)

    if row is None:
        raise RuntimeError(
            "No active channel account exists for recovery test"
        )

    return {
        "id": row[0],
        "client_id": row[1],
        "platform": row[2],
    }


def make_processing_lock_stale(
    memory,
    channel_account_id,
    external_message_id
):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE message_reply_jobs job
                    SET
                        status = 'processing',
                        worker_id = 'simulated-dead-worker',
                        locked_at = (
                            CURRENT_TIMESTAMP
                            - INTERVAL '10 minutes'
                        ),
                        next_attempt_at = CURRENT_TIMESTAMP,
                        attempt_count = 1,
                        updated_at = CURRENT_TIMESTAMP
                    FROM messages inbound
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE job.inbound_message_id = inbound.id
                      AND cc.channel_account_id = %s
                      AND cc.external_user_id = %s
                      AND inbound.external_message_id = %s
                    """,
                    (
                        channel_account_id,
                        EXTERNAL_USER_ID,
                        external_message_id,
                    )
                )

                if cursor.rowcount != 1:
                    raise AssertionError(
                        "Could not create simulated stale processing job"
                    )

    finally:
        memory._release_connection(conn)


def read_results(memory, channel_account_id):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        cc.customer_id,
                        COUNT(DISTINCT m.id),
                        COUNT(DISTINCT job.id),
                        COUNT(*) FILTER (
                            WHERE job.status = 'sent'
                        ),
                        MIN(job.attempt_count),
                        MAX(job.attempt_count)
                    FROM channel_contacts cc
                    JOIN conversations cv
                      ON cv.channel_contact_id = cc.id
                    JOIN messages m
                      ON m.conversation_id = cv.id
                    LEFT JOIN message_reply_jobs job
                      ON job.inbound_message_id = m.id
                    WHERE cc.channel_account_id = %s
                      AND cc.external_user_id = %s
                    GROUP BY cc.customer_id
                    """,
                    (
                        channel_account_id,
                        EXTERNAL_USER_ID,
                    )
                )
                return cursor.fetchone()

    finally:
        memory._release_connection(conn)


def cleanup(memory, channel_account_id, customer_id):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM channel_contacts
                    WHERE channel_account_id = %s
                      AND external_user_id = %s
                    """,
                    (
                        channel_account_id,
                        EXTERNAL_USER_ID,
                    )
                )
                cursor.execute(
                    """
                    DELETE FROM customers
                    WHERE id = %s
                    """,
                    (customer_id,)
                )

    finally:
        memory._release_connection(conn)


def main():
    memory = Memory()
    fake_ai = FakeAI()
    manager = ConversationManager(
        ai=fake_ai,
        memory=memory,
        worker_id="due-recovery-test-worker"
    )
    customer_id = None

    try:
        account = load_active_account(memory)

        # Persist inbound + pending job exactly as an adapter transaction would,
        # but do not replay a ChannelEvent into ConversationManager.
        inserted = memory.save_user_message(
            account["id"],
            EXTERNAL_USER_ID,
            "First persisted inbound after simulated crash",
            external_message_id=FIRST_MESSAGE_ID,
            message_type="text",
            metadata={"test": "due-recovery"},
        )
        assert inserted is True

        generated = manager.recover_due_reply(
            account["id"],
            external_user_id=EXTERNAL_USER_ID
        )
        assert generated is not None
        assert generated.outbound.content == (
            "Recovered AI reply 1"
        )
        assert generated.outbound.metadata[
            "recovered_reply_job"
        ] is True
        assert generated.outbound.metadata[
            "cached_reply"
        ] is False
        assert fake_ai.calls == 1

        first_job_id = generated.outbound.metadata[
            "reply_job_id"
        ]

        # Simulate another crash after generation/persistence but before send.
        # Queue scanning must return the cached text without an inbound replay
        # and without a second provider call.
        cached = manager.recover_due_reply(
            account["id"],
            external_user_id=EXTERNAL_USER_ID
        )
        assert cached is not None
        assert cached.outbound.content == (
            generated.outbound.content
        )
        assert cached.outbound.metadata[
            "cached_reply"
        ] is True
        assert fake_ai.calls == 1

        assert memory.mark_reply_sent(
            first_job_id,
            outbound_external_message_id=(
                f"recovered-outbound-1-{RUN_TOKEN}"
            )
        ) is True

        # Create a second pending job and make it look like a worker died while
        # holding its processing lock. Queue recovery must reclaim it after the
        # stale-lock threshold and generate its answer once.
        inserted = memory.save_user_message(
            account["id"],
            EXTERNAL_USER_ID,
            "Second inbound with stale processing lock",
            external_message_id=SECOND_MESSAGE_ID,
            message_type="text",
            metadata={"test": "stale-lock-recovery"},
        )
        assert inserted is True

        make_processing_lock_stale(
            memory,
            account["id"],
            SECOND_MESSAGE_ID
        )

        stale_recovered = manager.recover_due_reply(
            account["id"],
            external_user_id=EXTERNAL_USER_ID
        )
        assert stale_recovered is not None
        assert stale_recovered.outbound.content == (
            "Recovered AI reply 2"
        )
        assert stale_recovered.outbound.metadata[
            "previous_job_status"
        ] == "processing"
        assert fake_ai.calls == 2

        second_job_id = stale_recovered.outbound.metadata[
            "reply_job_id"
        ]
        assert memory.mark_reply_sent(
            second_job_id,
            outbound_external_message_id=(
                f"recovered-outbound-2-{RUN_TOKEN}"
            )
        ) is True

        # Sent jobs must never be returned by the due-job scanner.
        assert manager.recover_due_reply(
            account["id"],
            external_user_id=EXTERNAL_USER_ID
        ) is None
        assert fake_ai.calls == 2

        row = read_results(
            memory,
            account["id"]
        )
        assert row is not None
        (
            customer_id,
            message_count,
            job_count,
            sent_job_count,
            minimum_attempts,
            maximum_attempts,
        ) = row

        assert message_count == 4
        assert job_count == 2
        assert sent_job_count == 2
        assert minimum_attempts == 2
        assert maximum_attempts == 2

        print(f"Channel account: {account['id']}")
        print(f"Client: {account['client_id']}")
        print(f"Platform: {account['platform']}")
        print("Inbound event replays required: 0")
        print("Pending job generated by scanner: 1")
        print("Persisted cached reply reused: 1")
        print("Duplicate AI calls for cached reply: 0")
        print("Stale processing lock reclaimed: 1")
        print("Sent jobs returned by scanner: 0")
        print(f"Total AI calls: {fake_ai.calls}")
        print(f"Stored messages: {message_count}")
        print(f"Reply jobs: {job_count}")
        print("\nDUE REPLY RECOVERY TEST PASSED")

    finally:
        if customer_id is not None:
            cleanup(
                memory,
                account["id"],
                customer_id
            )
            print("Temporary recovery rows cleaned up")

        manager.close()


if __name__ == "__main__":
    main()
