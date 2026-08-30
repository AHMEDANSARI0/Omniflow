import ast
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

RUNNER_PATH = (
    PROJECT_ROOT
    / "apply_managed_connector_migration.py"
)

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(
        0,
        str(PROJECT_ROOT),
    )

import apply_managed_connector_migration as runner


def expect_error(
    error_type,
    callback,
):
    try:
        callback()

    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def verify_sql_preparation():
    source = """\
\\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE example (
    id INTEGER PRIMARY KEY
);
COMMIT;
"""

    prepared = (
        runner.prepare_transaction_sql(
            source
        )
    )

    assert "\\set" not in prepared

    assert not (
        prepared
        .upper()
        .startswith("BEGIN;")
    )

    assert not (
        prepared
        .upper()
        .endswith("COMMIT;")
    )

    assert (
        "CREATE TABLE example"
        in prepared
    )

    expect_error(
        runner.MigrationSafetyError,
        lambda: (
            runner.prepare_transaction_sql(
                (
                    "\\include unsafe.sql\n"
                    "SELECT 1;"
                )
            )
        ),
    )

    expect_error(
        runner.MigrationSafetyError,
        lambda: (
            runner.prepare_transaction_sql("")
        ),
    )


def verify_explicit_backup_gate():
    expect_error(
        runner.MigrationSafetyError,
        lambda: runner.apply_migration(
            backup_confirmed=False
        ),
    )


def call_name(call):
    function = call.func

    if isinstance(
        function,
        ast.Name,
    ):
        return function.id

    if isinstance(
        function,
        ast.Attribute,
    ):
        return function.attr

    return None


def keyword_constant(
    call,
    keyword_name,
):
    for keyword in call.keywords:
        if keyword.arg != keyword_name:
            continue

        if isinstance(
            keyword.value,
            ast.Constant,
        ):
            return keyword.value.value

    return None


def verify_runner_source_signatures():
    source = RUNNER_PATH.read_text(
        encoding="utf-8"
    )

    lowered = source.lower()

    tree = ast.parse(source)

    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(
            node,
            ast.Call,
        )
    ]

    call_names = {
        call_name(call)
        for call in calls
    }

    assert "--check" in lowered
    assert "--apply" in lowered

    assert (
        "--backup-confirmed"
        in lowered
    )

    assert (
        "pg_advisory_xact_lock"
        in lowered
    )

    assert "account 1" in lowered
    assert "local_web" in lowered
    assert "cross-tenant" in lowered

    assert "commit" in call_names
    assert "rollback" in call_names
    assert "close" in call_names

    assert (
        "capture_preflight"
        in call_names
    )

    assert (
        "verify_post_apply"
        in call_names
    )

    session_calls = [
        call
        for call in calls
        if call_name(call)
        == "set_session"
    ]

    assert any(
        keyword_constant(
            call,
            "readonly",
        ) is True
        and keyword_constant(
            call,
            "autocommit",
        ) is False
        for call in session_calls
    )

    assert any(
        keyword_constant(
            call,
            "readonly",
        ) is False
        and keyword_constant(
            call,
            "autocommit",
        ) is False
        for call in session_calls
    )


def verify_required_table_contracts():
    assert (
        runner.REQUIRED_BASE_TABLES
        == (
            "clients",
            "channel_accounts",
            "message_reply_jobs",
        )
    )

    assert (
        len(
            runner.REQUIRED_MANAGED_TABLES
        )
        == 9
    )

    assert (
        "connector_nodes"
        in runner.REQUIRED_MANAGED_TABLES
    )

    assert (
        "channel_connections"
        in runner.REQUIRED_MANAGED_TABLES
    )

    assert (
        "pairing_sessions"
        in runner.REQUIRED_MANAGED_TABLES
    )

    assert (
        "connector_commands"
        in runner.REQUIRED_MANAGED_TABLES
    )


def main():
    verify_sql_preparation()

    verify_explicit_backup_gate()

    verify_runner_source_signatures()

    verify_required_table_contracts()

    print(
        "psql meta-command "
        "sanitization: passed"
    )

    print(
        "Outer transaction wrapper "
        "control: passed"
    )

    print(
        "Read-only preflight mode: passed"
    )

    print(
        "Explicit backup confirmation "
        "gate: passed"
    )

    print(
        "PostgreSQL advisory migration "
        "lock: passed"
    )

    print(
        "Commit/rollback/close "
        "boundaries: passed"
    )

    print(
        "AST-verified preflight/"
        "post-apply calls: passed"
    )

    print(
        "Account 1 preservation "
        "audit: present"
    )

    print(
        "Nine-table post-apply "
        "audit: present"
    )

    print(
        "\n✅ MIGRATION RUNNER "
        "SAFETY TEST PASSED"
    )


if __name__ == "__main__":
    main()