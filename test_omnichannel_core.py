from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from src.memory import Memory


DUPLICATE_ATTEMPTS = 5
MAX_TEST_ACCOUNTS = 10
MAX_WORKERS = 10

RUN_TOKEN = uuid4().hex[:12]
EXTERNAL_USER_ID = f"omnichannel-user-{RUN_TOKEN}"
EXTERNAL_MESSAGE_ID = f"omnichannel-message-{RUN_TOKEN}"


def load_active_channel_accounts(memory):
    conn = memory._get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        id,
                        client_id,
                        platform,
                        account_name
                    FROM channel_accounts
                    WHERE status = 'active'
                    ORDER BY id
                    LIMIT %s
                    """,
                    (MAX_TEST_ACCOUNTS,)
                )

                rows = cursor.fetchall()

    finally:
        memory._release_connection(conn)

    return [
        {
            "id": row[0],
            "client_id": row[1],
            "platform": row[2],
            "account_name": row[3],
        }
        for row in rows
    ]


def main():
    memory = Memory()

    try:
        accounts = load_active_channel_accounts(memory)

        if not accounts:
            raise RuntimeError(
                "No active channel accounts found"
            )

        print(
            f"Testing {len(accounts)} dynamically discovered "
            "channel account(s)"
        )

        for account in accounts:
            print(
                f"  - channel_account={account['id']}, "
                f"client={account['client_id']}, "
                f"platform={account['platform']}, "
                f"name={account['account_name']}"
            )

        def attempt_insert(account, attempt_number):
            inserted = memory.save_user_message(
                account["id"],
                EXTERNAL_USER_ID,
                (
                    f"Omnichannel attempt {attempt_number} "
                    f"for channel account {account['id']}"
                ),
                external_message_id=EXTERNAL_MESSAGE_ID,
                message_type="text",
                metadata={
                    "test": True,
                    "platform": account["platform"],
                }
            )

            return account["id"], inserted

        tasks = []

        with ThreadPoolExecutor(
            max_workers=min(
                MAX_WORKERS,
                max(1, len(accounts) * DUPLICATE_ATTEMPTS)
            )
        ) as executor:
            for account in accounts:
                for attempt_number in range(
                    1,
                    DUPLICATE_ATTEMPTS + 1
                ):
                    tasks.append(
                        executor.submit(
                            attempt_insert,
                            account,
                            attempt_number
                        )
                    )

        successful_inserts = {
            account["id"]: 0
            for account in accounts
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
                            ca.id AS channel_account_id,
                            ca.client_id,
                            ca.platform,
                            cc.customer_id,
                            customer.client_id AS customer_client_id,
                            COUNT(DISTINCT cc.id) AS identity_count,
                            COUNT(DISTINCT cv.id) AS conversation_count,
                            COUNT(DISTINCT m.id) AS message_count,
                            COUNT(DISTINCT job.id) AS reply_job_count
                        FROM channel_accounts ca
                        JOIN channel_contacts cc
                          ON cc.channel_account_id = ca.id
                        JOIN customers customer
                          ON customer.id = cc.customer_id
                        JOIN conversations cv
                          ON cv.channel_contact_id = cc.id
                        JOIN messages m
                          ON m.conversation_id = cv.id
                        JOIN message_reply_jobs job
                          ON job.inbound_message_id = m.id
                        WHERE cc.external_user_id = %s
                          AND m.external_message_id = %s
                        GROUP BY
                            ca.id,
                            ca.client_id,
                            ca.platform,
                            cc.customer_id,
                            customer.client_id
                        ORDER BY ca.id
                        """,
                        (
                            EXTERNAL_USER_ID,
                            EXTERNAL_MESSAGE_ID,
                        )
                    )

                    rows = cursor.fetchall()

        finally:
            memory._release_connection(conn)

        print("\nDATABASE RESULT:")
        results = {}

        for row in rows:
            (
                channel_account_id,
                client_id,
                platform,
                customer_id,
                customer_client_id,
                identity_count,
                conversation_count,
                message_count,
                reply_job_count,
            ) = row

            results[channel_account_id] = {
                "client_id": client_id,
                "platform": platform,
                "customer_id": customer_id,
                "customer_client_id": customer_client_id,
                "identity_count": identity_count,
                "conversation_count": conversation_count,
                "message_count": message_count,
                "reply_job_count": reply_job_count,
            }

            print(
                f"Channel account {channel_account_id}: "
                f"client={client_id}, "
                f"platform={platform}, "
                f"customer={customer_id}, "
                f"successful_inserts="
                f"{successful_inserts[channel_account_id]}, "
                f"identities={identity_count}, "
                f"conversations={conversation_count}, "
                f"messages={message_count}, "
                f"reply_jobs={reply_job_count}"
            )

        expected_ids = {
            account["id"]
            for account in accounts
        }

        assert set(results) == expected_ids

        customer_ids = []

        for account in accounts:
            account_id = account["id"]
            result = results[account_id]

            assert successful_inserts[account_id] == 1
            assert result["client_id"] == account["client_id"]
            assert result["customer_client_id"] == account["client_id"]
            assert result["identity_count"] == 1
            assert result["conversation_count"] == 1
            assert result["message_count"] == 1
            assert result["reply_job_count"] == 1

            customer_ids.append(
                result["customer_id"]
            )

        # Delete channel identities first. Cascades remove conversations,
        # messages, and jobs. Canonical customers are then removed explicitly.
        conn = memory._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        DELETE FROM channel_contacts
                        WHERE external_user_id = %s
                        """,
                        (EXTERNAL_USER_ID,)
                    )

                    cursor.execute(
                        """
                        DELETE FROM customers
                        WHERE id = ANY(%s)
                        """,
                        (customer_ids,)
                    )

        finally:
            memory._release_connection(conn)

        print("\nOMNICHANNEL CORE TEST PASSED")
        print("Temporary omnichannel test rows cleaned up")

    finally:
        memory.close()


if __name__ == "__main__":
    main()
