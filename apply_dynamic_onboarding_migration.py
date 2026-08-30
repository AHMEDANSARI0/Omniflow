import argparse
from pathlib import Path

import apply_managed_connector_migration as base


PROJECT_ROOT = Path(__file__).resolve().parent

MIGRATION_PATH = (
    PROJECT_ROOT
    / "migrations"
    / "004_dynamic_onboarding_agents_trials.sql"
)

LOCK_NAME = (
    "omniflow:migration:"
    "004_dynamic_onboarding_agents_trials"
)

REQUIRED_TABLES = (
    "ai_agents",
    "ai_agent_versions",
    "channel_agent_assignments",
    "client_trial_entitlements",
    "client_usage_counters",
    "onboarding_requests",
)


def capture_before(cursor):
    required_base_tables = (
        "clients",
        "channel_accounts",
        "platform_users",
        "channel_connections",
        "connector_nodes",
    )

    for table in required_base_tables:
        if not base.table_exists(
            cursor,
            table,
        ):
            raise base.MigrationSafetyError(
                f"Required table is missing: {table}"
            )

    counts = {}

    for table in (
        "clients",
        "channel_accounts",
        "platform_users",
        "connector_nodes",
    ):
        counts[table] = int(
            base.scalar(
                cursor,
                f"SELECT COUNT(*) FROM {table}",
            )
        )

    cursor.execute(
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
        JOIN channel_connections connection
          ON connection.channel_account_id
             = account.id
         AND connection.client_id
             = account.client_id
        ORDER BY account.id
        """
    )

    account_states = cursor.fetchall()

    channel_account_count = counts[
        "channel_accounts"
    ]

    if len(account_states) != channel_account_count:
        raise base.MigrationSafetyError(
            "One or more channel accounts do not "
            "have a tenant-matched connection row"
        )

    return {
        "counts": counts,
        "account_states": account_states,
    }


def verify_after(
    cursor,
    before,
):
    missing = [
        table
        for table in REQUIRED_TABLES
        if not base.table_exists(
            cursor,
            table,
        )
    ]

    if missing:
        raise base.MigrationSafetyError(
            "Onboarding tables missing after "
            "migration: "
            + ", ".join(missing)
        )

    for table, expected in (
        before["counts"].items()
    ):
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

    cursor.execute(
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
        JOIN channel_connections connection
          ON connection.channel_account_id
             = account.id
         AND connection.client_id
             = account.client_id
        ORDER BY account.id
        """
    )

    account_states = cursor.fetchall()

    if (
        account_states
        != before["account_states"]
    ):
        raise base.MigrationSafetyError(
            "Existing channel account state changed"
        )

    cross_tenant_agents = int(
        base.scalar(
            cursor,
            """
            SELECT COUNT(*)
            FROM ai_agent_versions version
            JOIN ai_agents agent
              ON agent.id = version.agent_id
            WHERE version.client_id
                  <> agent.client_id
            """,
        )
    )

    cross_tenant_assignments = int(
        base.scalar(
            cursor,
            """
            SELECT COUNT(*)
            FROM channel_agent_assignments
                 assignment
            JOIN channel_accounts account
              ON account.id
                 = assignment.channel_account_id
            WHERE assignment.client_id
                  <> account.client_id
            """,
        )
    )

    if (
        cross_tenant_agents
        or cross_tenant_assignments
    ):
        raise base.MigrationSafetyError(
            "Cross-tenant onboarding rows detected"
        )

    return {
        "table_count": len(REQUIRED_TABLES),
        "cross_tenant_agents":
            cross_tenant_agents,
        "cross_tenant_assignments":
            cross_tenant_assignments,
        "existing_account_count":
            len(account_states),
    }


def migration_sql():
    if not MIGRATION_PATH.is_file():
        raise base.MigrationSafetyError(
            f"Migration file not found: "
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
            result = capture_before(cursor)

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
    if commit and not backup_confirmed:
        raise base.MigrationSafetyError(
            "Apply blocked until "
            "--backup-confirmed is provided"
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
                SELECT pg_advisory_xact_lock(
                    hashtext(%s)
                )
                """,
                (LOCK_NAME,),
            )

            before = capture_before(cursor)

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
            "Check, dry-run, or apply dynamic "
            "onboarding migration 004"
        )
    )

    action = (
        parser.add_mutually_exclusive_group(
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
            "Migration 004 read-only "
            "prerequisites: passed"
        )
        print(
            "Existing rows: "
            + ", ".join(
                f"{table}={count}"
                for table, count
                in result["counts"].items()
            )
        )
        print("")
        print(
            "MIGRATION 004 READ-ONLY "
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
            "Migration 004 SQL executed "
            "successfully"
        )
        print(
            "Transaction intentionally "
            "rolled back: True"
        )
        ending = (
            "MIGRATION 004 TRANSACTIONAL "
            "DRY RUN PASSED"
        )
    else:
        print(
            "Migration 004 committed "
            "transactionally"
        )
        ending = (
            "MIGRATION 004 APPLIED SAFELY"
        )

    print(
        "Onboarding tables verified: "
        f"{result['table_count']}/6"
    )
    print(
        "Existing channel accounts "
        "preserved: "
        f"{result['existing_account_count']}"
    )
    print(
        "Cross-tenant onboarding rows: "
        f"{result['cross_tenant_agents'] + result['cross_tenant_assignments']}"
    )
    print("")
    print(ending)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
