import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent

load_dotenv(
    PROJECT_ROOT / ".env"
)


class AuthMigrationAuditError(
    RuntimeError
):
    pass


def require(condition, message):
    if not condition:
        raise AuthMigrationAuditError(
            message
        )


def connection():
    result = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=10,
        application_name=(
            "omniflow-platform-auth-"
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
        raise AuthMigrationAuditError(
            "Expected a database result row"
        )

    return row[0]


def main():
    database = connection()

    try:
        with database.cursor() as cursor:
            table_exists = bool(
                scalar(
                    cursor,
                    (
                        "SELECT "
                        "to_regclass(%s) "
                        "IS NOT NULL"
                    ),
                    (
                        "public."
                        "platform_user_sessions",
                    ),
                )
            )

            require(
                table_exists,
                (
                    "Platform user session "
                    "table is missing"
                ),
            )

            foreign_keys = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE connamespace
                          = 'public'::regnamespace
                      AND conname
                          = 'platform_user_sessions_membership_fkey'
                      AND contype = 'f'
                    """,
                )
            )

            uniqueness = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE connamespace
                          = 'public'::regnamespace
                      AND conname IN (
                        'platform_user_sessions_access_hash_unique',
                        'platform_user_sessions_refresh_hash_unique'
                      )
                      AND contype = 'u'
                    """,
                )
            )

            checks = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE connamespace
                          = 'public'::regnamespace
                      AND conname IN (
                        'platform_user_sessions_status_check',
                        'platform_user_sessions_auth_method_check',
                        'platform_user_sessions_expiry_check',
                        'platform_user_sessions_revocation_check',
                        'platform_user_sessions_access_hash_check',
                        'platform_user_sessions_refresh_hash_check'
                      )
                      AND contype = 'c'
                    """,
                )
            )

            indexes = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND indexname IN (
                        'idx_platform_user_sessions_access',
                        'idx_platform_user_sessions_refresh',
                        'idx_platform_user_sessions_user'
                      )
                    """,
                )
            )

            plaintext_columns = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM information_schema.columns
                    WHERE table_schema
                          = 'public'
                      AND table_name
                          = 'platform_user_sessions'
                      AND column_name IN (
                        'access_token',
                        'refresh_token',
                        'token',
                        'raw_token'
                      )
                    """,
                )
            )

            cross_tenant_sessions = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM platform_user_sessions
                         session
                    LEFT JOIN client_memberships
                              membership
                      ON membership.client_id
                         = session.client_id
                     AND membership.user_id
                         = session.user_id
                    WHERE membership.id IS NULL
                    """,
                )
            )

            session_rows = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM platform_user_sessions
                    """,
                )
            )

            require(
                foreign_keys == 1,
                (
                    "Session membership "
                    "FK is missing"
                ),
            )

            require(
                uniqueness == 2,
                (
                    "Token digest uniqueness "
                    "is incomplete"
                ),
            )

            require(
                checks == 6,
                (
                    "Session security checks "
                    "are incomplete"
                ),
            )

            require(
                indexes == 3,
                (
                    "Session indexes "
                    "are incomplete"
                ),
            )

            require(
                plaintext_columns == 0,
                (
                    "Plaintext token "
                    "column detected"
                ),
            )

            require(
                cross_tenant_sessions == 0,
                (
                    "Cross-tenant session "
                    "detected"
                ),
            )

            require(
                session_rows == 0,
                (
                    "Migration unexpectedly "
                    "created sessions"
                ),
            )

            print(
                "Platform session tables: "
                "1/1"
            )

            print(
                "Composite membership "
                "foreign keys: "
                f"{foreign_keys}/1"
            )

            print(
                "Token digest uniqueness "
                "constraints: "
                f"{uniqueness}/2"
            )

            print(
                "Session security checks: "
                f"{checks}/6"
            )

            print(
                "Session indexes: "
                f"{indexes}/3"
            )

            print(
                "Plaintext token columns: "
                f"{plaintext_columns}"
            )

            print(
                "Cross-tenant sessions: "
                f"{cross_tenant_sessions}"
            )

            print(
                "Sessions created by "
                "migration: "
                f"{session_rows}"
            )

            print("")
            print(
                "PLATFORM AUTH MIGRATION "
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
