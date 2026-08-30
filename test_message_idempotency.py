from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from src.memory import Memory


ACCOUNT_IDS = (1, 4)
ATTEMPTS_PER_ACCOUNT = 10
MAX_WORKERS = 10

RUN_TOKEN = uuid4().hex[:12]
TEST_USER = f"idempotency_test_{RUN_TOKEN}"
WHATSAPP_MESSAGE_ID = f"WA_TEST_MESSAGE_{RUN_TOKEN}"


def main():
    memory = Memory()

    try:
        print(f"Test user: {TEST_USER}")
        print(f"WhatsApp message ID: {WHATSAPP_MESSAGE_ID}")
        print(
            f"Submitting {ATTEMPTS_PER_ACCOUNT} duplicate attempts "
            "to each account..."
        )

        def attempt_insert(account_id, attempt_number):
            inserted = memory.save_user_message(
                account_id,
                TEST_USER,
                (
                    f"Duplicate attempt {attempt_number} "
                    f"for account {account_id}"
                ),
                whatsapp_message_id=WHATSAPP_MESSAGE_ID
            )

            return account_id, inserted

        tasks = []

        with ThreadPoolExecutor(
            max_workers=MAX_WORKERS
        ) as executor:
            for account_id in ACCOUNT_IDS:
                for attempt_number in range(
                    1,
                    ATTEMPTS_PER_ACCOUNT + 1
                ):
                    tasks.append(
                        executor.submit(
                            attempt_insert,
                            account_id,
                            attempt_number
                        )
                    )

        successful_inserts = {
            account_id: 0
            for account_id in ACCOUNT_IDS
        }

        for task in tasks:
            account_id, inserted = task.result()

            if inserted:
                successful_inserts[account_id] += 1

        conn = memory._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            c.whatsapp_account_id,
                            COUNT(m.id) AS stored_messages,
                            COUNT(DISTINCT m.whatsapp_message_id)
                                AS distinct_whatsapp_ids
                        FROM contacts c
                        JOIN conversations cv
                          ON cv.contact_id = c.id
                        JOIN messages m
                          ON m.conversation_id = cv.id
                        WHERE c.phone_number = %s
                          AND c.whatsapp_account_id IN (%s, %s)
                          AND m.whatsapp_message_id = %s
                        GROUP BY c.whatsapp_account_id
                        ORDER BY c.whatsapp_account_id
                        """,
                        (
                            TEST_USER,
                            ACCOUNT_IDS[0],
                            ACCOUNT_IDS[1],
                            WHATSAPP_MESSAGE_ID,
                        )
                    )

                    rows = cursor.fetchall()

        finally:
            memory._release_connection(conn)

        print("\nDATABASE RESULT:")
        database_results = {}

        for (
            account_id,
            stored_messages,
            distinct_whatsapp_ids,
        ) in rows:
            database_results[account_id] = {
                "stored_messages": stored_messages,
                "distinct_whatsapp_ids": distinct_whatsapp_ids,
            }

            print(
                f"Account {account_id}: "
                f"successful_inserts="
                f"{successful_inserts[account_id]}, "
                f"stored_messages={stored_messages}, "
                f"distinct_whatsapp_ids={distinct_whatsapp_ids}"
            )

        assert set(database_results) == set(ACCOUNT_IDS), (
            "Both account results were not found"
        )

        for account_id in ACCOUNT_IDS:
            assert successful_inserts[account_id] == 1, (
                f"Account {account_id} accepted more than one duplicate"
            )
            assert (
                database_results[account_id]["stored_messages"]
                == 1
            ), (
                f"Account {account_id} stored duplicate messages"
            )
            assert (
                database_results[account_id]["distinct_whatsapp_ids"]
                == 1
            ), (
                f"Account {account_id} has an invalid message ID result"
            )

        # Same WhatsApp message ID is allowed once in each account because the
        # accounts resolve to separate contacts and conversations.
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

        print("\nMESSAGE IDEMPOTENCY TEST PASSED")
        print("Temporary idempotency test rows cleaned up")

    finally:
        memory.close()


if __name__ == "__main__":
    main()
