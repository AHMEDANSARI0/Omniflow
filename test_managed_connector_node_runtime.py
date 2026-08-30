import sys
from datetime import (
    datetime,
    timedelta,
    timezone,
)
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = (
    Path(__file__).resolve().parent
)

SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(
        0,
        str(SRC_DIR),
    )

from connector_node import (
    CommandExecutionResult,
    ConnectorNodeConfig,
    ConnectorNodeNotStarted,
    ManagedConnectorNode,
    ManagedSessionAssignment,
    NodeRuntimeFenceError,
)
from control_plane import (
    ClaimedConnectorCommand,
    ConnectorCommandStatus,
    ConnectorCommandType,
    hash_node_credential,
)


class FakeClock:
    def __init__(self):
        self.value = 1000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += float(seconds)


class FakeGateway:
    def __init__(self):
        self.assignments = []
        self.commands = []
        self.heartbeats = []
        self.acknowledgements = []

    def list_assignments(
        self,
        **arguments,
    ):
        del arguments
        return tuple(
            self.assignments
        )

    def heartbeat_node(
        self,
        **arguments,
    ):
        self.heartbeats.append(
            arguments
        )

    def claim_commands(
        self,
        **arguments,
    ):
        limit = arguments["limit"]

        claimed = self.commands[
            :limit
        ]

        self.commands = self.commands[
            limit:
        ]

        return tuple(claimed)

    def acknowledge_command(
        self,
        **arguments,
    ):
        self.acknowledgements.append(
            arguments
        )


class FakeSessionController:
    def __init__(self):
        self.starts = []
        self.stops = []
        self.command_results = {}
        self.executions = []

    def start_session(
        self,
        assignment,
    ):
        handle = {
            "account_id": (
                assignment
                .channel_account_id
            ),
            "generation": (
                assignment
                .assignment_generation
            ),
        }

        self.starts.append(
            (
                assignment,
                handle,
            )
        )

        return handle

    def stop_session(
        self,
        handle,
        reason,
    ):
        self.stops.append(
            (
                dict(handle),
                reason,
            )
        )

    def execute_command(
        self,
        handle,
        command,
    ):
        self.executions.append(
            (
                dict(handle),
                command.id,
            )
        )

        return self.command_results.get(
            command.id,
            CommandExecutionResult(
                outcome="succeeded",
            ),
        )


def make_config(
    node_id,
    maximum=5,
):
    raw_credential = (
        "node-secret-for-isolated-"
        "runtime-test"
    )

    digest = hash_node_credential(
        raw_credential
    )

    config = ConnectorNodeConfig(
        node_id=node_id,
        node_name="managed-node-test",
        region="PK-KHI",
        max_sessions=maximum,
        credential_digest=digest,
        heartbeat_interval_seconds=20,
        reconcile_interval_seconds=5,
        command_interval_seconds=1,
        command_batch_size=20,
        command_lease_seconds=60,
    )

    assert (
        raw_credential
        not in repr(config)
    )

    return config


def assignment(
    node_id,
    number,
    generation=1,
    status="waiting_for_pairing",
):
    return ManagedSessionAssignment(
        channel_account_id=(
            1000 + number
        ),
        client_id=(
            2000 + number
        ),
        connector_node_id=node_id,
        assignment_generation=(
            generation
        ),
        platform="whatsapp",
        status=status,
        session_locator=(
            f"managed_sessions/{node_id}/"
            f"account_{1000 + number}"
        ),
        metadata={
            "preferred_region": "pk-khi",
        },
    )


def command(
    node_id,
    account_id,
    number,
):
    return ClaimedConnectorCommand(
        id=7000 + number,
        client_id=9000 + number,
        channel_account_id=account_id,
        connector_node_id=node_id,
        command_type=(
            ConnectorCommandType
            .SEND_MESSAGE
        ),
        idempotency_key=(
            f"reply-job:{8000 + number}"
        ),
        payload={
            "message_type": "text",
            "content": (
                f"message-{number}"
            ),
        },
        reply_job_id=8000 + number,
        claim_token=uuid4(),
        claim_expires_at=(
            datetime.now(timezone.utc)
            + timedelta(seconds=60)
        ),
        attempt_count=1,
    )


def expect_error(
    error_type,
    callback,
):
    try:
        callback()

    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def verify_explicit_start_and_capacity():
    node_id = uuid4()
    clock = FakeClock()
    gateway = FakeGateway()

    controller = (
        FakeSessionController()
    )

    gateway.assignments = [
        assignment(
            node_id,
            number,
        )
        for number in range(1, 8)
    ]

    runtime = ManagedConnectorNode(
        make_config(
            node_id,
            maximum=5,
        ),
        gateway,
        controller,
        clock,
    )

    assert not runtime.started
    assert not controller.starts

    expect_error(
        ConnectorNodeNotStarted,
        runtime.tick,
    )

    assert runtime.start()
    assert not controller.starts

    result = runtime.tick()

    assert result.assignments_seen == 7
    assert result.sessions_started == 5
    assert result.active_sessions == 5
    assert result.reserved_sessions == 0

    assert (
        runtime.active_account_ids
        == (
            1001,
            1002,
            1003,
            1004,
            1005,
        )
    )

    assert (
        gateway
        .heartbeats[-1]
        ["active_sessions"]
        == 5
    )

    assert (
        gateway
        .heartbeats[-1]
        ["status"]
        == "online"
    )


