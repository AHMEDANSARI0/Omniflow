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

import run_channel  # noqa: E402
from account_lease import ChannelAccountLease  # noqa: E402


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def load_active_account():
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
            "No active channel account exists for the runtime lease test"
        )

    return run_channel.load_channel_account(
        row[0]
    )


def assert_no_live_owner(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT worker_id, lease_expires_at
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
            "Runtime lease test blocked: account is owned by "
            f"{row[0]} until {row[1]}. Stop all workers first."
        )


def read_lease_owner(channel_account_id):
    conn = get_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT owner_token, worker_id, lease_expires_at
                    FROM channel_account_leases
                    WHERE channel_account_id = %s
                    """,
                    (channel_account_id,)
                )
                return cursor.fetchone()

    finally:
        conn.close()


def cleanup_released_row(channel_account_id):
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
    account = load_active_account()
    assert_no_live_owner(account.id)
    cleanup_released_row(account.id)

    worker_calls = []
    heartbeat_seen = []

    def fake_worker(channel_account, account_lease):
        worker_calls.append(channel_account.id)
        heartbeat_seen.append(
            account_lease.heartbeat_running
        )
        assert account_lease.acquired is True
        assert account_lease.lease_lost is False
        return 0

    blocker = ChannelAccountLease(
        account.id,
        worker_id="runtime-integration-blocker",
        lease_seconds=60,
        heartbeat_seconds=10,
        connection_factory=get_connection,
    )

    try:
        # The runtime must acquire and heartbeat before invoking any adapter or
        # browser work, then release after the worker exits normally.
        return_code = run_channel.run_with_account_lease(
            account,
            worker_runner=fake_worker
        )
        assert return_code == 0
        assert worker_calls == [account.id]
        assert heartbeat_seen == [True]

        released_row = read_lease_owner(
            account.id
        )
        assert released_row is not None
        assert released_row[0] is None
        assert released_row[1] is None
        assert released_row[2] is None

        # Hold the same account from a simulated second host. The generic
        # runtime must return its dedicated busy code before fake_worker (and
        # therefore before a real browser adapter) can run.
        assert blocker.acquire() is not None
        blocker.start_heartbeat()

        busy_return_code = (
            run_channel.run_with_account_lease(
                account,
                worker_runner=fake_worker
            )
        )
        assert busy_return_code == (
            run_channel.LEASE_BUSY_EXIT_CODE
        )
        assert worker_calls == [account.id]
        assert blocker.acquired is True
        assert blocker.heartbeat_running is True

        print(f"Dynamic channel account: {account.id}")
        print("Lease acquired before worker invocation: 1")
        print("Heartbeat running before worker invocation: 1")
        print("Lease released after normal shutdown: 1")
        print("Concurrent runtime returned busy code 75: 1")
        print("Duplicate browser launch prevented: 1")
        print(
            "\n LEASED CHANNEL RUNTIME TEST PASSED"
        )

    finally:
        blocker.stop(release=True)
        cleanup_released_row(account.id)
        print("Temporary runtime lease row cleaned up")


if __name__ == "__main__":
    main()
