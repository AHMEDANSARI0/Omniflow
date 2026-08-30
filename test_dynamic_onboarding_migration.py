import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent

load_dotenv(
    PROJECT_ROOT / ".env"
)

REQUIRED_TABLES = (
    "ai_agents",
    "ai_agent_versions",
    "channel_agent_assignments",
    "client_trial_entitlements",
    "client_usage_counters",
    "onboarding_requests",
)

REQUIRED_ENVIRONMENT = (
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
)


class MigrationAuditError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise MigrationAuditError(message)


def database_environment():
    values = {
        name: os.getenv(name)
        for name in REQUIRED_ENVIRONMENT
    }

    missing = [
        name
        for name, value in values.items()
        if not str(value or "").strip()
    ]

    if missing:
        raise MigrationAuditError(
            "Missing database environment "
            "values: "
            + ", ".join(missing)
        )

    return values


def connection():
    environment = database_environment()

    result = psycopg2.connect(
        host=environment["DB_HOST"],
        port=environment["DB_PORT"],
        database=environment["DB_NAME"],
        user=environment["DB_USER"],
        password=environment["DB_PASSWORD"],
        connect_timeout=10,
        application_name=(
            "omniflow-onboarding-"
            "migration-audit"
        ),
    )

    result.set_session(
        readonly=True,
        autocommit=False,
    )

    return result


def scalar(
    cursor,
    query,
    parameters=None,
):
    if parameters is None:
        cursor.execute(query)
    else:
        cursor.execute(
            query,
            parameters,
        )

    row = cursor.fetchone()

    if row is None:
        raise MigrationAuditError(
            "Expected a database result row"
        )

    return row[0]


def main():
    database = connection()

    try:
        with database.cursor() as cursor:
            missing = [
                table
                for table in REQUIRED_TABLES
                if not bool(
                    scalar(
                        cursor,
                        (
                            "SELECT "
                            "to_regclass(%s) "
                            "IS NOT NULL"
                        ),
                        (f"public.{table}",),
                    )
                )
            ]

            require(
                not missing,
                "Missing onboarding tables: "
                + ", ".join(missing),
            )

            tenant_foreign_keys = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE contype = 'f'
                      AND connamespace
                          = 'public'::regnamespace
                      AND conname IN (
                        'ai_agent_versions_agent_client_fkey',
                        'channel_agent_assignments_account_client_fkey',
                        'channel_agent_assignments_agent_client_fkey',
                        'channel_agent_assignments_version_fkey'
                      )
                    """,
                )
            )

            require(
                tenant_foreign_keys == 4,
                (
                    "Expected four composite "
                    "tenant foreign keys"
                ),
            )

            uniqueness = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE contype = 'u'
                      AND connamespace
                          = 'public'::regnamespace
                      AND conname IN (
                        'ai_agents_client_key_unique',
                        'ai_agent_versions_number_unique',
                        'client_usage_counters_period_unique',
                        'onboarding_requests_idempotency_unique'
                      )
                    """,
                )
            )

            require(
                uniqueness == 4,
                (
                    "Expected four onboarding "
                    "uniqueness constraints"
                ),
            )

            active_assignment_index = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND indexname
                          = 'uq_channel_agent_active'
                      AND indexdef ILIKE %s
                      AND indexdef ILIKE %s
                      AND indexdef ILIKE %s
                    """,
                    (
                        "%WHERE%",
                        "%status%",
                        "%active%",
                    ),
                )
            )

            require(
                active_assignment_index == 1,
                (
                    "Single-active-agent index "
                    "is missing"
                ),
            )

            plaintext_password_columns = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name IN (
                        'onboarding_requests',
                        'platform_users',
                        'client_memberships',
                        'user_password_credentials'
                      )
                      AND column_name IN (
                        'password',
                        'raw_password',
                        'plaintext_password',
                        'credential'
                      )
                    """,
                )
            )

            require(
                plaintext_password_columns == 0,
                (
                    "Plaintext password "
                    "column detected"
                ),
            )

            managed_accounts = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_connections
                    WHERE connection_mode
                          = 'managed_web'
                    """,
                )
            )

            cross_tenant_rows = int(
                scalar(
                    cursor,
                    """
                    SELECT
                        (
                            SELECT COUNT(*)
                            FROM ai_agent_versions
                                 version
                            JOIN ai_agents agent
                              ON agent.id
                                 = version.agent_id
                            WHERE version.client_id
                                  <> agent.client_id
                        )
                        +
                        (
                            SELECT COUNT(*)
                            FROM channel_agent_assignments
                                 assignment
                            JOIN channel_accounts
                                 account
                              ON account.id
                                 = assignment.channel_account_id
                            WHERE assignment.client_id
                                  <> account.client_id
                        )
                    """,
                )
            )

            require(
                cross_tenant_rows == 0,
                (
                    "Cross-tenant onboarding "
                    "rows detected"
                ),
            )

            connection_mismatches = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_accounts account
                    LEFT JOIN channel_connections
                              connection
                      ON connection.channel_account_id
                         = account.id
                    WHERE connection.channel_account_id
                          IS NULL
                       OR connection.client_id
                          <> account.client_id
                       OR connection.connection_mode
                          <> account.connection_mode
                    """,
                )
            )

            require(
                connection_mismatches == 0,
                (
                    "Channel connection "
                    "preservation mismatch detected"
                ),
            )

            print(
                "Dynamic onboarding tables: 6/6"
            )
            print(
                "Composite tenant foreign keys: "
                f"{tenant_foreign_keys}/4"
            )
            print(
                "Idempotency/version uniqueness: "
                f"{uniqueness}/4"
            )
            print(
                "Single active agent per "
                "channel: enforced"
            )
            print(
                "Plaintext onboarding password "
                "columns: "
                f"{plaintext_password_columns}"
            )
            print(
                "Managed channel accounts: "
                f"{managed_accounts}"
            )
            print(
                "Cross-tenant onboarding rows: "
                f"{cross_tenant_rows}"
            )
            print(
                "Channel connection preservation "
                "mismatches: "
                f"{connection_mismatches}"
            )
            print("")
            print(
                "DYNAMIC ONBOARDING MIGRATION "
                "TEST PASSED"
            )

        database.rollback()

    except Exception:
        database.rollback()
        raise

    finally:
        database.close()


if __name__ == "__main__":
    main()
