import apply_managed_connector_migration as runner


def run_transactional_dry_run():
    if not runner.MIGRATION_PATH.exists():
        raise runner.MigrationSafetyError(
            "Migration file not found: "
            f"{runner.MIGRATION_PATH}"
        )

    migration_sql = (
        runner.prepare_transaction_sql(
            runner.MIGRATION_PATH.read_text(
                encoding="utf-8"
            )
        )
    )

    connection = (
        runner.get_connection()
    )

    rolled_back = False

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
                    runner.MIGRATION_LOCK_NAME,
                ),
            )

            before = (
                runner.capture_preflight(
                    cursor
                )
            )

            cursor.execute(
                migration_sql
            )

            result = (
                runner.verify_post_apply(
                    cursor,
                    before,
                )
            )

        connection.rollback()
        rolled_back = True

        return result

    except Exception:
        connection.rollback()
        rolled_back = True
        raise

    finally:
        if not rolled_back:
            connection.rollback()

        connection.close()


def main():
    result = (
        run_transactional_dry_run()
    )

    print(
        "Migration 003 SQL "
        "executed successfully"
    )

    print(
        "Transaction intentionally "
        "rolled back: True"
    )

    print(
        "Managed connector tables "
        "verified inside dry run: "
        f"{result['managed_table_count']}/9"
    )

    print(
        "Backfill missing "
        "inside dry run: "
        f"{result['missing_connections']}"
    )

    print(
        "Cross-tenant rows "
        "inside dry run: "
        f"{result['cross_tenant_connections']}"
    )

    print(
        "\nMIGRATION 003 "
        "TRANSACTIONAL DRY RUN PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())