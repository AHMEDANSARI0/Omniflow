import os
import socket
import threading
import time
from uuid import uuid4

import psycopg2
from dotenv import load_dotenv


load_dotenv()


class ChannelAccountLease:
    """
    Database-backed exclusive lease for one channel account.

    The owner token, not a hostname or PID, is the fencing identity. Lease
    acquisition and stale takeover are serialized by PostgreSQL's row lock in
    INSERT ... ON CONFLICT DO UPDATE. A heartbeat keeps the lease alive; after
    expiry, another host may atomically take ownership.
    """

    def __init__(
        self,
        channel_account_id,
        worker_id=None,
        lease_seconds=120,
        heartbeat_seconds=30,
        connection_factory=None,
    ):
        self.channel_account_id = int(
            channel_account_id
        )

        if self.channel_account_id <= 0:
            raise ValueError(
                "channel_account_id must be positive"
            )

        self.lease_seconds = max(
            15,
            int(lease_seconds)
        )
        self.heartbeat_seconds = max(
            1,
            min(
                int(heartbeat_seconds),
                max(1, self.lease_seconds // 3)
            )
        )

        self.owner_token = uuid4()
        self.worker_id = str(
            worker_id
            or (
                f"{socket.gethostname()}:"
                f"{os.getpid()}:"
                f"{uuid4().hex[:8]}"
            )
        ).strip()

        if not self.worker_id:
            raise ValueError(
                "worker_id is required"
            )

        if len(self.worker_id) > 255:
            raise ValueError(
                "worker_id cannot exceed 255 characters"
            )

        self.connection_factory = (
            connection_factory
            or self._default_connection_factory
        )

        self._state_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._lease_lost = threading.Event()
        self._heartbeat_thread = None
        self._acquired = False
        self._last_success_monotonic = None
        self._last_heartbeat_error = None

    @staticmethod
    def _default_connection_factory():
        return psycopg2.connect(
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT"),
            database=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
        )

    @property
    def acquired(self):
        with self._state_lock:
            return self._acquired

    @property
    def lease_lost(self):
        return self._lease_lost.is_set()

    @property
    def last_heartbeat_error(self):
        return self._last_heartbeat_error

    @property
    def heartbeat_running(self):
        heartbeat_thread = self._heartbeat_thread
        return bool(
            heartbeat_thread is not None
            and heartbeat_thread.is_alive()
        )

    def _connect(self):
        conn = self.connection_factory()

        if conn is None:
            raise RuntimeError(
                "Lease connection factory returned None"
            )

        return conn

    @staticmethod
    def _row_to_status(row):
        if row is None:
            return None

        return {
            "channel_account_id": row[0],
            "owner_token": (
                str(row[1])
                if row[1] is not None
                else None
            ),
            "worker_id": row[2],
            "acquired_at": row[3],
            "heartbeat_at": row[4],
            "lease_expires_at": row[5],
            "released_at": row[6],
            "last_error": row[7],
        }

    def acquire(self):
        """Acquire an unowned/expired lease atomically; return status or None."""
        conn = self._connect()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO channel_account_leases (
                            channel_account_id,
                            owner_token,
                            worker_id,
                            acquired_at,
                            heartbeat_at,
                            lease_expires_at,
                            released_at,
                            last_error,
                            updated_at
                        )
                        SELECT
                            account.id,
                            %s::uuid,
                            %s,
                            CURRENT_TIMESTAMP,
                            CURRENT_TIMESTAMP,
                            (
                                CURRENT_TIMESTAMP
                                + (%s * INTERVAL '1 second')
                            ),
                            NULL,
                            NULL,
                            CURRENT_TIMESTAMP
                        FROM channel_accounts account
                        WHERE account.id = %s
                          AND account.status = 'active'
                        ON CONFLICT (channel_account_id)
                        DO UPDATE SET
                            owner_token = EXCLUDED.owner_token,
                            worker_id = EXCLUDED.worker_id,
                            acquired_at = CURRENT_TIMESTAMP,
                            heartbeat_at = CURRENT_TIMESTAMP,
                            lease_expires_at = (
                                CURRENT_TIMESTAMP
                                + (%s * INTERVAL '1 second')
                            ),
                            released_at = NULL,
                            last_error = NULL,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE
                            channel_account_leases.owner_token IS NULL
                            OR channel_account_leases.lease_expires_at
                                <= CURRENT_TIMESTAMP
                            OR channel_account_leases.owner_token
                                = EXCLUDED.owner_token
                        RETURNING
                            channel_account_id,
                            owner_token,
                            worker_id,
                            acquired_at,
                            heartbeat_at,
                            lease_expires_at,
                            released_at,
                            last_error
                        """,
                        (
                            str(self.owner_token),
                            self.worker_id,
                            self.lease_seconds,
                            self.channel_account_id,
                            self.lease_seconds,
                        )
                    )

                    row = cursor.fetchone()

        finally:
            conn.close()

        acquired = row is not None

        with self._state_lock:
            self._acquired = acquired

            if acquired:
                self._last_success_monotonic = (
                    time.monotonic()
                )
                self._last_heartbeat_error = None
                self._lease_lost.clear()
                self._stop_event.clear()

        return self._row_to_status(row)

    def heartbeat(self):
        """Extend this owner's lease. False means ownership was lost."""
        conn = self._connect()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE channel_account_leases
                        SET
                            heartbeat_at = CURRENT_TIMESTAMP,
                            lease_expires_at = (
                                CURRENT_TIMESTAMP
                                + (%s * INTERVAL '1 second')
                            ),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE channel_account_id = %s
                          AND owner_token = %s::uuid
                        RETURNING lease_expires_at
                        """,
                        (
                            self.lease_seconds,
                            self.channel_account_id,
                            str(self.owner_token),
                        )
                    )

                    row = cursor.fetchone()

        finally:
            conn.close()

        if row is None:
            with self._state_lock:
                self._acquired = False

            self._lease_lost.set()
            return False

        with self._state_lock:
            self._acquired = True
            self._last_success_monotonic = (
                time.monotonic()
            )
            self._last_heartbeat_error = None

        return True

    def record_error(self, error):
        """Attach an operational error to the lease if this worker owns it."""
        conn = self._connect()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE channel_account_leases
                        SET
                            last_error = %s,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE channel_account_id = %s
                          AND owner_token = %s::uuid
                        """,
                        (
                            str(error),
                            self.channel_account_id,
                            str(self.owner_token),
                        )
                    )

                    return cursor.rowcount == 1

        finally:
            conn.close()

    def release(self):
        """Release only if the row is still owned by this exact token."""
        conn = self._connect()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE channel_account_leases
                        SET
                            owner_token = NULL,
                            worker_id = NULL,
                            lease_expires_at = NULL,
                            released_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE channel_account_id = %s
                          AND owner_token = %s::uuid
                        """,
                        (
                            self.channel_account_id,
                            str(self.owner_token),
                        )
                    )

                    released = cursor.rowcount == 1

        finally:
            conn.close()

        with self._state_lock:
            self._acquired = False

        return released

    def get_status(self):
        conn = self._connect()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            channel_account_id,
                            owner_token,
                            worker_id,
                            acquired_at,
                            heartbeat_at,
                            lease_expires_at,
                            released_at,
                            last_error
                        FROM channel_account_leases
                        WHERE channel_account_id = %s
                        """,
                        (self.channel_account_id,)
                    )

                    row = cursor.fetchone()

        finally:
            conn.close()

        return self._row_to_status(row)

    def _heartbeat_loop(self):
        while not self._stop_event.wait(
            self.heartbeat_seconds
        ):
            try:
                if not self.heartbeat():
                    return

            except Exception as error:
                self._last_heartbeat_error = str(error)

                with self._state_lock:
                    last_success = (
                        self._last_success_monotonic
                    )

                if (
                    last_success is None
                    or (
                        time.monotonic()
                        - last_success
                    ) >= self.lease_seconds
                ):
                    with self._state_lock:
                        self._acquired = False

                    self._lease_lost.set()
                    return

    def start_heartbeat(self):
        if not self.acquired:
            raise RuntimeError(
                "Cannot start heartbeat before acquiring the lease"
            )

        if (
            self._heartbeat_thread is not None
            and self._heartbeat_thread.is_alive()
        ):
            return

        self._stop_event.clear()
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            name=(
                "channel-account-lease-"
                f"{self.channel_account_id}"
            ),
            daemon=True,
        )
        self._heartbeat_thread.start()

    def stop(self, release=True):
        self._stop_event.set()

        heartbeat_thread = self._heartbeat_thread

        if (
            heartbeat_thread is not None
            and heartbeat_thread.is_alive()
            and heartbeat_thread
                is not threading.current_thread()
        ):
            heartbeat_thread.join(
                timeout=max(
                    2,
                    self.heartbeat_seconds + 1
                )
            )

        self._heartbeat_thread = None

        if release:
            try:
                return self.release()
            except Exception:
                with self._state_lock:
                    self._acquired = False
                return False

        with self._state_lock:
            self._acquired = False

        return False

    def __enter__(self):
        status = self.acquire()

        if status is None:
            raise RuntimeError(
                "Channel account is already leased by another worker"
            )

        self.start_heartbeat()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_value is not None:
            try:
                self.record_error(exc_value)
            except Exception:
                pass

        self.stop(release=True)