def verify_generation_fence_and_removal():
    node_id = uuid4()
    clock = FakeClock()
    gateway = FakeGateway()

    controller = (
        FakeSessionController()
    )

    first = assignment(
        node_id,
        1,
        generation=1,
    )

    second = assignment(
        node_id,
        2,
        generation=1,
    )

    gateway.assignments = [
        first,
        second,
    ]

    runtime = ManagedConnectorNode(
        make_config(node_id),
        gateway,
        controller,
        clock,
    )

    runtime.start()
    runtime.tick()

    gateway.assignments = [
        assignment(
            node_id,
            1,
            generation=2,
        ),
    ]

    clock.advance(5)

    result = runtime.tick()

    assert result.sessions_stopped == 2
    assert result.sessions_started == 1

    assert (
        runtime.active_account_ids
        == (1001,)
    )

    assert [
        reason
        for _, reason
        in controller.stops
    ] == [
        (
            "assignment-generation-"
            "changed"
        ),
        "assignment-removed",
    ]

    assert (
        controller
        .starts[-1][0]
        .assignment_generation
        == 2
    )


def verify_command_outcomes():
    node_id = uuid4()
    clock = FakeClock()
    gateway = FakeGateway()

    controller = (
        FakeSessionController()
    )

    gateway.assignments = [
        assignment(
            node_id,
            1,
        ),
    ]

    runtime = ManagedConnectorNode(
        make_config(node_id),
        gateway,
        controller,
        clock,
    )

    runtime.start()
    runtime.tick()

    succeeded = command(
        node_id,
        1001,
        1,
    )

    unknown = command(
        node_id,
        1001,
        2,
    )

    inactive = command(
        node_id,
        1999,
        3,
    )

    controller.command_results[
        unknown.id
    ] = CommandExecutionResult(
        outcome=(
            ConnectorCommandStatus
            .UNKNOWN
        ),
        error=(
            "Provider acceptance "
            "outcome is uncertain"
        ),
    )

    gateway.commands = [
        succeeded,
        unknown,
        inactive,
    ]

    clock.advance(1)

    result = runtime.tick()

    assert result.commands_claimed == 3

    assert (
        result.commands_acknowledged
        == 3
    )

    outcomes = [
        item["outcome"]
        for item
        in gateway.acknowledgements
    ]

    assert outcomes == [
        "succeeded",
        "unknown",
        "failed",
    ]

    assert (
        len(controller.executions)
        == 2
    )


def verify_drain_shutdown_and_fence():
    node_id = uuid4()
    clock = FakeClock()
    gateway = FakeGateway()

    controller = (
        FakeSessionController()
    )

    gateway.assignments = [
        assignment(
            node_id,
            1,
        ),
    ]

    runtime = ManagedConnectorNode(
        make_config(node_id),
        gateway,
        controller,
        clock,
    )

    runtime.start()
    runtime.tick()
    runtime.begin_draining()

    gateway.assignments.append(
        assignment(
            node_id,
            2,
        )
    )

    clock.advance(20)

    result = runtime.tick()

    assert result.active_sessions == 1

    assert (
        runtime.active_account_ids
        == (1001,)
    )

    assert (
        gateway
        .heartbeats[-1]
        ["status"]
        == "draining"
    )

    assert runtime.shutdown()
    assert not runtime.started

    assert not (
        runtime.active_account_ids
    )

    assert (
        gateway
        .heartbeats[-1]
        ["status"]
        == "offline"
    )

    assert (
        controller
        .stops[-1][1]
        == "node-shutdown"
    )

    wrong_gateway = FakeGateway()

    wrong_gateway.assignments = [
        assignment(
            uuid4(),
            5,
        )
    ]

    fenced = ManagedConnectorNode(
        make_config(node_id),
        wrong_gateway,
        FakeSessionController(),
        clock,
    )

    fenced.start()

    expect_error(
        NodeRuntimeFenceError,
        fenced.tick,
    )


def verify_thousand_assignment_boundary():
    node_id = uuid4()
    clock = FakeClock()
    gateway = FakeGateway()

    controller = (
        FakeSessionController()
    )

    gateway.assignments = [
        assignment(
            node_id,
            number,
        )
        for number
        in range(1, 1001)
    ]

    runtime = ManagedConnectorNode(
        make_config(
            node_id,
            maximum=10,
        ),
        gateway,
        controller,
        clock,
    )

    runtime.start()

    result = runtime.tick()

    assert (
        result.assignments_seen
        == 1000
    )

    assert (
        result.active_sessions
        == 10
    )

    assert (
        len(controller.starts)
        == 10
    )

    assert (
        result.active_sessions
        <= runtime.config.max_sessions
    )


def main():
    verify_explicit_start_and_capacity()

    verify_generation_fence_and_removal()

    verify_command_outcomes()

    verify_drain_shutdown_and_fence()

    verify_thousand_assignment_boundary()

    print(
        "Construction/start browser "
        "side effects: absent"
    )

    print(
        "Explicit assignment-only "
        "session launch: passed"
    )

    print(
        "Per-node capacity "
        "enforcement: passed"
    )

    print(
        "Assignment-generation "
        "replacement fence: passed"
    )

    print(
        "Removed assignment "
        "shutdown: passed"
    )

    print(
        "Command success/unknown/"
        "failure outcomes: passed"
    )

    print(
        "Inactive-session command "
        "rejection: passed"
    )

    print(
        "Draining mode blocks "
        "new sessions: passed"
    )

    print(
        "Graceful offline shutdown "
        "heartbeat: passed"
    )

    print(
        "Cross-node assignment "
        "fence: passed"
    )

    print(
        "1,000-assignment/"
        "10-session boundary: passed"
    )

    print(
        "\nMANAGED CONNECTOR NODE "
        "RUNTIME TEST PASSED"
    )


if __name__ == "__main__":
    main()