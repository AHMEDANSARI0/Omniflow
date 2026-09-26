import argparse
import os
import signal
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
SRC_DIR = BASE_DIR / "src"
LOCK_DIR = BASE_DIR / "runtime_locks"
POLL_INTERVAL_SECONDS = 1.5

load_dotenv(BASE_DIR / ".env")

VOICE_REPLY_MODE = os.getenv(
    "VOICE_REPLY_MODE",
    "text"
).strip().lower()

if VOICE_REPLY_MODE not in {
    "text",
    "audio",
}:
    raise RuntimeError(
        "VOICE_REPLY_MODE must be either 'text' or 'audio'"
    )

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import (  # noqa: E402
    AdapterRegistry,
    ChannelAccount,
    OutboundMessage,
    WhatsAppWebAdapter,
)
from account_lease import ChannelAccountLease  # noqa: E402
from conversation import ConversationManager  # noqa: E402
from control_plane_bridge import ControlPlaneBridge  # noqa: E402


LEASE_BUSY_EXIT_CODE = 75
LEASE_LOST_EXIT_CODE = 76
CHANNEL_LEASE_SECONDS = int(
    os.getenv("CHANNEL_LEASE_SECONDS", "120")
)
CHANNEL_LEASE_HEARTBEAT_SECONDS = int(
    os.getenv("CHANNEL_LEASE_HEARTBEAT_SECONDS", "30")
)
DUE_REPLY_SCAN_INTERVAL_SECONDS = max(
    1.0,
    float(
        os.getenv(
            "DUE_REPLY_SCAN_INTERVAL_SECONDS",
            "10"
        )
    )
)
MAX_DUE_REPLIES_PER_SCAN = max(
    1,
    int(
        os.getenv(
            "MAX_DUE_REPLIES_PER_SCAN",
            "5"
        )
    )
)


class ChannelWorkerLock:
    def __init__(self, channel_account_id):
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        self.path = LOCK_DIR / (
            f"channel_account_{channel_account_id}.lock"
        )
        self.file = None

    def __enter__(self):
        self.file = self.path.open("a+")
        self.file.seek(0)

        if not self.file.read(1):
            self.file.write("0")
            self.file.flush()

        self.file.seek(0)

        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(
                    self.file.fileno(),
                    msvcrt.LK_NBLCK,
                    1
                )
            else:
                import fcntl

                fcntl.flock(
                    self.file.fileno(),
                    fcntl.LOCK_EX | fcntl.LOCK_NB
                )

        except (OSError, IOError) as error:
            self.file.close()
            self.file = None
            raise RuntimeError(
                "A worker for this channel account is already running"
            ) from error

        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self.file is None:
            return

        try:
            self.file.seek(0)

            if os.name == "nt":
                import msvcrt

                msvcrt.locking(
                    self.file.fileno(),
                    msvcrt.LK_UNLCK,
                    1
                )
            else:
                import fcntl

                fcntl.flock(
                    self.file.fileno(),
                    fcntl.LOCK_UN
                )
        finally:
            self.file.close()
            self.file = None


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Run one dynamic channel-account worker"
    )
    parser.add_argument(
        "channel_account_id",
        type=int,
        help="Database ID from channel_accounts"
    )
    arguments = parser.parse_args()

    if arguments.channel_account_id <= 0:
        parser.error(
            "channel_account_id must be positive"
        )

    return arguments


