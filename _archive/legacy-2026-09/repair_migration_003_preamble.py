from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

MIGRATION_PATH = (
    PROJECT_ROOT
    / "migrations"
    / "003_managed_connector_control_plane.sql"
)


class MigrationRepairError(RuntimeError):
    pass


MISSING_PREAMBLE = """\

-- ============================================================
-- Managed connector/control-plane foundation
-- ============================================================
-- This migration is additive. Existing channel accounts
-- remain local_web until explicitly migrated in the future.

ALTER TABLE channel_accounts
ADD COLUMN IF NOT EXISTS connection_mode VARCHAR(30)
NOT NULL DEFAULT 'local_web';

DO $$
"""


def normalized_newlines(text):
    return (
        text
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )


def validate_repaired_migration(text):
    text = (
        normalized_newlines(text)
        .lstrip("\ufeff\n\r\t ")
    )

    lowered = text.lower()

    if not lowered.startswith("begin;"):
        raise MigrationRepairError(
            "Migration must start "
            "with outer BEGIN;"
        )

    required_column_sql = (
        "alter table channel_accounts\n"
        "add column if not exists "
        "connection_mode varchar(30)\n"
        "not null default 'local_web';"
    )

    if required_column_sql not in lowered:
        raise MigrationRepairError(
            "connection_mode preamble "
            "is missing"
        )

    first_do = lowered.find(
        "do $$"
    )

    first_procedural_if = (
        lowered.find(
            "if not exists (",
            first_do + 5,
        )
    )

    if (
        first_do < 0
        or first_procedural_if < 0
    ):
        raise MigrationRepairError(
            "Opening DO $$ block is missing "
            "before procedural IF"
        )

    opening_blocks = lowered.count(
        "do $$"
    )

    closing_blocks = lowered.count(
        "$$;"
    )

    if opening_blocks != closing_blocks:
        raise MigrationRepairError(
            "DO block opening/closing count "
            "does not match: "
            f"open={opening_blocks}, "
            f"close={closing_blocks}"
        )

    if opening_blocks < 2:
        raise MigrationRepairError(
            "Expected constraint and "
            "invariant DO blocks"
        )

    if not (
        lowered
        .rstrip()
        .endswith("commit;")
    ):
        raise MigrationRepairError(
            "Migration must end "
            "with COMMIT;"
        )

    for table in (
        "platform_users",
        "user_password_credentials",
        "client_memberships",
        "connector_nodes",
        "channel_connections",
        "pairing_sessions",
        "connector_events",
        "connector_commands",
        "control_plane_audit_log",
    ):
        signature = (
            "create table if not exists "
            f"{table}"
        )

        if signature not in lowered:
            raise MigrationRepairError(
                "Required table definition "
                f"missing: {table}"
            )

    return {
        "opening_do_blocks": (
            opening_blocks
        ),
        "closing_do_blocks": (
            closing_blocks
        ),
        "required_tables": 9,
    }


def repair_migration(
    path=MIGRATION_PATH,
):
    path = Path(path)

    if not path.exists():
        raise MigrationRepairError(
            "Migration file does not exist: "
            f"{path}"
        )

    original_bytes = path.read_bytes()

    try:
        original = (
            original_bytes.decode(
                "utf-8-sig"
            )
        )

    except UnicodeDecodeError as error:
        raise MigrationRepairError(
            "Migration file is not "
            "valid UTF-8"
        ) from error

    text = normalized_newlines(
        original
    )

    stripped = text.lstrip(
        "\n\r\t "
    )

    lowered = stripped.lower()

    required_column_marker = (
        "add column if not exists "
        "connection_mode varchar(30)"
    )

    if required_column_marker in lowered:
        result = (
            validate_repaired_migration(
                stripped
            )
        )

        return {
            **result,
            "changed": False,
            "backup_path": None,
            "migration_path": path,
        }

    inner_block_prefix = (
        "begin\n"
        "    if not exists ("
    )

    outer_and_inner_prefix = (
        "begin;\n"
        "begin\n"
        "    if not exists ("
    )

    if lowered.startswith(
        inner_block_prefix
    ):
        repaired = (
            "BEGIN;"
            + MISSING_PREAMBLE
            + stripped
        )

    elif lowered.startswith(
        outer_and_inner_prefix
    ):
        first_outer_end = (
            stripped.find("\n")
        )

        repaired = (
            stripped[:first_outer_end]
            + MISSING_PREAMBLE
            + stripped[
                first_outer_end + 1:
            ]
        )

    else:
        preview = "\\n".join(
            stripped.splitlines()[:5]
        )

        raise MigrationRepairError(
            "Migration does not match "
            "a known safe repair signature. "
            f"First lines: {preview}"
        )

    result = (
        validate_repaired_migration(
            repaired
        )
    )

    backup_path = path.with_suffix(
        path.suffix
        + ".before_preamble_repair"
    )

    if not backup_path.exists():
        backup_path.write_bytes(
            original_bytes
        )

    temporary_path = (
        path.with_suffix(
            path.suffix
            + ".repairing"
        )
    )

    temporary_path.write_text(
        repaired,
        encoding="utf-8",
        newline="\n",
    )

    temporary_path.replace(
        path
    )

    return {
        **result,
        "changed": True,
        "backup_path": backup_path,
        "migration_path": path,
    }


def main():
    result = repair_migration()

    print(
        "Migration preamble repaired: "
        f"{result['changed']}"
    )

    print(
        "Migration file: "
        f"{result['migration_path']}"
    )

    if result["backup_path"] is not None:
        print(
            "Original file backup: "
            f"{result['backup_path']}"
        )

    print(
        "DO blocks balanced: "
        f"{result['opening_do_blocks']}/"
        f"{result['closing_do_blocks']}"
    )

    print(
        "Required managed tables: "
        f"{result['required_tables']}/9"
    )

    print(
        "\n✅ MIGRATION 003 "
        "PREAMBLE REPAIR PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())