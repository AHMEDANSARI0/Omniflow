import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backup_postgres_before_migration_004 import (
    find_postgres_tool,
    sha256_file,
)


PROJECT_ROOT = Path(__file__).resolve().parent
BACKUP_DIRECTORY = PROJECT_ROOT / "backups"
MAX_BACKUP_AGE = timedelta(hours=24)

REQUIRED_ARCHIVE_TABLES = (
    "clients",
    "channel_accounts",
    "message_reply_jobs",
    "platform_users",
    "channel_connections",
    "connector_nodes",
)


class BackupVerificationError(RuntimeError):
    pass


def latest_backup():
    candidates = [
        path
        for path in BACKUP_DIRECTORY.glob(
            "pre_migration_004_*.dump"
        )
        if path.is_file()
    ]

    if not candidates:
        raise BackupVerificationError(
            "No pre-migration 004 backup "
            "was found"
        )

    return max(
        candidates,
        key=lambda path: (
            path.stat().st_mtime
        ),
    )


def verify_checksum(backup_path):
    checksum_path = (
        backup_path.with_suffix(
            backup_path.suffix + ".sha256"
        )
    )

    if not checksum_path.is_file():
        raise BackupVerificationError(
            "Checksum file is missing: "
            f"{checksum_path}"
        )

    parts = (
        checksum_path.read_text(
            encoding="ascii"
        )
        .strip()
        .split()
    )

    if len(parts) != 2:
        raise BackupVerificationError(
            "Checksum file format is invalid"
        )

    expected_digest = parts[0]
    expected_name = parts[1]

    if not re.fullmatch(
        r"[0-9a-fA-F]{64}",
        expected_digest,
    ):
        raise BackupVerificationError(
            "Checksum digest format is invalid"
        )

    if expected_name != backup_path.name:
        raise BackupVerificationError(
            "Checksum filename does not "
            "match backup"
        )

    actual_digest = sha256_file(
        backup_path
    )

    if (
        actual_digest.lower()
        != expected_digest.lower()
    ):
        raise BackupVerificationError(
            "Backup SHA-256 verification failed"
        )

    return (
        checksum_path,
        actual_digest.lower(),
    )


def verify_freshness(backup_path):
    modified_at = datetime.fromtimestamp(
        backup_path.stat().st_mtime,
        tz=timezone.utc,
    )

    now = datetime.now(timezone.utc)
    age = now - modified_at

    if age < timedelta(minutes=-5):
        raise BackupVerificationError(
            "Backup timestamp is "
            "unexpectedly in the future"
        )

    if age > MAX_BACKUP_AGE:
        raise BackupVerificationError(
            "Latest pre-migration 004 "
            "backup is older than 24 hours"
        )

    if age < timedelta(0):
        age = timedelta(0)

    return modified_at, age


def verify_archive(backup_path):
    pg_restore = find_postgres_tool(
        "pg_restore"
    )

    result = subprocess.run(
        [
            str(pg_restore),
            "--list",
            str(backup_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    if result.returncode != 0:
        raise BackupVerificationError(
            result.stderr.strip()
            or (
                "pg_restore could not "
                "read the backup"
            )
        )

    listing = result.stdout.lower()

    missing = [
        table
        for table in REQUIRED_ARCHIVE_TABLES
        if table not in listing
    ]

    if missing:
        raise BackupVerificationError(
            "Backup archive listing "
            "is missing: "
            + ", ".join(missing)
        )

    return pg_restore


def verify_latest_backup():
    backup_path = latest_backup()

    if backup_path.stat().st_size < 1024:
        raise BackupVerificationError(
            "Backup archive is "
            "unexpectedly small"
        )

    checksum_path, digest = (
        verify_checksum(backup_path)
    )

    modified_at, age = (
        verify_freshness(backup_path)
    )

    pg_restore = verify_archive(
        backup_path
    )

    return {
        "backup_path": backup_path,
        "checksum_path": checksum_path,
        "sha256": digest,
        "size":
            backup_path.stat().st_size,
        "modified_at": modified_at,
        "age_seconds":
            int(age.total_seconds()),
        "pg_restore": pg_restore,
    }


def main():
    result = verify_latest_backup()

    print(
        "Pre-migration 004 backup "
        "reverified"
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
        "Backup UTC timestamp: "
        f"{result['modified_at'].isoformat()}"
    )
    print(
        "Backup age seconds: "
        f"{result['age_seconds']}"
    )
    print(
        "pg_restore archive listing: "
        "verified"
    )
    print("")
    print(
        "PRE-MIGRATION 004 BACKUP "
        "REVERIFICATION PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
