import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent

load_dotenv(
    PROJECT_ROOT / ".env"
)

REQUIRED_TABLES = (
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "connector_nodes",
    "channel_connections",
    "pairing_sessions",
    "connector_events",
    "connector_commands",
    "control_plane_audit_log",
)


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=10,
        application_name=(
            "omniflow-managed-connector-"
            "migration-audit"
        ),
    )


def scalar(
    cursor,
    query,
    parameters=(),
):
    cursor.execute(
        query,
        parameters,
    )

    row = cursor.fetchone()

    if row is None:
        raise AssertionError(
            "Expected a database result row"
        )

    return row[0]


def main():
    connection = get_connection()

    try:
        connection.set_session(
            readonly=True,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            missing_tables = []

            for table in REQUIRED_TABLES:
                exists = scalar(
                    cursor,
                    (
                        "SELECT to_regclass(%s) "
                        "IS NOT NULL"
                    ),
                    (
                        f"public.{table}",
                    ),
                )

                if not exists:
                    missing_tables.append(
                        table
                    )

            assert not missing_tables, (
                "Missing managed-connector "
                "tables: "
                + ", ".join(
                    missing_tables
                )
            )

            connection_mode_column = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name
                      = 'channel_accounts'
                  AND column_name
                      = 'connection_mode'
                  AND is_nullable = 'NO'
                """,
            )

            assert (
                connection_mode_column
                == 1
            )

            missing_connection_rows = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM channel_accounts account

                LEFT JOIN
                    channel_connections connection
                  ON connection.channel_account_id
                     = account.id

                WHERE
                    connection.channel_account_id
                    IS NULL
                """,
            )

            assert (
                missing_connection_rows
                == 0
            )

            cross_tenant_connections = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM
                    channel_connections connection

                JOIN channel_accounts account
                  ON account.id
                     = connection.channel_account_id

                WHERE
                    connection.client_id
                    <> account.client_id
                """,
            )

            assert (
                cross_tenant_connections
                == 0
            )

            mode_mismatches = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM
                    channel_connections connection

                JOIN channel_accounts account
                  ON account.id
                     = connection.channel_account_id

                WHERE
                    connection.connection_mode
                    <> account.connection_mode
                """,
            )

            assert mode_mismatches == 0

            unexpected_managed_assignments = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM channel_connections
                WHERE
                    connection_mode
                    = 'managed_web'
                   OR connector_node_id
                      IS NOT NULL
                """,
            )

            assert (
                unexpected_managed_assignments
                == 0
            )

            cursor.execute(
                """
                SELECT
                    account.connection_mode,
                    connection.connection_mode,
                    connection.status,
                    connection.connector_node_id

                FROM channel_accounts account

                JOIN
                    channel_connections connection
                  ON connection.channel_account_id
                     = account.id

                WHERE account.id = 1
                """
            )

            account_one = cursor.fetchone()

            if account_one is not None:
                assert (
                    account_one[0]
                    == "local_web"
                )

                assert (
                    account_one[1]
                    == "local_web"
                )

                assert (
                    account_one[2]
                    == "created"
                )

                assert (
                    account_one[3]
                    is None
                )

            composite_foreign_keys = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM pg_constraint
                WHERE contype = 'f'
                  AND conname IN (
                      'channel_connections_account_client_fkey',
                      'pairing_sessions_account_client_fkey',
                      'connector_events_account_client_fkey',
                      'connector_commands_account_client_fkey'
                  )
                """,
            )

            assert (
                composite_foreign_keys
                == 4
            )

            idempotency_constraints = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM pg_constraint
                WHERE contype = 'u'
                  AND conname IN (
                      'connector_events_idempotency_unique',
                      'connector_commands_idempotency_unique',
                      'connector_commands_reply_job_unique',
                      'pairing_sessions_token_hash_unique'
                  )
                """,
            )

            assert (
                idempotency_constraints
                == 4
            )

            plaintext_columns = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name IN (
                      'user_password_credentials',
                      'pairing_sessions',
                      'connector_nodes'
                  )
                  AND column_name IN (
                      'password',
                      'enrollment_token',
                      'pairing_code',
                      'qr_payload',
                      'credential_secret'
                  )
                """,
            )

            assert plaintext_columns == 0

            required_checks = scalar(
                cursor,
                """
                SELECT COUNT(*)
                FROM pg_constraint
                WHERE contype = 'c'
                  AND conname IN (
                      'connector_nodes_capacity_check',
                      'channel_connections_assignment_check',
                      'pairing_sessions_artifact_encryption_check',
                      'connector_commands_claim_state_check'
                  )
                """,
            )

            assert required_checks == 4

            print(
                "Managed connector tables "
                "present: "
                f"{len(REQUIRED_TABLES)}/"
                f"{len(REQUIRED_TABLES)}"
            )

            print(
                "Channel connections "
                "backfilled: "
                f"missing="
                f"{missing_connection_rows}"
            )

            print(
                "Cross-tenant connection "
                "rows: "
                f"{cross_tenant_connections}"
            )

            print(
                "Account/connection mode "
                "mismatches: "
                f"{mode_mismatches}"
            )

            print(
                "Unexpected managed "
                "assignments: "
                f"{unexpected_managed_assignments}"
            )

            print(
                "Composite tenant "
                "foreign keys: "
                f"{composite_foreign_keys}/4"
            )

            print(
                "Idempotency constraints: "
                f"{idempotency_constraints}/4"
            )

            print(
                "Security/state check "
                "constraints: "
                f"{required_checks}/4"
            )

            print(
                "Plaintext credential/"
                "artifact columns: "
                f"{plaintext_columns}"
            )

            if account_one is not None:
                print(
                    "Account 1 preserved: "
                    "mode=local_web, "
                    "connection_status=created"
                )

            print(
                "\n✅ MANAGED CONNECTOR "
                "MIGRATION TEST PASSED"
            )

        connection.rollback()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


if __name__ == "__main__":
    main()  