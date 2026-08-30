import glob
import hashlib
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
BACKUP_DIRECTORY = PROJECT_ROOT / "backups"

REQUIRED_ENVIRONMENT = (
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
)


class BackupSafetyError(RuntimeError):
    pass


def load_environment():
    try:
        from dotenv import load_dotenv
    except ImportError:
        return

    load_dotenv(
        PROJECT_ROOT / ".env"
    )


def database_environment():
    load_environment()

    values = {
        name: os.getenv(name)
        for name in REQUIRED_ENVIRONMENT
    }

    missing = [
        name
        for name, value in values.items()
        if not str(value or "").strip()
    ]

    if missing:
        raise BackupSafetyError(
            "Missing database environment values: "
            + ", ".join(missing)
        )

    return values


def postgres_tool_candidates(tool_name):
    executable_name = (
        f"{tool_name}.exe"
        if os.name == "nt"
        else tool_name
    )

    candidates = []

    from_path = shutil.which(tool_name)

    if from_path:
        candidates.append(from_path)

    override_name = (
        "PG_DUMP_PATH"
        if tool_name == "pg_dump"
        else "PG_RESTORE_PATH"
    )

    override = os.getenv(override_name)

    if override:
        candidates.append(override)

    if os.name == "nt":
        patterns = (
            rf"C:\Program Files\PostgreSQL"
            rf"\*\bin\{executable_name}",
            rf"C:\Program Files (x86)"
            rf"\PostgreSQL\*\bin"
            rf"\{executable_name}",
        )

        for pattern in patterns:
            candidates.extend(
                sorted(
                    glob.glob(pattern),
                    reverse=True,
                )
            )

    return tuple(
        dict.fromkeys(candidates)
    )


def find_postgres_tool(tool_name):
    for candidate in (
        postgres_tool_candidates(tool_name)
    ):
        path = Path(candidate)

        if path.is_file():
            return path

    raise BackupSafetyError(
        f"{tool_name} was not found. "
        "Install PostgreSQL client tools "
        "or set its explicit path in "
        "the environment."
    )


def sha256_file(path):
    digest = hashlib.sha256()

    with Path(path).open("rb") as handle:
        for chunk in iter(
            lambda: handle.read(
                1024 * 1024
            ),
            b"",
        ):
            digest.update(chunk)

    return digest.hexdigest()


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
            "pre_migration_004_"
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

        error_text = (
            dump_result.stderr.strip()
            or (
                "pg_dump failed without "
                "an error message"
            )
        )

        raise BackupSafetyError(
            error_text
        )

    if not partial_path.exists():
        raise BackupSafetyError(
            "pg_dump reported success but "
            "created no backup file"
        )

    backup_size = (
        partial_path.stat().st_size
    )

    if backup_size < 1024:
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
                "pg_restore could not read "
                "the backup archive"
            )
        )

    archive_listing = (
        restore_check.stdout.lower()
    )

    required_archive_tables = (
        "clients",
        "channel_accounts",
        "message_reply_jobs",
        "platform_users",
        "channel_connections",
        "connector_nodes",
    )

    for required_name in (
        required_archive_tables
    ):
        if (
            required_name
            not in archive_listing
        ):
            partial_path.unlink()

            raise BackupSafetyError(
                "Backup archive is missing "
                "required table listing: "
                + required_name
            )

    partial_path.replace(final_path)

    digest = sha256_file(final_path)

    checksum_path = (
        final_path.with_suffix(
            final_path.suffix + ".sha256"
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
        "checksum_path": checksum_path,
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
    print("")
    print(
        "PRE-MIGRATION 004 DATABASE "
        "BACKUP PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
