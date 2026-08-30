import os

import psycopg2
from dotenv import load_dotenv


load_dotenv()


class RefreshMigrationAuditError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise RefreshMigrationAuditError(message)


def connection():
    result = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=10,
        application_name="omniflow-refresh-rotation-migration-audit",
    )
    result.set_session(readonly=True, autocommit=False)
    return result


def scalar(cursor, query, parameters=None):
    if parameters is None:
        cursor.execute(query)
    else:
        cursor.execute(query, parameters)

    row = cursor.fetchone()

    if row is None:
        raise RefreshMigrationAuditError(
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
                    "SELECT to_regclass(%s) IS NOT NULL",
                    ("public.platform_refresh_token_history",),
                )
            )
            require(table_exists, "Refresh history table is missing")

            identity_unique = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE connamespace = 'public'::regnamespace
                      AND conname = 'platform_user_sessions_identity_unique'
                      AND contype = 'u'
                    """,
                )
            )
            foreign_keys = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE connamespace = 'public'::regnamespace
                      AND conname = 'platform_refresh_history_session_fkey'
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
                    WHERE connamespace = 'public'::regnamespace
                      AND conname = 'platform_refresh_history_hash_unique'
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
                    WHERE connamespace = 'public'::regnamespace
                      AND conname IN (
                          'platform_refresh_history_hash_check',
                          'platform_refresh_history_expiry_check'
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
                          'idx_platform_refresh_history_session',
                          'idx_platform_refresh_history_expiry'
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
                    WHERE table_schema = 'public'
                      AND table_name = 'platform_refresh_token_history'
                      AND column_name IN (
                          'access_token',
                          'refresh_token',
                          'token',
                          'raw_token'
                      )
                    """,
                )
            )
            cross_tenant = int(
                scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM platform_refresh_token_history history
                    LEFT JOIN platform_user_sessions session
                      ON session.id = history.session_id
                     AND session.user_id = history.user_id
                     AND session.client_id = history.client_id
                    WHERE session.id IS NULL
                    """,
                )
            )
            history_rows = int(
                scalar(
                    cursor,
                    "SELECT COUNT(*) FROM platform_refresh_token_history",
                )
            )

            require(identity_unique == 1, "Session identity uniqueness missing")
            require(foreign_keys == 1, "History session foreign key missing")
            require(uniqueness == 1, "History digest uniqueness missing")
            require(checks == 2, "History checks incomplete")
            require(indexes == 2, "History indexes incomplete")
            require(plaintext_columns == 0, "Plaintext token column detected")
            require(cross_tenant == 0, "Cross-tenant history detected")
            require(history_rows == 0, "Migration created history rows")

            print("Refresh history tables: 1/1")
            print(f"Session identity constraints: {identity_unique}/1")
            print(f"Tenant-bound history foreign keys: {foreign_keys}/1")
            print(f"Consumed digest uniqueness: {uniqueness}/1")
            print(f"History security checks: {checks}/2")
            print(f"History indexes: {indexes}/2")
            print(f"Plaintext token columns: {plaintext_columns}")
            print(f"Cross-tenant history rows: {cross_tenant}")
            print(f"History rows created by migration: {history_rows}")
            print("\nREFRESH ROTATION MIGRATION TEST PASSED")

        database.rollback()

    except Exception:
        database.rollback()
        raise

    finally:
        database.close()


if __name__ == "__main__":
    main()
