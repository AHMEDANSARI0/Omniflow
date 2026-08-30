import argparse
from pathlib import Path

import apply_managed_connector_migration as base


PROJECT_ROOT = Path(__file__).resolve().parent

MIGRATION_PATH = (
    PROJECT_ROOT
    / "migrations"
    / "005_platform_auth_sessions.sql"
)

LOCK_NAME = (
    "omniflow:migration:"
    "005_platform_auth_sessions"
)

SESSION_TABLE = (
    "platform_user_sessions"
)

PRESERVED_TABLES = (
    "clients",
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "channel_accounts",
    "channel_connections",
    "onboarding_requests",
)


def rows(cursor, query):
    cursor.execute(query)
    return cursor.fetchall()


def capture_before(cursor):
    for table in PRESERVED_TABLES:
        if not base.table_exists(
            cursor,
            table,
        ):
            raise base.MigrationSafetyError(
                f"Required table is "
                f"missing: {table}"
            )

    counts = {
        table: int(
            base.scalar(
                cursor,
                f"SELECT COUNT(*) "
                f"FROM {table}",
            )
        )
        for table in PRESERVED_TABLES
    }

    snapshots = {
        "users": rows(
            cursor,
            """
            SELECT
                id,
                email,
                status,
                last_login_at
            FROM platform_users
            ORDER BY id
            """,
        ),
        "credentials": rows(
            cursor,
            """
            SELECT
                user_id,
                password_hash,
                failed_attempt_count,
                locked_until
            FROM user_password_credentials
            ORDER BY user_id
            """,
        ),
        "memberships": rows(
            cursor,
            """
            SELECT
                id,
                client_id,
                user_id,
                role,
                status
            FROM client_memberships
            ORDER BY id
            """,
        ),
        "connections": rows(
            cursor,
            """
            SELECT
                account.id,
                account.client_id,
                account.status,
                account.connection_mode,
                connection.connection_mode,
                connection.status,
                connection.connector_node_id
            FROM channel_accounts account
            JOIN channel_connections
                 connection
              ON connection.channel_account_id
                 = account.id
             AND connection.client_id
                 = account.client_id
            ORDER BY account.id
            """,
        ),
    }

    return {
        "counts": counts,
        "snapshots": snapshots,
        "session_table_existed":
            base.table_exists(
                cursor,
                SESSION_TABLE,
            ),
    }


