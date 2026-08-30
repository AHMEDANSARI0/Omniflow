import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

load_dotenv(PROJECT_ROOT / ".env")

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from account_lease import ChannelAccountLease  # noqa: E402


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def load_active_account_id():
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id
                    FROM channel_accounts
                    WHERE status = 'active'
                    ORDER BY id
                    LIMIT 1
                    """
                )
                row = cursor.fetchone()

    finally:
        conn.close()

    if row is None:
        raise RuntimeError(
            "No active channel account exists for the lease test"
        )

    return row[0]


def assert_no_live_test_conflict(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        worker_id,
                        lease_expires_at
                    FROM channel_account_leases
                    WHERE channel_account_id = %s
                      AND owner_token IS NOT NULL
                      AND lease_expires_at > CURRENT_TIMESTAMP
                    """,
                    (channel_account_id,)
                )
                row = cursor.fetchone()

    finally:
        conn.close()

    if row is not None:
        raise RuntimeError(
            "Lease test blocked: channel account is currently owned by "
            f"{row[0]} until {row[1]}. Stop all workers first."
        )


def expire_owner_for_test(
    channel_account_id,
    expected_owner_token
):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE channel_account_leases
                    SET
                        lease_expires_at = (
                            CURRENT_TIMESTAMP
                            - INTERVAL '1 second'
                        ),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE channel_account_id = %s
                      AND owner_token = %s::uuid
                    """,
                    (
                        channel_account_id,
                        str(expected_owner_token),
                    )
                )

                if cursor.rowcount != 1:
                    raise AssertionError(
                        "Expected lease owner could not be expired"
                    )

    finally:
        conn.close()


def cleanup_released_test_row(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM channel_account_leases
                    WHERE channel_account_id = %s
                      AND owner_token IS NULL
                    """,
                    (channel_account_id,)
                )

    finally:
        conn.close()


def main():
    channel_account_id = load_active_account_id()
    assert_no_live_test_conflict(
        channel_account_id
    )
    cleanup_released_test_row(
        channel_account_id
    )

    lease_a = ChannelAccountLease(
        channel_account_id,
        worker_id="lease-test-worker-a",
        lease_seconds=60,
        heartbeat_seconds=10,
    )
    lease_b = ChannelAccountLease(
        channel_account_id,
        worker_id="lease-test-worker-b",
        lease_seconds=60,
        heartbeat_seconds=10,
    )
    lease_c = ChannelAccountLease(
        channel_account_id,
        worker_id="lease-test-worker-c",
        lease_seconds=60,
        heartbeat_seconds=10,
    )

    try:
        status_a = lease_a.acquire()
        assert status_a is not None
        assert status_a["worker_id"] == (
            "lease-test-worker-a"
        )
        assert lease_a.acquired is True

        # A second host/process cannot own the same live channel account.
        assert lease_b.acquire() is None
        assert lease_b.acquired is False

        # The owner can extend its expiry without changing its fencing token.
        assert lease_a.heartbeat() is True
        status_after_heartbeat = lease_a.get_status()
        assert status_after_heartbeat[
            "owner_token"
        ] == str(lease_a.owner_token)

        # A non-owner cannot clear the active lease.
        assert lease_b.release() is False
        assert lease_a.get_status()[
            "owner_token"
        ] == str(lease_a.owner_token)

        # A graceful release permits immediate ownership by another worker.
        assert lease_a.release() is True
        status_b = lease_b.acquire()
        assert status_b is not None
        assert status_b["worker_id"] == (
            "lease-test-worker-b"
        )

        # Simulate a crashed worker whose heartbeat stopped. A third worker
        # must atomically take over after expiry.
        expire_owner_for_test(
            channel_account_id,
            lease_b.owner_token
        )
        status_c = lease_c.acquire()
        assert status_c is not None
        assert status_c["worker_id"] == (
            "lease-test-worker-c"
        )
        assert status_c["owner_token"] == (
            str(lease_c.owner_token)
        )

        # The stale owner's fencing token can no longer mutate or release row.
        assert lease_b.heartbeat() is False
        assert lease_b.release() is False
        assert lease_c.heartbeat() is True

        assert lease_c.release() is True
        final_status = lease_c.get_status()
        assert final_status["owner_token"] is None
        assert final_status["worker_id"] is None
        assert final_status[
            "lease_expires_at"
        ] is None
        assert final_status["released_at"] is not None

        print(
            f"Dynamic channel account: {channel_account_id}"
        )
        print("First distributed owner acquired: 1")
        print("Concurrent duplicate owner rejected: 1")
        print("Owner heartbeat extended: 1")
        print("Non-owner release rejected: 1")
        print("Graceful ownership handoff: 1")
        print("Expired lease takeover: 1")
        print("Stale fencing token rejected: 1")
        print("Final lease released: 1")
        print(
            "\nCHANNEL ACCOUNT LEASE TEST PASSED"
        )

    finally:
        lease_a.stop(release=True)
        lease_b.stop(release=True)
        lease_c.stop(release=True)
        cleanup_released_test_row(
            channel_account_id
        )
        print("Temporary lease row cleaned up")


if __name__ == "__main__":
    main()
