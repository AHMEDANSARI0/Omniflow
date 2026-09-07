import re
import subprocess
from datetime import (
    datetime,
    timedelta,
    timezone,
)

from backup_postgres_before_migration_004 import (
    BACKUP_DIRECTORY,
    BackupSafetyError,
    find_postgres_tool,
    sha256_file,
)

from backup_postgres_before_migration_005 import (
    REQUIRED_ARCHIVE_TABLES,
)


MAX_BACKUP_AGE = timedelta(
    hours=24
)


def latest_backup():
    candidates = [
        path
        for path
        in BACKUP_DIRECTORY.glob(
            "pre_migration_005_*.dump"
        )
        if path.is_file()
    ]

    if not candidates:
        raise BackupSafetyError(
            "No pre-migration 005 "
            "backup was found"
        )

    return max(
        candidates,
        key=lambda path: (
            path.stat().st_mtime
        ),
    )


def verify_latest_backup():
    backup_path = latest_backup()

    checksum_path = (
        backup_path.with_suffix(
            backup_path.suffix
            + ".sha256"
        )
    )

    if (
        backup_path.stat().st_size
        < 1024
    ):
        raise BackupSafetyError(
            "Backup archive is "
            "unexpectedly small"
        )

    if not checksum_path.is_file():
        raise BackupSafetyError(
            "Checksum file is missing: "
            f"{checksum_path}"
        )

    checksum_parts = (
        checksum_path.read_text(
            encoding="ascii"
        )
        .strip()
        .split()
    )

    if len(checksum_parts) != 2:
        raise BackupSafetyError(
            "Checksum file format "
            "is invalid"
        )

    expected_digest = (
        checksum_parts[0]
    )

    expected_name = (
        checksum_parts[1]
    )

    if not re.fullmatch(
        r"[0-9a-fA-F]{64}",
        expected_digest,
    ):
        raise BackupSafetyError(
            "Checksum digest format "
            "is invalid"
        )

    if (
        expected_name
        != backup_path.name
    ):
        raise BackupSafetyError(
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
        raise BackupSafetyError(
            "Backup SHA-256 "
            "verification failed"
        )

    modified_at = (
        datetime.fromtimestamp(
            backup_path.stat().st_mtime,
            tz=timezone.utc,
        )
    )

    age = (
        datetime.now(timezone.utc)
        - modified_at
    )

    if age < timedelta(minutes=-5):
        raise BackupSafetyError(
            "Backup timestamp is "
            "unexpectedly in the future"
        )

    if age > MAX_BACKUP_AGE:
        raise BackupSafetyError(
            "Latest pre-migration 005 "
            "backup is older than 24 hours"
        )

    pg_restore = find_postgres_tool(
        "pg_restore"
    )

    restore_check = subprocess.run(
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

    if restore_check.returncode != 0:
        raise BackupSafetyError(
            restore_check.stderr.strip()
            or (
                "pg_restore could not read "
                "the backup archive"
            )
        )

    listing = (
        restore_check.stdout.lower()
    )

    missing = [
        table
        for table
        in REQUIRED_ARCHIVE_TABLES
        if table not in listing
    ]

    if missing:
        raise BackupSafetyError(
            "Backup archive listing "
            "is missing: "
            + ", ".join(missing)
        )

    return {
        "backup_path": backup_path,
        "checksum_path":
            checksum_path,
        "size":
            backup_path.stat().st_size,
        "sha256":
            actual_digest.lower(),
        "modified_at":
            modified_at,
        "age_seconds":
            max(
                0,
                int(
                    age.total_seconds()
                ),
            ),
    }


def main():
    result = verify_latest_backup()

    print(
        "Pre-migration 005 backup "
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

    print(
        "Required pre-005 tables: "
        "12/12"
    )

    print("")
    print(
        "PRE-MIGRATION 005 BACKUP "
        "REVERIFICATION PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
