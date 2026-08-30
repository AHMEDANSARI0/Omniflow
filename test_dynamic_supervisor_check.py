import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import run_all_channels as supervisor  # noqa: E402


class FakeProcess:
    def __init__(self):
        self.return_code = None

    def poll(self):
        return self.return_code


def count_actions(plan):
    counts = {}

    for item in plan:
        action = item["action"]
        counts[action] = counts.get(action, 0) + 1

    return counts


def main():
    discovered = supervisor.get_active_channel_accounts()

    if not discovered:
        raise RuntimeError(
            "No active database channel accounts were discovered"
        )

    actual_plan = supervisor.build_supervisor_plan(
        discovered
    )
    assert len(actual_plan) == len(discovered)

    account_ids = [
        account["id"]
        for account in discovered
    ]
    assert len(account_ids) == len(set(account_ids))

    for item in actual_plan:
        assert item["account"]["client_id"] is not None
        assert item["account"]["platform"]
        assert item["action"] in {
            "ready",
            "leased",
            "unsupported",
            "filtered",
        }

    # Prove the check-only CLI cannot accidentally invoke a worker/browser.
    original_start_worker = supervisor.start_worker

    def forbidden_start_worker(account):
        raise AssertionError(
            f"Check mode attempted to start account {account['id']}"
        )

    supervisor.start_worker = forbidden_start_worker

    try:
        supervisor.main(["--check"])
    finally:
        supervisor.start_worker = original_start_worker

    # Exercise the generic planner with 1,000 dynamic database-shaped rows and
    # four platforms. WhatsApp is currently installed; other adapters remain
    # safely isolated and skipped.
    platforms = (
        "whatsapp",
        "instagram",
        "telegram",
        "gmail",
    )
    simulated = []

    for number in range(1, 1001):
        simulated.append(
            {
                "id": 10000 + number,
                "client_id": 20000 + number,
                "platform": platforms[(number - 1) % 4],
                "account_name": f"Dynamic account {number}",
                "lease_worker_id": None,
                "lease_expires_at": None,
                "lease_live": False,
            }
        )

    simulated_plan = supervisor.build_supervisor_plan(
        simulated
    )
    simulated_counts = count_actions(
        simulated_plan
    )

    assert len(simulated_plan) == 1000
    assert simulated_counts["ready"] == 250
    assert simulated_counts["unsupported"] == 750

    selected_id = simulated[0]["id"]
    selected_plan = supervisor.build_supervisor_plan(
        simulated,
        {selected_id}
    )
    selected_counts = count_actions(
        selected_plan
    )
    assert selected_counts["ready"] == 1
    assert selected_counts["filtered"] == 999

    # Validate continuous discovery reconciliation without starting processes:
    # newly active accounts are added, externally leased accounts are deferred,
    # lease release unblocks launch, and removed/inactive accounts retire.
    ready_account = dict(simulated[0])
    leased_account = dict(simulated[4])
    leased_account["lease_worker_id"] = (
        "other-host:123:lease"
    )
    leased_account["lease_expires_at"] = (
        "future"
    )
    leased_account["lease_live"] = True

    reconciliation_states = {}
    initial_reconciliation_plan = (
        supervisor.build_supervisor_plan(
            [ready_account, leased_account]
        )
    )
    supervisor.reconcile_supervisor_states(
        reconciliation_states,
        initial_reconciliation_plan,
        now=100.0,
        stop_worker=lambda process: None,
    )

    assert ready_account["id"] in (
        reconciliation_states
    )
    assert leased_account["id"] in (
        reconciliation_states
    )
    assert reconciliation_states[
        ready_account["id"]
    ]["blocked_by_lease"] is False
    assert reconciliation_states[
        leased_account["id"]
    ]["blocked_by_lease"] is True

    fake_process = FakeProcess()
    reconciliation_states[
        ready_account["id"]
    ]["process"] = fake_process
    stop_requests = []

    released_account = dict(leased_account)
    released_account["lease_worker_id"] = None
    released_account["lease_expires_at"] = None
    released_account["lease_live"] = False
    changed_plan = supervisor.build_supervisor_plan(
        [released_account]
    )
    supervisor.reconcile_supervisor_states(
        reconciliation_states,
        changed_plan,
        now=200.0,
        stop_worker=lambda process: (
            stop_requests.append(process)
        ),
    )

    assert reconciliation_states[
        ready_account["id"]
    ]["retiring"] is True
    assert stop_requests == [fake_process]
    assert reconciliation_states[
        leased_account["id"]
    ]["blocked_by_lease"] is False
    assert reconciliation_states[
        leased_account["id"]
    ]["next_restart_at"] == 200.0

    fake_process.return_code = 0
    supervisor.reconcile_supervisor_states(
        reconciliation_states,
        changed_plan,
        now=201.0,
        stop_worker=lambda process: None,
    )
    assert ready_account["id"] not in (
        reconciliation_states
    )

    actual_counts = count_actions(actual_plan)

    print(
        "Database active accounts discovered: "
        f"{len(discovered)}"
    )
    print(
        "Database account IDs: "
        + ", ".join(str(value) for value in account_ids)
    )
    print(
        "Database ready accounts: "
        f"{actual_counts.get('ready', 0)}"
    )
    print(
        "Database live-leased accounts: "
        f"{actual_counts.get('leased', 0)}"
    )
    print("Check-only worker/browser launches: 0")
    print("Simulated dynamic accounts planned: 1000")
    print("Installed WhatsApp plans: 250")
    print("Uninstalled adapter plans safely skipped: 750")
    print("Runtime account filter verified: 1 of 1000")
    print("Continuous new-account discovery reconciled: 1")
    print("Externally leased account deferred: 1")
    print("Released distributed lease unblocked: 1")
    print("Inactive/removed account gracefully retired: 1")
    print(
        "\n✅ DYNAMIC SUPERVISOR CHECK TEST PASSED"
    )


if __name__ == "__main__":
    main()
