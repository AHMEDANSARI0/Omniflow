import sys
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import ChannelEvent  # noqa: E402
from conversation import ConversationManager  # noqa: E402
from memory import Memory  # noqa: E402


RUN_TOKEN = uuid4().hex[:12]
EXTERNAL_USER_ID = f"conversation-user-{RUN_TOKEN}"
EXTERNAL_MESSAGE_ID = f"conversation-message-{RUN_TOKEN}"


class FakeAI:
    def __init__(self):
        self.calls = 0

    def generate_reply(self, user_content):
        self.calls += 1
        assert "Latest customer message" in user_content
        return "Generic omnichannel AI reply"


def load_test_account(memory):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        id,
                        client_id,
                        platform
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
            "No active channel account found"
        )

    return {
        "id": row[0],
        "client_id": row[1],
        "platform": row[2],
    }


def main():
    memory = Memory()
    fake_ai = FakeAI()
    manager = ConversationManager(
        ai=fake_ai,
        memory=memory,
        worker_id="test-worker"
    )

    try:
        account = load_test_account(memory)

        event = ChannelEvent(
            channel_account_id=account["id"],
            external_user_id=EXTERNAL_USER_ID,
            external_message_id=EXTERNAL_MESSAGE_ID,
            content="Hello generic automation core",
            message_type="text",
            metadata={
                "test": True,
            }
        )

        first_outbound = manager.process_event(
            event
        )

        assert first_outbound is not None
        assert first_outbound.content == (
            "Generic omnichannel AI reply"
        )
        assert (
            first_outbound.metadata["client_id"]
            == account["client_id"]
        )
        assert (
            first_outbound.metadata["platform"]
            == account["platform"]
        )
        assert fake_ai.calls == 1

        job_id = first_outbound.metadata[
            "reply_job_id"
        ]

        # Simulate a crash after reply generation but before platform delivery.
        # The duplicate event must return the persisted reply without another
        # AI call or assistant-message insert.
        cached_outbound = manager.process_event(
            event
        )

        assert cached_outbound is not None
        assert cached_outbound.content == (
            first_outbound.content
        )
        assert (
            cached_outbound.metadata["cached_reply"]
            is True
        )
        assert fake_ai.calls == 1

        memory.mark_reply_sent(
            job_id,
            outbound_external_message_id=(
                f"outbound-{RUN_TOKEN}"
            )
        )

        # Once sent, replaying the same external message must do nothing.
        completed_outbound = manager.process_event(
            event
        )
        assert completed_outbound is None
        assert fake_ai.calls == 1

        conn = memory._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            cc.customer_id,
                            COUNT(DISTINCT m.id) AS message_count,
                            COUNT(DISTINCT job.id) AS job_count,
                            MIN(job.status) AS job_status,
                            MAX(job.attempt_count) AS attempts,
                            MAX(job.outbound_external_message_id)
                                AS outbound_id
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
                            account["id"],
                            EXTERNAL_USER_ID,
                        )
                    )

                    row = cursor.fetchone()

        finally:
            memory._release_connection(conn)

        assert row is not None
        (
            customer_id,
            message_count,
            job_count,
            job_status,
            attempts,
            outbound_id,
        ) = row

        assert message_count == 2
        assert job_count == 1
        assert job_status == "sent"
        assert attempts == 2
        assert outbound_id == f"outbound-{RUN_TOKEN}"

        print(f"Channel account: {account['id']}")
        print(f"Client: {account['client_id']}")
        print(f"Platform: {account['platform']}")
        print(f"Customer: {customer_id}")
        print(f"AI calls: {fake_ai.calls}")
        print(f"Stored messages: {message_count}")
        print(f"Reply jobs: {job_count}")
        print(f"Final job status: {job_status}")
        print(f"Job attempts: {attempts}")

        # Cleanup test identity and its now-unreferenced customer.
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
                            account["id"],
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

        print("\nGENERIC CONVERSATION TEST PASSED")
        print("Temporary conversation rows cleaned up")

    finally:
        manager.close()


if __name__ == "__main__":
    main()
