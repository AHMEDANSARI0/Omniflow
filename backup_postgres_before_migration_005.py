import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from backup_postgres_before_migration_004 import (
    BACKUP_DIRECTORY,
    BackupSafetyError,
    database_environment,
    find_postgres_tool,
    sha256_file,
)


REQUIRED_ARCHIVE_TABLES = (
    "clients",
    "channel_accounts",
    "message_reply_jobs",
    "platform_users",
    "channel_connections",
    "connector_nodes",
    "ai_agents",
    "ai_agent_versions",
    "channel_agent_assignments",
    "client_trial_entitlements",
    "client_usage_counters",
    "onboarding_requests",
)


def create_verified_backup():
    database = database_environment()

    pg_dump = find_postgres_tool(
        "pg_dump"
    )
    pg_restore = find_postgres_tool(
        "pg_restore"
    )

    BACKUP_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    timestamp = (
        datetime.now(timezone.utc)
        .strftime("%Y%m%dT%H%M%SZ")
    )

    final_path = (
        BACKUP_DIRECTORY
        / (
            "pre_migration_005_"
            f"{timestamp}.dump"
        )
    )

    partial_path = (
        final_path.with_suffix(
            ".dump.partial"
        )
    )

    if partial_path.exists():
        partial_path.unlink()

    child_environment = (
        os.environ.copy()
    )

    child_environment["PGPASSWORD"] = (
        database["DB_PASSWORD"]
    )

    dump_command = [
        str(pg_dump),
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--no-password",
        "--host",
        database["DB_HOST"],
        "--port",
        database["DB_PORT"],
        "--username",
        database["DB_USER"],
        "--dbname",
        database["DB_NAME"],
        "--file",
        str(partial_path),
    ]

    try:
        dump_result = subprocess.run(
            dump_command,
            env=child_environment,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
    finally:
        child_environment.pop(
            "PGPASSWORD",
            None,
        )

    if dump_result.returncode != 0:
        if partial_path.exists():
            partial_path.unlink()

        raise BackupSafetyError(
            dump_result.stderr.strip()
            or (
                "pg_dump failed without "
                "an error message"
            )
        )

    if not partial_path.is_file():
        raise BackupSafetyError(
            "pg_dump reported success but "
            "created no backup file"
        )

    if (
        partial_path.stat().st_size
        < 1024
    ):
        partial_path.unlink()

        raise BackupSafetyError(
            "Backup archive is "
            "unexpectedly small"
        )

    restore_check = subprocess.run(
        [
            str(pg_restore),
            "--list",
            str(partial_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    if restore_check.returncode != 0:
        partial_path.unlink()

        raise BackupSafetyError(
            restore_check.stderr.strip()
            or (
                "pg_restore could not "
                "read the backup archive"
            )
        )

    archive_listing = (
        restore_check.stdout.lower()
    )

    missing = [
        table
        for table
        in REQUIRED_ARCHIVE_TABLES
        if table not in archive_listing
    ]

    if missing:
        partial_path.unlink()

        raise BackupSafetyError(
            "Backup archive listing "
            "is missing: "
            + ", ".join(missing)
        )

    partial_path.replace(
        final_path
    )

    digest = sha256_file(
        final_path
    )

    checksum_path = (
        final_path.with_suffix(
            final_path.suffix
            + ".sha256"
        )
    )

    checksum_path.write_text(
        (
            f"{digest}  "
            f"{final_path.name}\n"
        ),
        encoding="ascii",
    )

    return {
        "backup_path": final_path,
        "checksum_path":
            checksum_path,
        "size":
            final_path.stat().st_size,
        "sha256": digest,
    }


def main():
    result = create_verified_backup()

    print(
        "PostgreSQL custom-format "
        "backup created"
    )

    print(
        "Backup file: "
        f"{result['backup_path']}"
    )

    print(
        "Backup bytes: "
        f"{result['size']}"
    )

    print(
        "SHA-256: "
        f"{result['sha256']}"
    )

    print(
        "Checksum file: "
        f"{result['checksum_path']}"
    )

    print(
        "pg_restore archive listing: "
        "verified"
    )

    print(
        "Required pre-005 tables: "
        "12/12"
    )

    print("")
    print(
        "PRE-MIGRATION 005 DATABASE "
        "BACKUP PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