def get_database_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def load_channel_account(channel_account_id):
    conn = get_database_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        id,
                        client_id,
                        platform,
                        external_account_id,
                        account_name,
                        status,
                        metadata
                    FROM channel_accounts
                    WHERE id = %s
                    """,
                    (channel_account_id,)
                )
                row = cursor.fetchone()
    finally:
        conn.close()

    if row is None:
        raise RuntimeError(
            f"Channel account {channel_account_id} does not exist"
        )

    return ChannelAccount(
        id=row[0],
        client_id=row[1],
        platform=row[2],
        external_account_id=row[3],
        account_name=row[4] or f"Channel {row[0]}",
        status=row[5],
        metadata=row[6] or {},
    )


def resolve_session_path(account):
    configured_path = str(
        account.metadata.get("session_path")
        or ""
    ).strip()

    if configured_path:
        path = Path(configured_path).expanduser()

        if not path.is_absolute():
            path = BASE_DIR / path

        return path

    # Preserve the existing WhatsApp session layout.
    return (
        BASE_DIR
        / "whatsapp_sessions"
        / f"account_{account.id}"
    )


def create_adapter(account):
    registry = AdapterRegistry()

    registry.register(
        "whatsapp",
        lambda channel_account: WhatsAppWebAdapter(
            account=channel_account,
            session_path=resolve_session_path(
                channel_account
            )
        )
    )

    return registry.create(account)


def transcribe_media_event(
    adapter,
    manager,
    event
):
    if event.message_type != "audio":
        return event

    media_path = adapter.download_media(event)

    if not media_path:
        return None

    try:
        transcript = manager.ai.transcribe_voice(
            media_path
        )
    finally:
        manager.ai.delete_temp_file(
            media_path
        )

    transcript = str(transcript or "").strip()

    if not transcript:
        return None

    metadata = dict(event.metadata)
    metadata["transcribed"] = True

    return replace(
        event,
        content=transcript,
        metadata=metadata
    )


def deliver_outbound(
    adapter,
    manager,
    source_event,
    outbound
):
    job_id = outbound.metadata[
        "reply_job_id"
    ]
    voice_path = None
    delivery_message = outbound

    if (
        source_event.message_type == "audio"
        and VOICE_REPLY_MODE == "audio"
    ):
        voice_path = manager.ai.generate_voice_reply(
            outbound.content
        )

        if voice_path:
            voice_metadata = dict(
                outbound.metadata
            )
            voice_metadata["audio_path"] = (
                voice_path
            )
            delivery_message = OutboundMessage(
                channel_account_id=(
                    outbound.channel_account_id
                ),
                external_user_id=(
                    outbound.external_user_id
                ),
                content=outbound.content,
                message_type="audio",
                reply_to_external_message_id=(
                    outbound.reply_to_external_message_id
                ),
                metadata=voice_metadata,
            )

    try:
        result = adapter.send(
            delivery_message
        )

        # Preserve a valid AI answer if voice delivery fails.
        if (
            not result.success
            and delivery_message.message_type == "audio"
        ):
            result = adapter.send(outbound)

        if result.success:
            manager.memory.mark_reply_sent(
                job_id,
                outbound_external_message_id=(
                    result.external_message_id
                )
            )

            bridge_out = getattr(manager, "cp_bridge", None)

            if bridge_out is not None:
                bridge_out.ingest_message(
                    external_user_id=outbound.external_user_id,
                    body=outbound.content,
                    direction="out",
                )

            return True

        manager.memory.mark_reply_delivery_failed(
            job_id,
            result.error or "Unknown delivery error"
        )
        return False

    finally:
        if voice_path:
            manager.ai.delete_temp_file(
                voice_path
            )


def recover_due_reply_jobs(
    adapter,
    manager,
    account,
    account_lease=None,
    stop_requested=None,
    max_jobs=None
):
    """Recover a bounded batch of persisted jobs without inbound replay."""
    max_jobs = max(
        1,
        int(
            max_jobs
            if max_jobs is not None
            else MAX_DUE_REPLIES_PER_SCAN
        )
    )
    recovered_count = 0
    delivered_count = 0

    for _ in range(max_jobs):
        if (
            stop_requested is not None
            and stop_requested.is_set()
        ):
            break

        if (
            account_lease is not None
            and account_lease.lease_lost
        ):
            break

        dispatch = manager.recover_due_reply(
            account.id
        )

        if dispatch is None:
            break

        recovered_count += 1
        job_id = dispatch.outbound.metadata[
            "reply_job_id"
        ]

        if (
            (
                stop_requested is not None
                and stop_requested.is_set()
            )
            or (
                account_lease is not None
                and account_lease.lease_lost
            )
        ):
            manager.memory.mark_reply_delivery_failed(
                job_id,
                "Worker stopped or lost its account lease before "
                "recovered delivery",
                retry_after_seconds=1
            )
            break

        print(
            "Recovered due reply job: "
            f"job={job_id}, "
            f"previous_status="
            f"{dispatch.outbound.metadata['previous_job_status']}, "
            f"cached={dispatch.outbound.metadata['cached_reply']}"
        )

        delivered = deliver_outbound(
            adapter,
            manager,
            dispatch.source_event,
            dispatch.outbound
        )

        if delivered:
            delivered_count += 1

        print(
            "Recovered outbound delivery: "
            + (
                "sent"
                if delivered
                else "scheduled for retry"
            )
        )

    return {
        "recovered": recovered_count,
        "delivered": delivered_count,
        "batch_full": recovered_count >= max_jobs,
    }


def run_worker(
    account,
    account_lease=None,
    stop_event=None
):
    adapter = create_adapter(account)
    manager = ConversationManager()
    adapter_started = False
    stop_requested = (
        stop_event
        if stop_event is not None
        else threading.Event()
    )
    previous_signal_handlers = {}
    next_due_reply_scan_at = 0.0
    next_command_poll_at = 0.0

    def request_stop(signum, frame):
        del frame

        if not stop_requested.is_set():
            print(
                "\nStopping channel worker... "
                "please wait for browser cleanup."
            )

        stop_requested.set()

    # Do not let Ctrl+C raise KeyboardInterrupt inside a Playwright sync call.
    # An interrupted Playwright event loop can leave pending coroutines and can
    # make BrowserContext.close() fail. The signal now requests a clean stop;
    # the handler remains installed until browser cleanup has completed.
    if threading.current_thread() is threading.main_thread():
        for signal_name in (
            "SIGINT",
            "SIGTERM",
            "SIGBREAK",
        ):
            signal_value = getattr(
                signal,
                signal_name,
                None
            )

            if signal_value is None:
                continue

            previous_signal_handlers[signal_value] = (
                signal.getsignal(signal_value)
            )
            signal.signal(
                signal_value,
                request_stop
            )

    print("\nStarting dynamic channel worker")
    print(f"Channel Account ID: {account.id}")
    print(f"Client ID: {account.client_id}")
    print(f"Platform: {account.platform}")
    print(f"Account Name: {account.account_name}")
    print(
        "Voice input reply mode: "
        f"{VOICE_REPLY_MODE}"
    )
    print(
        "Due reply recovery: every "
        f"{DUE_REPLY_SCAN_INTERVAL_SECONDS:g}s, "
        f"max {MAX_DUE_REPLIES_PER_SCAN} per scan\n"
    )

    try:
        bridge = None

        adapter.start()
        adapter_started = True

        try:
            bridge = ControlPlaneBridge(
                account_name=account.account_name,
            )

            manager.cp_bridge = bridge

            bridge.report_status("connected")
        except Exception as bridge_error:
            print(f"CP bridge init warning: {bridge_error}")

        print("Channel worker running. Press Ctrl+C to stop.\n")

        while (
            not stop_requested.is_set()
            and not (
                account_lease is not None
                and account_lease.lease_lost
            )
        ):
            now = time.monotonic()

            if (
                bridge is not None
                and now >= next_command_poll_at
            ):
                try:
                    bridge.run_due_commands(
                        adapter,
                        stop_requested,
                    )
                except Exception as bridge_error:
                    print(f"CP bridge commands warning: {bridge_error}")

                next_command_poll_at = (
                    time.monotonic()
                    + bridge.command_poll_seconds
                )

            if now >= next_due_reply_scan_at:
                try:
                    recovery_result = recover_due_reply_jobs(
                        adapter,
                        manager,
                        account,
                        account_lease=account_lease,
                        stop_requested=stop_requested,
                    )

                    next_due_reply_scan_at = (
                        time.monotonic()
                        + (
                            0.0
                            if recovery_result["batch_full"]
                            else DUE_REPLY_SCAN_INTERVAL_SECONDS
                        )
                    )

                except Exception as error:
                    print(
                        f"Due reply recovery error: {error}"
                    )
                    next_due_reply_scan_at = (
                        time.monotonic()
                        + DUE_REPLY_SCAN_INTERVAL_SECONDS
                    )

            if (
                stop_requested.is_set()
                or (
                    account_lease is not None
                    and account_lease.lease_lost
                )
            ):
                break

            for raw_event in adapter.poll_events():
                if (
                    stop_requested.is_set()
                    or (
                        account_lease is not None
                        and account_lease.lease_lost
                    )
                ):
                    break

                try:
                    event = transcribe_media_event(
                        adapter,
                        manager,
                        raw_event
                    )

                    if event is None:
                        print(
                            "Inbound media could not be prepared"
                        )
                        continue

                    print(
                        f"Inbound {event.message_type} event: "
                        f"channel={event.channel_account_id}, "
                        f"user={event.external_user_id}, "
                        f"message={event.external_message_id}"
                    )

                    if bridge is not None:
                        bridge.ingest_message(
                            external_user_id=event.external_user_id,
                            body=event.content,
                            direction="in",
                            display_name=event.display_name,
                        )

                    outbound = manager.process_event(
                        event
                    )

                    if outbound is None:
                        continue

                    if (
                        account_lease is not None
                        and account_lease.lease_lost
                    ):
                        print(
                            "Distributed account lease was lost before "
                            "delivery; persisted reply remains recoverable"
                        )
                        break

                    delivered = deliver_outbound(
                        adapter,
                        manager,
                        event,
                        outbound
                    )

                    print(
                        "Outbound delivery: "
                        + (
                            "sent"
                            if delivered
                            else "scheduled for retry"
                        )
                    )

                except Exception as error:
                    print(
                        f"Channel event processing error: {error}"
                    )

            stop_requested.wait(
                POLL_INTERVAL_SECONDS
            )

    except KeyboardInterrupt:
        # Fallback for environments where signal handlers cannot be installed.
        request_stop(signal.SIGINT, None)

    finally:
        if adapter_started:
            try:
                adapter.stop()
            except Exception as error:
                print(
                    f"Browser cleanup warning: {error}"
                )

        if bridge is not None:
            try:
                bridge.report_status("disconnected")
            except Exception:
                pass

        try:
            manager.close()
        except Exception as error:
            print(
                f"Memory cleanup warning: {error}"
            )

        for signal_value, previous_handler in (
            previous_signal_handlers.items()
        ):
            signal.signal(
                signal_value,
                previous_handler
            )

    if (
        account_lease is not None
        and account_lease.lease_lost
    ):
        print(
            "Channel worker stopped because its distributed "
            "account lease was lost"
        )
        return LEASE_LOST_EXIT_CODE

    return 0


def run_with_account_lease(
    account,
    worker_runner=run_worker
):
    """Run one account only while this process owns its distributed lease."""
    with ChannelWorkerLock(account.id):
        account_lease = ChannelAccountLease(
            account.id,
            lease_seconds=CHANNEL_LEASE_SECONDS,
            heartbeat_seconds=(
                CHANNEL_LEASE_HEARTBEAT_SECONDS
            ),
            connection_factory=(
                get_database_connection
            ),
        )

        lease_status = account_lease.acquire()

        if lease_status is None:
            print(
                "Channel account is already leased by another "
                f"worker: {account.id}"
            )
            return LEASE_BUSY_EXIT_CODE

        print(
            "Distributed account lease acquired: "
            f"account={account.id}, "
            f"worker={lease_status['worker_id']}, "
            f"expires={lease_status['lease_expires_at']}"
        )

        account_lease.start_heartbeat()

        try:
            return_code = worker_runner(
                account,
                account_lease
            )

            if return_code is None:
                return_code = 0

            return int(return_code)

        except BaseException as error:
            try:
                account_lease.record_error(error)
            except Exception:
                pass
            raise

        finally:
            released = account_lease.stop(
                release=True
            )
            print(
                "Distributed account lease released: "
                f"account={account.id}, "
                f"released={released}"
            )


def main():
    arguments = parse_arguments()
    account = load_channel_account(
        arguments.channel_account_id
    )

    if account.status.lower() != "active":
        raise RuntimeError(
            f"Channel account {account.id} is not active"
        )

    try:
        return_code = run_with_account_lease(
            account
        )
    except RuntimeError as error:
        print(f"Worker could not start: {error}")
        raise SystemExit(1) from error

    if return_code:
        raise SystemExit(return_code)


if __name__ == "__main__":
    main()
