import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    ChannelConnection,
    ConnectionStatus,
    ConnectorNodeCapacity,
    ConnectorNodeIdentity,
    ConnectorNodeSnapshot,
    ConnectorScheduler,
    NoConnectorCapacity,
)


NOW = datetime(
    2026,
    8,
    21,
    2,
    30,
    tzinfo=timezone.utc,
)


def node_uuid(number):
    return UUID(
        f"00000000-0000-0000-0000-{number:012d}"
    )


def make_node(
    number,
    region="pk-khi",
    status="online",
    maximum=10,
    active=0,
    reserved=0,
    heartbeat_age_seconds=5,
):
    node_id = node_uuid(number)
    return ConnectorNodeSnapshot(
        identity=ConnectorNodeIdentity(
            id=node_id,
            node_name=f"connector-node-{number:04d}",
            region=region,
            max_sessions=maximum,
            status=status,
            version="0.1.0",
        ),
        capacity=ConnectorNodeCapacity(
            node_id=node_id,
            max_sessions=maximum,
            active_sessions=active,
            reserved_sessions=reserved,
        ),
        last_heartbeat_at=(
            NOW
            - timedelta(
                seconds=heartbeat_age_seconds
            )
        ),
    )


def make_connection(
    number,
    client_id=None,
    status="waiting_for_node",
    node_id=None,
    generation=0,
    region=None,
    mode="managed_web",
):
    metadata = {}

    if region:
        metadata["preferred_region"] = region

    return ChannelConnection(
        channel_account_id=10000 + number,
        client_id=(
            client_id
            if client_id is not None
            else 20000 + number
        ),
        connection_mode=mode,
        status=status,
        connector_node_id=node_id,
        assignment_generation=generation,
        metadata=metadata,
    )


def verify_eligibility_and_selection():
    scheduler = ConnectorScheduler(
        heartbeat_timeout_seconds=90
    )
    healthy_low_load = make_node(
        1,
        region="pk-khi",
        active=2,
    )
    healthy_high_load = make_node(
        2,
        region="pk-khi",
        active=8,
    )
    other_region_empty = make_node(
        3,
        region="ae-dxb",
        active=0,
    )
    stale = make_node(
        4,
        heartbeat_age_seconds=91,
    )
    draining = make_node(
        5,
        status="draining",
    )
    full = make_node(
        6,
        active=10,
    )

    assert scheduler.node_is_eligible(
        healthy_low_load,
        NOW
    )
    assert not scheduler.node_is_eligible(
        stale,
        NOW
    )
    assert not scheduler.node_is_eligible(
        draining,
        NOW
    )
    assert not scheduler.node_is_eligible(
        full,
        NOW
    )

    chosen = scheduler.choose_node(
        [
            healthy_high_load,
            other_region_empty,
            healthy_low_load,
            stale,
            draining,
            full,
        ],
        preferred_region="PK-KHI",
        now=NOW,
    )
    assert chosen.identity.id == (
        healthy_low_load.identity.id
    )

    # Region is a preference, not a hard availability constraint.
    chosen_without_local_capacity = scheduler.choose_node(
        [
            make_node(7, region="pk-khi", active=10),
            other_region_empty,
        ],
        preferred_region="pk-khi",
        now=NOW,
    )
    assert chosen_without_local_capacity.identity.id == (
        other_region_empty.identity.id
    )

    try:
        scheduler.choose_node(
            [stale, draining, full],
            now=NOW,
        )
    except NoConnectorCapacity:
        pass
    else:
        raise AssertionError(
            "Expected NoConnectorCapacity"
        )


def verify_generation_and_unschedulable_states():
    scheduler = ConnectorScheduler()
    node = make_node(10)
    schedulable = make_connection(
        1,
        generation=7,
    )
    local_web = make_connection(
        2,
        mode="local_web",
    )
    already_assigned = make_connection(
        3,
        status="connected",
        node_id=node.identity.id,
        generation=4,
    )

    plan = scheduler.plan_assignments(
        [
            already_assigned,
            local_web,
            schedulable,
        ],
        [node],
        now=NOW,
    )

    assert len(plan.assignments) == 1
    assert len(plan.unassigned) == 2
    assignment = plan.assignments[0]
    assert assignment.channel_account_id == (
        schedulable.channel_account_id
    )
    assert assignment.client_id == (
        schedulable.client_id
    )
    assert assignment.assignment_generation == 8
    assert assignment.connector_node_id == (
        node.identity.id
    )


def verify_thousand_account_capacity_plan():
    scheduler = ConnectorScheduler(
        heartbeat_timeout_seconds=90
    )
    nodes = [
        make_node(
            number,
            maximum=10,
        )
        for number in range(1, 101)
    ]
    connections = [
        make_connection(number)
        for number in range(1, 1001)
    ]

    plan = scheduler.plan_assignments(
        connections,
        nodes,
        now=NOW,
    )

    assert plan.complete
    assert len(plan.assignments) == 1000
    assert not plan.unassigned

    counts = {
        node.identity.id: 0
        for node in nodes
    }

    for assignment in plan.assignments:
        counts[
            assignment.connector_node_id
        ] += 1

    assert set(counts.values()) == {10}
    assert len({
        assignment.channel_account_id
        for assignment in plan.assignments
    }) == 1000
    assert len({
        assignment.client_id
        for assignment in plan.assignments
    }) == 1000

    # The same inputs always create the same deterministic placement.
    repeated = scheduler.plan_assignments(
        reversed(connections),
        reversed(nodes),
        now=NOW,
    )
    first_mapping = {
        assignment.channel_account_id:
            assignment.connector_node_id
        for assignment in plan.assignments
    }
    repeated_mapping = {
        assignment.channel_account_id:
            assignment.connector_node_id
        for assignment in repeated.assignments
    }
    assert first_mapping == repeated_mapping


def verify_capacity_exhaustion_is_explicit():
    scheduler = ConnectorScheduler()
    nodes = [
        make_node(201, maximum=2),
        make_node(202, maximum=2),
    ]
    connections = [
        make_connection(number)
        for number in range(1, 7)
    ]

    plan = scheduler.plan_assignments(
        connections,
        nodes,
        now=NOW,
    )
    assert len(plan.assignments) == 4
    assert len(plan.unassigned) == 2
    assert not plan.complete
    assert [
        connection.channel_account_id
        for connection in plan.unassigned
    ] == [10005, 10006]


def main():
    verify_eligibility_and_selection()
    verify_generation_and_unschedulable_states()
    verify_thousand_account_capacity_plan()
    verify_capacity_exhaustion_is_explicit()

    print("Healthy online-node filtering: passed")
    print("Stale/draining/full-node rejection: passed")
    print("Preferred-region scheduling with fallback: passed")
    print("Assignment generation fencing: passed")
    print("Non-managed/already-assigned exclusion: passed")
    print("1,000 accounts across 100 nodes: 10 each")
    print("Deterministic repeated placement: passed")
    print("Capacity exhaustion returned explicitly: passed")
    print("\n✅ CONNECTOR SCHEDULER TEST PASSED")


if __name__ == "__main__":
    main()
