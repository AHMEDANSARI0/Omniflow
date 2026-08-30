import argparse
import os
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

MIGRATION_PATH = (
    PROJECT_ROOT
    / "migrations"
    / "003_managed_connector_control_plane.sql"
)

MIGRATION_LOCK_NAME = (
    "omniflow:migration:"
    "003_managed_connector_control_plane"
)

REQUIRED_BASE_TABLES = (
    "clients",
    "channel_accounts",
    "message_reply_jobs",
)

REQUIRED_MANAGED_TABLES = (
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


class MigrationSafetyError(RuntimeError):
    pass


def load_environment():
    try:
        from dotenv import load_dotenv
    except ImportError:
        return

    load_dotenv(
        PROJECT_ROOT / ".env"
    )


def required_database_environment():
    load_environment()

    names = (
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    )

    values = {
        name: os.getenv(name)
        for name in names
    }

    missing = [
        name
        for name, value in values.items()
        if not str(value or "").strip()
    ]

    if missing:
        raise MigrationSafetyError(
            "Missing database environment values: "
            + ", ".join(missing)
        )

    return values


def get_connection():
    try:
        import psycopg2
    except ImportError as error:
        raise MigrationSafetyError(
            "psycopg2 is required to run "
            "the migration preflight"
        ) from error

    environment = (
        required_database_environment()
    )

    return psycopg2.connect(
        host=environment["DB_HOST"],
        port=environment["DB_PORT"],
        database=environment["DB_NAME"],
        user=environment["DB_USER"],
        password=environment["DB_PASSWORD"],
        connect_timeout=10,
        application_name=(
            "omniflow-managed-connector-"
            "migration-003"
        ),
    )


def prepare_transaction_sql(sql):
    if (
        not isinstance(sql, str)
        or not sql.strip()
    ):
        raise MigrationSafetyError(
            "Migration SQL is empty"
        )

    unsupported_meta_commands = [
        line.strip()
        for line in sql.splitlines()
        if line.lstrip().startswith("\\")
        and not (
            line
            .lstrip()
            .lower()
            .startswith(
                "\\set on_error_stop"
            )
        )
    ]

    if unsupported_meta_commands:
        raise MigrationSafetyError(
            "Unsupported psql meta-command "
            "in migration: "
            + unsupported_meta_commands[0]
        )

    prepared_lines = [
        line
        for line in sql.splitlines()
        if not (
            line
            .lstrip()
            .lower()
            .startswith(
                "\\set on_error_stop"
            )
        )
    ]

    prepared = "\n".join(
        prepared_lines
    ).strip()

    prepared = re.sub(
        r"\A\s*BEGIN\s*;",
        "",
        prepared,
        count=1,
        flags=re.IGNORECASE,
    ).strip()

    prepared = re.sub(
        r"COMMIT\s*;\s*\Z",
        "",
        prepared,
        count=1,
        flags=re.IGNORECASE,
    ).strip()

    if not prepared:
        raise MigrationSafetyError(
            "Migration contains no "
            "transactional SQL"
        )

    return prepared


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
        raise MigrationSafetyError(
            "Expected a database result row"
        )

    return row[0]


def table_exists(
    cursor,
    table_name,
):
    return bool(
        scalar(
            cursor,
            (
                "SELECT to_regclass(%s) "
                "IS NOT NULL"
            ),
            (
                f"public.{table_name}",
            ),
        )
    )


def capture_preflight(cursor):
    missing_base_tables = [
        table
        for table in REQUIRED_BASE_TABLES
        if not table_exists(
            cursor,
            table,
        )
    ]

    if missing_base_tables:
        raise MigrationSafetyError(
            "Required base tables are missing: "
            + ", ".join(
                missing_base_tables
            )
        )

    account_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM channel_accounts"
            ),
        )
    )

    client_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM clients"
            ),
        )
    )

    reply_job_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM message_reply_jobs"
            ),
        )
    )

    cursor.execute(
        """
        SELECT
            client_id,
            status,
            external_account_id
        FROM channel_accounts
        WHERE id = 1
        """
    )

    account_one = cursor.fetchone()

    return {
        "account_count": account_count,
        "client_count": client_count,
        "reply_job_count": (
            reply_job_count
        ),
        "account_one": account_one,
    }


