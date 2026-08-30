from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from src.memory import Memory


ACCOUNT_IDS = (1, 4)
ATTEMPTS_PER_ACCOUNT = 10
MAX_WORKERS = 10

RUN_TOKEN = uuid4().hex[:12]
TEST_USER = f"reply_job_test_{RUN_TOKEN}"
WHATSAPP_MESSAGE_ID = f"WA_REPLY_JOB_{RUN_TOKEN}"


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
                    f"Reply-job atomic attempt {attempt_number} "
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
                            COUNT(DISTINCT m.id) AS message_count,
                            COUNT(DISTINCT j.id) AS job_count,
                            MIN(j.status) AS job_status,
                            MAX(j.attempt_count) AS attempt_count
                        FROM contacts c
                        JOIN conversations cv
                          ON cv.contact_id = c.id
                        JOIN messages m
                          ON m.conversation_id = cv.id
                        JOIN message_reply_jobs j
                          ON j.inbound_message_id = m.id
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
        results = {}

        for (
            account_id,
            message_count,
            job_count,
            job_status,
            attempt_count,
        ) in rows:
            results[account_id] = {
                "message_count": message_count,
                "job_count": job_count,
                "job_status": job_status,
                "attempt_count": attempt_count,
            }

            print(
                f"Account {account_id}: "
                f"successful_inserts="
                f"{successful_inserts[account_id]}, "
                f"messages={message_count}, "
                f"reply_jobs={job_count}, "
                f"status={job_status}, "
                f"attempts={attempt_count}"
            )

        assert set(results) == set(ACCOUNT_IDS), (
            "Both account results were not found"
        )

        for account_id in ACCOUNT_IDS:
            result = results[account_id]

            assert successful_inserts[account_id] == 1
            assert result["message_count"] == 1
            assert result["job_count"] == 1
            assert result["job_status"] == "pending"
            assert result["attempt_count"] == 0

        # Contacts cascade to conversations, messages, and reply jobs.
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

        print("\nATOMIC REPLY-JOB TEST PASSED")
        print("Temporary test rows cleaned up")

    finally:
        memory.close()


if __name__ == "__main__":
    main()
