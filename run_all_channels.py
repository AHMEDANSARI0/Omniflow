
import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
CHANNEL_RUNNER = BASE_DIR / "run_channel.py"
SUPPORTED_PLATFORMS = {
    "whatsapp",
}

MONITOR_INTERVAL_SECONDS = 2
DISCOVERY_INTERVAL_SECONDS = 15
MAX_RESTART_ATTEMPTS = 3
BASE_RESTART_DELAY_SECONDS = 5
GRACEFUL_SHUTDOWN_SECONDS = 20
LEASE_BUSY_EXIT_CODE = 75
LEASE_LOST_EXIT_CODE = 76
LEASE_BUSY_RETRY_SECONDS = 60

load_dotenv(BASE_DIR / ".env")


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Discover and supervise active channel-account workers"
        )
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Print the database-derived launch plan and exit without "
            "starting workers or browsers"
        ),
    )
    parser.add_argument(
        "--only-account",
        action="append",
        type=int,
        default=[],
        help=(
            "Limit this supervisor to a database channel-account ID. "
            "May be repeated; no account ID is embedded in source code."
        ),
    )
    arguments = parser.parse_args(argv)

    if any(
        account_id <= 0
        for account_id in arguments.only_account
    ):
        parser.error(
            "--only-account values must be positive"
        )

    arguments.only_account = set(
        arguments.only_account
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


def get_active_channel_accounts():
    conn = get_database_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        account.id,
                        account.client_id,
                        account.platform,
                        account.account_name,
                        lease.worker_id,
                        lease.lease_expires_at,
                        (
                            lease.owner_token IS NOT NULL
                            AND lease.lease_expires_at
                                > CURRENT_TIMESTAMP
                        ) AS lease_live
                    FROM channel_accounts account
                    LEFT JOIN channel_account_leases lease
                      ON lease.channel_account_id = account.id
                    WHERE account.status = 'active'
                    ORDER BY account.client_id, account.id
                    """
                )
                rows = cursor.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": row[0],
            "client_id": row[1],
            "platform": row[2],
            "account_name": row[3] or f"Channel {row[0]}",
            "lease_worker_id": row[4],
            "lease_expires_at": row[5],
            "lease_live": bool(row[6]),
        }
        for row in rows
    ]


def build_supervisor_plan(
    discovered,
    only_account_ids=None
):
    only_account_ids = set(
        only_account_ids or ()
    )
    plan = []

    for account in discovered:
        if (
            only_account_ids
            and account["id"] not in only_account_ids
        ):
            action = "filtered"
            reason = "not selected by --only-account"

        else:
            platform = str(
                account["platform"]
            ).strip().lower()

            if platform not in SUPPORTED_PLATFORMS:
                action = "unsupported"
                reason = (
                    f"{platform} adapter is not installed"
                )

            elif account.get("lease_live"):
                action = "leased"
                reason = (
                    "owned by "
                    f"{account.get('lease_worker_id')} until "
                    f"{account.get('lease_expires_at')}"
                )

            else:
                action = "ready"
                reason = "eligible for worker launch"

        plan.append(
            {
                "account": account,
                "action": action,
                "reason": reason,
            }
        )

    return plan


def print_supervisor_plan(plan):
    counts = {
        "ready": 0,
        "leased": 0,
        "unsupported": 0,
        "filtered": 0,
    }

    for item in plan:
        account = item["account"]
        action = item["action"]
        counts[action] += 1

        print(
            f"  - account {account['id']}, "
            f"client {account['client_id']}, "
            f"platform {account['platform']}, "
            f"action={action}: {item['reason']}"
        )

    print("\nSupervisor plan summary")
    print(f"  ready: {counts['ready']}")
    print(f"  leased elsewhere: {counts['leased']}")
    print(f"  unsupported adapter: {counts['unsupported']}")
    print(f"  filtered: {counts['filtered']}")

    return counts


def start_worker(account):
    print(
        f"Starting channel worker: "
        f"account={account['id']}, "
        f"client={account['client_id']}, "
        f"platform={account['platform']}, "
        f"name={account['account_name']}"
    )

    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"

    popen_options = {
        "cwd": str(BASE_DIR),
        "env": environment,
    }

    if os.name == "nt":
        popen_options["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        popen_options["start_new_session"] = True

    return subprocess.Popen(
        [
            sys.executable,
            str(CHANNEL_RUNNER),
            str(account["id"]),
        ],
        **popen_options,
    )


def request_worker_stop(process):
    if process is None or process.poll() is not None:
        return

    if os.name == "nt":
        process.send_signal(
            signal.CTRL_BREAK_EVENT
        )
    else:
        process.terminate()


def force_stop_worker(process):
    if process is None or process.poll() is not None:
        return

    if os.name == "nt":
        process.kill()
    else:
        os.killpg(
            process.pid,
            signal.SIGKILL
        )


def reconcile_supervisor_states(
    states,
    plan,
    now,
    stop_worker=request_worker_stop
):
    """Reconcile running state with the latest database-derived plan."""
    eligible = {
        item["account"]["id"]: item
        for item in plan
        if item["action"] in {
            "ready",
            "leased",
        }
    }

    # Retire accounts that became inactive, unsupported, or filtered out.
    for account_id in list(states):
        if account_id in eligible:
            continue

        state = states[account_id]
        process = state.get("process")

        if process is None or process.poll() is not None:
            print(
                f"Removing channel account {account_id} from supervisor"
            )
            states.pop(account_id, None)
            continue

        if not state.get("retiring"):
            print(
                f"Channel account {account_id} is no longer eligible; "
                "requesting graceful worker stop"
            )
            state["retiring"] = True
            state["force_stop_requested"] = False
            state["retire_deadline"] = (
                now + GRACEFUL_SHUTDOWN_SECONDS
            )

            try:
                stop_worker(process)
            except Exception as error:
                print(
                    f"Could not request stop for account "
                    f"{account_id}: {error}"
                )

    # Add newly activated accounts and refresh metadata/lease availability for
    # existing accounts. A lease held by this supervisor's own live child is
    # ignored here; the child process remains authoritative for that state.
    for account_id, item in eligible.items():
        account = item["account"]
        blocked_by_lease = (
            item["action"] == "leased"
        )

        if account_id not in states:
            states[account_id] = {
                "account": account,
                "process": None,
                "restart_attempts": 0,
                "next_restart_at": (
                    now + LEASE_BUSY_RETRY_SECONDS
                    if blocked_by_lease
                    else now
                ),
                "disabled": False,
                "retiring": False,
                "retire_deadline": None,
                "force_stop_requested": False,
                "blocked_by_lease": blocked_by_lease,
                "started_at": None,
            }

            print(
                f"Discovered eligible channel account {account_id}: "
                + (
                    "leased by another worker"
                    if blocked_by_lease
                    else "ready to start"
                )
            )
            continue

        state = states[account_id]
        state["account"] = account
        process = state.get("process")
        process_is_live = (
            process is not None
            and process.poll() is None
        )

        state["retiring"] = False
        state["retire_deadline"] = None
        state["force_stop_requested"] = False

        if process_is_live:
            state["blocked_by_lease"] = False
        else:
            was_blocked = state.get(
                "blocked_by_lease",
                False
            )
            state["blocked_by_lease"] = (
                blocked_by_lease
            )

            if was_blocked and not blocked_by_lease:
                print(
                    f"Distributed lease became available for "
                    f"channel account {account_id}"
                )
                state["next_restart_at"] = now

    return states


def wait_for_workers_to_stop(states):
    for account_id, state in states.items():
        process = state.get("process")

        if process is None or process.poll() is not None:
            continue

        print(
            f"Requesting graceful stop for channel account {account_id}"
        )

        try:
            request_worker_stop(process)
        except Exception as error:
            print(
                f"Graceful stop request failed for account "
                f"{account_id}: {error}"
            )

    deadline = time.monotonic() + GRACEFUL_SHUTDOWN_SECONDS

    while time.monotonic() < deadline:
        if all(
            state.get("process") is None
            or state["process"].poll() is not None
            for state in states.values()
        ):
            return
        time.sleep(0.25)

    for account_id, state in states.items():
        process = state.get("process")

        if process is not None and process.poll() is None:
            print(
                f"Force-stopping channel account {account_id}"
            )

            try:
                force_stop_worker(process)
            except Exception as error:
                print(
                    f"Force-stop failed for account {account_id}: {error}"
                )


def main(argv=None):
    arguments = parse_arguments(argv)

    if not CHANNEL_RUNNER.exists():
        raise RuntimeError(
            f"Channel runner not found: {CHANNEL_RUNNER}"
        )

    discovered = get_active_channel_accounts()
    plan = build_supervisor_plan(
        discovered,
        arguments.only_account
    )

    print("\nDynamic Omnichannel Supervisor")
    print(f"Active channel accounts discovered: {len(discovered)}")
    counts = print_supervisor_plan(plan)

    if arguments.check:
        print(
            "\nCHECK ONLY: no workers, browsers, or AI clients "
            "were started"
        )
        return

    supported = [
        item["account"]
        for item in plan
        if item["action"] in {
            "ready",
            "leased",
        }
    ]

    if not supported:
        print(
            "No selected channel accounts currently have installed "
            "adapters; supervisor will continue database discovery"
        )

    if counts["leased"]:
        print(
            "Live leased accounts will remain deferred until database "
            "discovery observes that ownership is free"
        )

    print(
        "\nPress Ctrl+C once to stop every channel worker.\n"
    )

    states = {}
    initial_now = time.monotonic()
    reconcile_supervisor_states(
        states,
        plan,
        initial_now
    )
    next_discovery_at = (
        initial_now + DISCOVERY_INTERVAL_SECONDS
    )

    try:
        while True:
            now = time.monotonic()

            if now >= next_discovery_at:
                try:
                    latest_discovered = (
                        get_active_channel_accounts()
                    )
                    latest_plan = build_supervisor_plan(
                        latest_discovered,
                        arguments.only_account
                    )
                    reconcile_supervisor_states(
                        states,
                        latest_plan,
                        now
                    )

                except Exception as error:
                    print(
                        f"Channel-account discovery error: {error}"
                    )

                next_discovery_at = (
                    now + DISCOVERY_INTERVAL_SECONDS
                )

            for account_id, state in list(
                states.items()
            ):
                process = state.get("process")

                if state.get("retiring"):
                    if (
                        process is None
                        or process.poll() is not None
                    ):
                        print(
                            f"Retired channel account {account_id} stopped"
                        )
                        states.pop(account_id, None)
                        continue

                    retire_deadline = state.get(
                        "retire_deadline"
                    )

                    if (
                        retire_deadline is not None
                        and now >= retire_deadline
                        and not state.get(
                            "force_stop_requested"
                        )
                    ):
                        print(
                            f"Force-stopping retired channel account "
                            f"{account_id}"
                        )
                        state["force_stop_requested"] = True

                        try:
                            force_stop_worker(process)
                        except Exception as error:
                            print(
                                f"Force-stop failed for account "
                                f"{account_id}: {error}"
                            )

                    continue

                if process is not None:
                    return_code = process.poll()

                    if return_code is None:
                        started_at = state.get("started_at")

                        if (
                            started_at is not None
                            and state["restart_attempts"] > 0
                            and now - started_at >= 300
                        ):
                            state["restart_attempts"] = 0
                            state["started_at"] = now
                            print(
                                f"Restart counter reset for stable "
                                f"channel account {account_id}"
                            )

                        continue

                    state["process"] = None
                    state["started_at"] = None

                    if return_code == LEASE_BUSY_EXIT_CODE:
                        state["blocked_by_lease"] = True
                        state["next_restart_at"] = (
                            now + LEASE_BUSY_RETRY_SECONDS
                        )
                        print(
                            f"Channel account {account_id} is leased by "
                            "another worker; waiting for discovery"
                        )
                        continue

                    if return_code == LEASE_LOST_EXIT_CODE:
                        print(
                            f"Channel account {account_id} lost its "
                            "distributed lease"
                        )

                    state["restart_attempts"] += 1
                    attempt = state["restart_attempts"]

                    if attempt > MAX_RESTART_ATTEMPTS:
                        print(
                            f"Channel account {account_id} reached "
                            "the restart limit and is disabled until "
                            "the supervisor is restarted or account "
                            "eligibility changes"
                        )
                        state["disabled"] = True
                        continue

                    delay = BASE_RESTART_DELAY_SECONDS * (
                        2 ** (attempt - 1)
                    )
                    state["next_restart_at"] = now + delay

                    print(
                        f"Channel account {account_id} exited with "
                        f"code {return_code}; restart {attempt}/"
                        f"{MAX_RESTART_ATTEMPTS} in {delay}s"
                    )

                if (
                    state.get("process") is None
                    and not state["disabled"]
                    and not state.get("blocked_by_lease")
                    and now >= state["next_restart_at"]
                ):
                    state["process"] = start_worker(
                        state["account"]
                    )
                    state["started_at"] = now

            time.sleep(MONITOR_INTERVAL_SECONDS)

    except KeyboardInterrupt:
        print("\nStopping all channel workers...")

    finally:
        wait_for_workers_to_stop(states)
        print("Dynamic omnichannel supervisor stopped")


if __name__ == "__main__":
    main()