def verify_post_apply(
    cursor,
    before,
):
    missing_managed_tables = [
        table
        for table
        in REQUIRED_MANAGED_TABLES
        if not table_exists(
            cursor,
            table,
        )
    ]

    if missing_managed_tables:
        raise MigrationSafetyError(
            "Managed tables missing "
            "after migration: "
            + ", ".join(
                missing_managed_tables
            )
        )

    account_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM channel_accounts"
            ),
        )
    )

    client_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM clients"
            ),
        )
    )

    reply_job_count = int(
        scalar(
            cursor,
            (
                "SELECT COUNT(*) "
                "FROM message_reply_jobs"
            ),
        )
    )

    if (
        account_count
        != before["account_count"]
    ):
        raise MigrationSafetyError(
            "Channel account count changed "
            "during migration"
        )

    if (
        client_count
        != before["client_count"]
    ):
        raise MigrationSafetyError(
            "Client count changed "
            "during migration"
        )

    if (
        reply_job_count
        != before["reply_job_count"]
    ):
        raise MigrationSafetyError(
            "Reply-job count changed "
            "during migration"
        )

    missing_connections = int(
        scalar(
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
    )

    if missing_connections:
        raise MigrationSafetyError(
            "Channel connection backfill "
            "is incomplete"
        )

    cross_tenant_connections = int(
        scalar(
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
    )

    if cross_tenant_connections:
        raise MigrationSafetyError(
            "Cross-tenant channel "
            "connections detected"
        )

    if before["account_one"] is not None:
        cursor.execute(
            """
            SELECT
                account.client_id,
                account.status,
                account.external_account_id,
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

        account_one_after = (
            cursor.fetchone()
        )

        if account_one_after is None:
            raise MigrationSafetyError(
                "Account 1 connection "
                "backfill is missing"
            )

        if (
            account_one_after[:3]
            != before["account_one"]
        ):
            raise MigrationSafetyError(
                "Account 1 identity changed "
                "during migration"
            )

        if (
            account_one_after[3]
            != "local_web"
        ):
            raise MigrationSafetyError(
                "Account 1 account mode "
                "was not preserved"
            )

        if (
            account_one_after[4]
            != "local_web"
        ):
            raise MigrationSafetyError(
                "Account 1 connection mode "
                "was not preserved"
            )

        if (
            account_one_after[5]
            != "created"
        ):
            raise MigrationSafetyError(
                "Account 1 connection status "
                "is unexpected"
            )

        if account_one_after[6] is not None:
            raise MigrationSafetyError(
                "Account 1 was unexpectedly "
                "assigned to a managed node"
            )

    return {
        "managed_table_count": len(
            REQUIRED_MANAGED_TABLES
        ),
        "account_count": account_count,
        "client_count": client_count,
        "reply_job_count": (
            reply_job_count
        ),
        "missing_connections": (
            missing_connections
        ),
        "cross_tenant_connections": (
            cross_tenant_connections
        ),
    }


def run_check():
    connection = get_connection()

    try:
        connection.set_session(
            readonly=True,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            snapshot = capture_preflight(
                cursor
            )

        connection.rollback()
        return snapshot

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def apply_migration(
    backup_confirmed=False,
):
    if not backup_confirmed:
        raise MigrationSafetyError(
            "Migration blocked: pass "
            "--backup-confirmed only after "
            "a restorable database backup "
            "has been created"
        )

    if not MIGRATION_PATH.exists():
        raise MigrationSafetyError(
            "Migration file not found: "
            f"{MIGRATION_PATH}"
        )

    migration_sql = (
        prepare_transaction_sql(
            MIGRATION_PATH.read_text(
                encoding="utf-8"
            )
        )
    )

    connection = get_connection()

    try:
        connection.set_session(
            readonly=False,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT pg_advisory_xact_lock(
                    hashtext(%s)
                )
                """,
                (
                    MIGRATION_LOCK_NAME,
                ),
            )

            before = capture_preflight(
                cursor
            )

            cursor.execute(
                migration_sql
            )

            result = verify_post_apply(
                cursor,
                before,
            )

        connection.commit()
        return result

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def build_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Safely check or apply managed "
            "connector migration 003"
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
        help=(
            "Run read-only migration "
            "prerequisites"
        ),
    )

    action.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply migration 003 "
            "transactionally"
        ),
    )

    parser.add_argument(
        "--backup-confirmed",
        action="store_true",
        help=(
            "Confirm a restorable backup "
            "exists before --apply"
        ),
    )

    return parser


def main(argv=None):
    arguments = (
        build_parser()
        .parse_args(argv)
    )

    if arguments.check:
        result = run_check()

        print(
            "Managed connector migration "
            "preflight: passed"
        )

        print(
            "Existing rows preserved "
            "by contract: "
            f"clients={result['client_count']}, "
            f"channel_accounts="
            f"{result['account_count']}, "
            f"reply_jobs="
            f"{result['reply_job_count']}"
        )

        print(
            "Account 1 present: "
            f"{result['account_one'] is not None}"
        )

        print(
            "\n✅ MIGRATION 003 READ-ONLY "
            "PREFLIGHT PASSED"
        )

        return 0

    result = apply_migration(
        backup_confirmed=(
            arguments.backup_confirmed
        )
    )

    print(
        "Migration 003 committed "
        "transactionally"
    )

    print(
        "Managed connector tables: "
        f"{result['managed_table_count']}/"
        f"{len(REQUIRED_MANAGED_TABLES)}"
    )

    print(
        "Backfilled channel connections "
        "missing: "
        f"{result['missing_connections']}"
    )

    print(
        "Cross-tenant channel connections: "
        f"{result['cross_tenant_connections']}"
    )

    print(
        "Account 1 preserved as local_web"
    )

    print(
        "\n✅ MIGRATION 003 APPLIED SAFELY"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())