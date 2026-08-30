from concurrent.futures import ThreadPoolExecutor, as_completed
from uuid import uuid4

from src.memory import Memory


ACCOUNT_IDS = (1, 4)
MESSAGES_PER_ACCOUNT = 20
MAX_WORKERS = 10

RUN_TOKEN = uuid4().hex[:12]
TEST_USER = f"concurrency_test_{RUN_TOKEN}"


def main():
    memory = Memory()

    try:
        print(f"Concurrent test user: {TEST_USER}")
        print(
            f"Writing {MESSAGES_PER_ACCOUNT} messages "
            f"to each account with {MAX_WORKERS} workers..."
        )

        def save_test_message(account_id, message_number):
            marker = (
                f"CONCURRENCY_{RUN_TOKEN}_"
                f"ACCOUNT_{account_id}_"
                f"MESSAGE_{message_number}"
            )

            memory.save_user_message(
                account_id,
                TEST_USER,
                marker
            )

            return account_id, message_number

        futures = []

        with ThreadPoolExecutor(
            max_workers=MAX_WORKERS
        ) as executor:
            for account_id in ACCOUNT_IDS:
                for message_number in range(
                    1,
                    MESSAGES_PER_ACCOUNT + 1
                ):
                    futures.append(
                        executor.submit(
                            save_test_message,
                            account_id,
                            message_number
                        )
                    )

            # Surface every worker exception immediately.
            for future in as_completed(futures):
                future.result()

        conn = memory._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            c.whatsapp_account_id,
                            COUNT(DISTINCT c.id) AS contact_count,
                            COUNT(DISTINCT cv.id) AS conversation_count,
                            COUNT(m.id) AS message_count
                        FROM contacts c
                        LEFT JOIN conversations cv
                          ON cv.contact_id = c.id
                        LEFT JOIN messages m
                          ON m.conversation_id = cv.id
                        WHERE c.phone_number = %s
                          AND c.whatsapp_account_id IN (%s, %s)
                        GROUP BY c.whatsapp_account_id
                        ORDER BY c.whatsapp_account_id
                        """,
                        (
                            TEST_USER,
                            ACCOUNT_IDS[0],
                            ACCOUNT_IDS[1],
                        )
                    )

                    rows = cursor.fetchall()

        finally:
            memory._release_connection(conn)

        print("\nDATABASE RESULT:")

        result_by_account = {}

        for row in rows:
            (
                account_id,
                contact_count,
                conversation_count,
                message_count,
            ) = row

            result_by_account[account_id] = {
                "contact_count": contact_count,
                "conversation_count": conversation_count,
                "message_count": message_count,
            }

            print(
                f"Account {account_id}: "
                f"contacts={contact_count}, "
                f"conversations={conversation_count}, "
                f"messages={message_count}"
            )

        assert set(result_by_account) == set(ACCOUNT_IDS), (
            "Both WhatsApp accounts were not found in the test result"
        )

        for account_id in ACCOUNT_IDS:
            result = result_by_account[account_id]

            assert result["contact_count"] == 1, (
                f"Account {account_id} created duplicate contacts"
            )
            assert result["conversation_count"] == 1, (
                f"Account {account_id} created duplicate conversations"
            )
            assert result["message_count"] == MESSAGES_PER_ACCOUNT, (
                f"Account {account_id} did not save every message"
            )

        # Clean up only after all assertions pass. If a test fails, its rows
        # remain available for database inspection.
        conn = memory._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        DELETE FROM contacts
                        WHERE phone_number = %s
                          AND whatsapp_account_id IN (%s, %s)
                        """,
                        (
                            TEST_USER,
                            ACCOUNT_IDS[0],
                            ACCOUNT_IDS[1],
                        )
                    )

        finally:
            memory._release_connection(conn)

        print("\nMEMORY CONCURRENCY TEST PASSED")
        print("Temporary concurrency test rows cleaned up")

    finally:
        memory.close()


if __name__ == "__main__":
    main()