def verify_after(
    cursor,
    before,
):
    if not base.table_exists(
        cursor,
        SESSION_TABLE,
    ):
        raise base.MigrationSafetyError(
            "Platform session table is "
            "missing after migration"
        )

    for table, expected in (
        before["counts"].items()
    ):
        actual = int(
            base.scalar(
                cursor,
                f"SELECT COUNT(*) "
                f"FROM {table}",
            )
        )

        if actual != expected:
            raise base.MigrationSafetyError(
                f"Existing {table} "
                "row count changed"
            )

    after_snapshots = {
        "users": rows(
            cursor,
            """
            SELECT
                id,
                email,
                status,
                last_login_at
            FROM platform_users
            ORDER BY id
            """,
        ),
        "credentials": rows(
            cursor,
            """
            SELECT
                user_id,
                password_hash,
                failed_attempt_count,
                locked_until
            FROM user_password_credentials
            ORDER BY user_id
            """,
        ),
        "memberships": rows(
            cursor,
            """
            SELECT
                id,
                client_id,
                user_id,
                role,
                status
            FROM client_memberships
            ORDER BY id
            """,
        ),
        "connections": rows(
            cursor,
            """
            SELECT
                account.id,
                account.client_id,
                account.status,
                account.connection_mode,
                connection.connection_mode,
                connection.status,
                connection.connector_node_id
            FROM channel_accounts account
            JOIN channel_connections
                 connection
              ON connection.channel_account_id
                 = account.id
             AND connection.client_id
                 = account.client_id
            ORDER BY account.id
            """,
        ),
    }

    if (
        after_snapshots
        != before["snapshots"]
    ):
        raise base.MigrationSafetyError(
            "Existing identity, membership, "
            "credential, or channel state "
            "changed"
        )

    foreign_key_count = int(
        base.scalar(
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

    unique_count = int(
        base.scalar(
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

    index_count = int(
        base.scalar(
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

    plaintext_token_columns = int(
        base.scalar(
            cursor,
            """
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
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
        base.scalar(
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
        base.scalar(
            cursor,
            """
            SELECT COUNT(*)
            FROM platform_user_sessions
            """,
        )
    )

    if foreign_key_count != 1:
        raise base.MigrationSafetyError(
            "Composite session membership "
            "foreign key is missing"
        )

    if unique_count != 2:
        raise base.MigrationSafetyError(
            "Session token digest uniqueness "
            "constraints are missing"
        )

    if index_count != 3:
        raise base.MigrationSafetyError(
            "Platform session indexes "
            "are incomplete"
        )

    if plaintext_token_columns:
        raise base.MigrationSafetyError(
            "Plaintext session token "
            "column detected"
        )

    if cross_tenant_sessions:
        raise base.MigrationSafetyError(
            "Cross-tenant platform "
            "session detected"
        )

    if session_rows:
        raise base.MigrationSafetyError(
            "Migration unexpectedly "
            "created login sessions"
        )

    return {
        "foreign_key_count":
            foreign_key_count,
        "unique_count":
            unique_count,
        "index_count":
            index_count,
        "plaintext_token_columns":
            plaintext_token_columns,
        "cross_tenant_sessions":
            cross_tenant_sessions,
        "session_rows":
            session_rows,
        "preserved_counts":
            before["counts"],
    }


def migration_sql():
    if not MIGRATION_PATH.is_file():
        raise base.MigrationSafetyError(
            "Migration file not found: "
            f"{MIGRATION_PATH}"
        )

    return base.prepare_transaction_sql(
        MIGRATION_PATH.read_text(
            encoding="utf-8"
        )
    )


def check():
    migration_sql()

    connection = base.get_connection()

    try:
        connection.set_session(
            readonly=True,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            result = capture_before(
                cursor
            )

        connection.rollback()
        return result

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def execute(
    commit,
    backup_confirmed=False,
):
    if (
        commit
        and not backup_confirmed
    ):
        raise base.MigrationSafetyError(
            "Apply blocked until "
            "--backup-confirmed "
            "is provided"
        )

    sql = migration_sql()
    connection = base.get_connection()

    try:
        connection.set_session(
            readonly=False,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    pg_advisory_xact_lock(
                        hashtext(%s)
                    )
                """,
                (LOCK_NAME,),
            )

            before = capture_before(
                cursor
            )

            if before[
                "session_table_existed"
            ]:
                raise (
                    base.MigrationSafetyError(
                        "Platform session table "
                        "already exists; refusing "
                        "an ambiguous rerun"
                    )
                )

            cursor.execute(sql)

            result = verify_after(
                cursor,
                before,
            )

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
            "Check, dry-run, or apply "
            "platform authentication "
            "migration 005"
        )
    )

    action = (
        parser
        .add_mutually_exclusive_group(
            required=True
        )
    )

    action.add_argument(
        "--check",
        action="store_true",
    )

    action.add_argument(
        "--dry-run",
        action="store_true",
    )

    action.add_argument(
        "--apply",
        action="store_true",
    )

    parser.add_argument(
        "--backup-confirmed",
        action="store_true",
    )

    return parser


def main(argv=None):
    arguments = (
        build_parser().parse_args(argv)
    )

    if arguments.check:
        result = check()

        print(
            "Migration 005 read-only "
            "prerequisites: passed"
        )

        print(
            "Platform session table "
            "already exists: "
            f"{result['session_table_existed']}"
        )

        print(
            "Preserved rows: "
            + ", ".join(
                f"{table}={count}"
                for table, count
                in result["counts"].items()
            )
        )

        print("")
        print(
            "MIGRATION 005 READ-ONLY "
            "CHECK PASSED"
        )

        return 0

    result = execute(
        commit=arguments.apply,
        backup_confirmed=(
            arguments.backup_confirmed
        ),
    )

    if arguments.dry_run:
        print(
            "Migration 005 SQL "
            "executed successfully"
        )

        print(
            "Transaction intentionally "
            "rolled back: True"
        )

        ending = (
            "MIGRATION 005 "
            "TRANSACTIONAL DRY RUN PASSED"
        )

    else:
        print(
            "Migration 005 committed "
            "transactionally"
        )

        ending = (
            "MIGRATION 005 "
            "APPLIED SAFELY"
        )

    print(
        "Platform session table "
        "verified: 1/1"
    )

    print(
        "Composite membership "
        "foreign keys: "
        f"{result['foreign_key_count']}/1"
    )

    print(
        "Token digest uniqueness "
        "constraints: "
        f"{result['unique_count']}/2"
    )

    print(
        "Session indexes: "
        f"{result['index_count']}/3"
    )

    print(
        "Plaintext token columns: "
        f"{result['plaintext_token_columns']}"
    )

    print(
        "Cross-tenant sessions: "
        f"{result['cross_tenant_sessions']}"
    )

    print("")
    print(ending)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
