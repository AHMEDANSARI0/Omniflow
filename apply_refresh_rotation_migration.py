import argparse
from pathlib import Path

import apply_managed_connector_migration as base


PROJECT_ROOT = Path(__file__).resolve().parent
MIGRATION_PATH = (
    PROJECT_ROOT
    / "migrations"
    / "006_refresh_token_rotation.sql"
)
LOCK_NAME = "omniflow:migration:006_refresh_token_rotation"
HISTORY_TABLE = "platform_refresh_token_history"
PRESERVED_TABLES = (
    "clients",
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "channel_accounts",
    "channel_connections",
    "platform_user_sessions",
    "control_plane_audit_log",
)


def rows(cursor, query):
    cursor.execute(query)
    return cursor.fetchall()


def capture_before(cursor):
    for table in PRESERVED_TABLES:
        if not base.table_exists(cursor, table):
            raise base.MigrationSafetyError(
                f"Required table is missing: {table}"
            )

    counts = {
        table: int(
            base.scalar(
                cursor,
                f"SELECT COUNT(*) FROM {table}",
            )
        )
        for table in PRESERVED_TABLES
    }
    session_snapshot = rows(
        cursor,
        """
        SELECT
            id,
            user_id,
            client_id,
            access_token_hash,
            refresh_token_hash,
            status,
            auth_method,
            issued_at,
            access_expires_at,
            refresh_expires_at,
            last_seen_at,
            revoked_at,
            metadata
        FROM platform_user_sessions
        ORDER BY id
        """,
    )
    return {
        "counts": counts,
        "session_snapshot": session_snapshot,
        "history_table_existed": base.table_exists(
            cursor,
            HISTORY_TABLE,
        ),
    }


def verify_after(cursor, before):
    if not base.table_exists(cursor, HISTORY_TABLE):
        raise base.MigrationSafetyError(
            "Refresh-token history table is missing after migration"
        )

    for table, expected in before["counts"].items():
        actual = int(
            base.scalar(
                cursor,
                f"SELECT COUNT(*) FROM {table}",
            )
        )

        if actual != expected:
            raise base.MigrationSafetyError(
                f"Existing {table} row count changed"
            )

    after_sessions = rows(
        cursor,
        """
        SELECT
            id,
            user_id,
            client_id,
            access_token_hash,
            refresh_token_hash,
            status,
            auth_method,
            issued_at,
            access_expires_at,
            refresh_expires_at,
            last_seen_at,
            revoked_at,
            metadata
        FROM platform_user_sessions
        ORDER BY id
        """,
    )

    if after_sessions != before["session_snapshot"]:
        raise base.MigrationSafetyError(
            "Existing platform session state changed"
        )

    identity_unique = int(
        base.scalar(
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
    history_foreign_key = int(
        base.scalar(
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
    history_unique = int(
        base.scalar(
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
    history_checks = int(
        base.scalar(
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
        base.scalar(
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
        base.scalar(
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
        base.scalar(
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
        base.scalar(
            cursor,
            "SELECT COUNT(*) FROM platform_refresh_token_history",
        )
    )

    if identity_unique != 1:
        raise base.MigrationSafetyError(
            "Session identity unique constraint is missing"
        )
    if history_foreign_key != 1:
        raise base.MigrationSafetyError(
            "Tenant-bound refresh history foreign key is missing"
        )
    if history_unique != 1:
        raise base.MigrationSafetyError(
            "Refresh history digest uniqueness is missing"
        )
    if history_checks != 2:
        raise base.MigrationSafetyError(
            "Refresh history checks are incomplete"
        )
    if indexes != 2:
        raise base.MigrationSafetyError(
            "Refresh history indexes are incomplete"
        )
    if plaintext_columns:
        raise base.MigrationSafetyError(
            "Plaintext refresh token column detected"
        )
    if cross_tenant:
        raise base.MigrationSafetyError(
            "Cross-tenant refresh history detected"
        )
    if history_rows:
        raise base.MigrationSafetyError(
            "Migration unexpectedly created refresh history rows"
        )

    return {
        "identity_unique": identity_unique,
        "history_foreign_key": history_foreign_key,
        "history_unique": history_unique,
        "history_checks": history_checks,
        "indexes": indexes,
        "plaintext_columns": plaintext_columns,
        "cross_tenant": cross_tenant,
        "history_rows": history_rows,
    }


def migration_sql():
    if not MIGRATION_PATH.is_file():
        raise base.MigrationSafetyError(
            f"Migration file not found: {MIGRATION_PATH}"
        )

    return base.prepare_transaction_sql(
        MIGRATION_PATH.read_text(encoding="utf-8")
    )


def check():
    migration_sql()
    connection = base.get_connection()

    try:
        connection.set_session(readonly=True, autocommit=False)

        with connection.cursor() as cursor:
            result = capture_before(cursor)

        connection.rollback()
        return result

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def execute(commit, backup_confirmed=False):
    if commit and not backup_confirmed:
        raise base.MigrationSafetyError(
            "Apply blocked until --backup-confirmed is provided"
        )

    sql = migration_sql()
    connection = base.get_connection()

    try:
        connection.set_session(readonly=False, autocommit=False)

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (LOCK_NAME,),
            )
            before = capture_before(cursor)

            if before["history_table_existed"]:
                raise base.MigrationSafetyError(
                    "Refresh history table already exists; refusing an ambiguous rerun"
                )

            cursor.execute(sql)
            result = verify_after(cursor, before)

        if commit:
            connection.commit()
        else:
            connection.rollback()

        return result

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def build_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Check, dry-run, or apply refresh-token rotation migration 006"
        )
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--dry-run", action="store_true")
    action.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-confirmed", action="store_true")
    return parser


def main(argv=None):
    arguments = build_parser().parse_args(argv)

    if arguments.check:
        result = check()
        print("Migration 006 read-only prerequisites: passed")
        print(
            "Refresh history table already exists: "
            f"{result['history_table_existed']}"
        )
        print("\nMIGRATION 006 READ-ONLY CHECK PASSED")
        return 0

    result = execute(
        commit=arguments.apply,
        backup_confirmed=arguments.backup_confirmed,
    )

    if arguments.dry_run:
        print("Migration 006 SQL executed successfully")
        print("Transaction intentionally rolled back: True")
        ending = "MIGRATION 006 TRANSACTIONAL DRY RUN PASSED"
    else:
        print("Migration 006 committed transactionally")
        ending = "MIGRATION 006 APPLIED SAFELY"

    print("Session identity uniqueness: 1/1")
    print("Tenant-bound history foreign keys: 1/1")
    print("Consumed digest uniqueness: 1/1")
    print("Refresh history checks: 2/2")
    print("Refresh history indexes: 2/2")
    print(f"Plaintext token columns: {result['plaintext_columns']}")
    print(f"Cross-tenant history rows: {result['cross_tenant']}")
    print(f"\n{ending}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
