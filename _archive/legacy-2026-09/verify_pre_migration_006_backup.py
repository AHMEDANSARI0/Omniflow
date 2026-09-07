import re
import subprocess
from datetime import datetime, timedelta, timezone

from backup_postgres_before_migration_004 import (
    BACKUP_DIRECTORY,
    BackupSafetyError,
    find_postgres_tool,
    sha256_file,
)
from backup_postgres_before_migration_006 import (
    REQUIRED_ARCHIVE_TABLES,
)


MAX_BACKUP_AGE = timedelta(hours=24)


def latest_backup():
    candidates = [
        path
        for path in BACKUP_DIRECTORY.glob(
            "pre_migration_006_*.dump"
        )
        if path.is_file()
    ]

    if not candidates:
        raise BackupSafetyError(
            "No pre-migration 006 backup was found"
        )

    return max(
        candidates,
        key=lambda path: path.stat().st_mtime,
    )


def verify_latest_backup():
    backup_path = latest_backup()
    checksum_path = backup_path.with_suffix(
        backup_path.suffix + ".sha256"
    )

    if backup_path.stat().st_size < 1024:
        raise BackupSafetyError(
            "Backup archive is unexpectedly small"
        )

    if not checksum_path.is_file():
        raise BackupSafetyError(
            f"Checksum file is missing: {checksum_path}"
        )

    parts = checksum_path.read_text(
        encoding="ascii"
    ).strip().split()

    if len(parts) != 2:
        raise BackupSafetyError(
            "Checksum file format is invalid"
        )

    expected_digest, expected_name = parts

    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_digest):
        raise BackupSafetyError(
            "Checksum digest format is invalid"
        )

    if expected_name != backup_path.name:
        raise BackupSafetyError(
            "Checksum filename does not match backup"
        )

    actual_digest = sha256_file(backup_path)

    if actual_digest.lower() != expected_digest.lower():
        raise BackupSafetyError(
            "Backup SHA-256 verification failed"
        )

    modified_at = datetime.fromtimestamp(
        backup_path.stat().st_mtime,
        tz=timezone.utc,
    )
    age = datetime.now(timezone.utc) - modified_at

    if age < timedelta(minutes=-5):
        raise BackupSafetyError(
            "Backup timestamp is unexpectedly in the future"
        )

    if age > MAX_BACKUP_AGE:
        raise BackupSafetyError(
            "Latest pre-migration 006 backup is older than 24 hours"
        )

    restore_check = subprocess.run(
        [
            str(find_postgres_tool("pg_restore")),
            "--list",
            str(backup_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    if restore_check.returncode != 0:
        raise BackupSafetyError(
            restore_check.stderr.strip()
            or "pg_restore could not read the backup archive"
        )

    listing = restore_check.stdout.lower()
    missing = [
        table
        for table in REQUIRED_ARCHIVE_TABLES
        if table not in listing
    ]

    if missing:
        raise BackupSafetyError(
            "Backup archive listing is missing: "
            + ", ".join(missing)
        )

    return {
        "backup_path": backup_path,
        "checksum_path": checksum_path,
        "size": backup_path.stat().st_size,
        "sha256": actual_digest.lower(),
        "modified_at": modified_at,
        "age_seconds": max(0, int(age.total_seconds())),
    }


def main():
    result = verify_latest_backup()
    print("Pre-migration 006 backup reverified")
    print(f"Backup file: {result['backup_path']}")
    print(f"Backup bytes: {result['size']}")
    print(f"SHA-256: {result['sha256']}")
    print(f"Checksum file: {result['checksum_path']}")
    print(f"Backup UTC timestamp: {result['modified_at'].isoformat()}")
    print(f"Backup age seconds: {result['age_seconds']}")
    print("pg_restore archive listing: verified")
    print("Required pre-006 tables: 8/8")
    print("\nPRE-MIGRATION 006 BACKUP REVERIFICATION PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
