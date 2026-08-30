import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"
MIGRATION = (
    PROJECT_ROOT
    / "migrations"
    / "003_managed_connector_control_plane.sql"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    ChannelConnection,
    ConnectionMode,
    ConnectionStatus,
    ConnectorCommand,
    ConnectorCommandType,
    ConnectorNodeCapacity,
    ConnectorNodeIdentity,
    ConnectorNodeStatus,
    PairingMethod,
    PairingSession,
    PairingStatus,
)


def expect_error(error_type, callback):
    try:
        callback()
    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def verify_migration_contract():
    sql = MIGRATION.read_text(
        encoding="utf-8"
    )
    normalized = " ".join(
        sql.lower().split()
    )

    required_tables = (
        "platform_users",
        "user_password_credentials",
        "client_memberships",
        "connector_nodes",
        "channel_connections",
        "pairing_sessions",
        "connector_events",
        "connector_commands",
        "control_plane_audit_log",
    )

    for table in required_tables:
        assert (
            f"create table if not exists {table}"
            in normalized
        ), table

    for mode in (
        "local_web",
        "managed_web",
        "client_edge",
        "cloud_api",
    ):
        assert f"'{mode}'" in sql

    for state in (
        "waiting_for_node",
        "waiting_for_pairing",
        "pairing_code_ready",
        "qr_ready",
        "authenticating",
        "connected",
        "reconnecting",
        "revoked",
    ):
        assert f"'{state}'" in sql

    composite_reference = (
        "references channel_accounts(id, client_id)"
    )
    assert normalized.count(composite_reference) >= 4
    assert "unique (id, client_id)" in normalized

    assert "password_hash text not null" in normalized
    assert (
        "enrollment_token_hash char(64) not null"
        in normalized
    )
    assert "artifact_ciphertext bytea" in normalized
    assert "artifact_nonce bytea" in normalized
    assert "artifact_key_version integer" in normalized
    assert " password varchar" not in normalized
    assert " enrollment_token varchar" not in normalized
    assert " pairing_code varchar" not in normalized
    assert " qr_payload text" not in normalized

    assert (
        "unique (channel_account_id, external_event_id)"
        in normalized
    )
    assert (
        "unique (channel_account_id, idempotency_key)"
        in normalized
    )
    assert "unique (reply_job_id)" in normalized

    assert (
        "not null default 'local_web'"
        in normalized
    )
    assert (
        "insert into channel_connections"
        in normalized
    )


def verify_contract_validation():
    node_id = uuid4()
    node = ConnectorNodeIdentity(
        id=node_id,
        node_name="prototype-node-1",
        region="PK-KHI",
        max_sessions=10,
        status="online",
        version="0.1.0",
    )
    assert node.region == "pk-khi"
    assert node.status == ConnectorNodeStatus.ONLINE

    capacity = ConnectorNodeCapacity(
        node_id=node_id,
        max_sessions=10,
        active_sessions=6,
        reserved_sessions=2,
    )
    assert capacity.available_sessions == 2

    connection = ChannelConnection(
        channel_account_id=101,
        client_id=501,
        connection_mode="managed_web",
        status="waiting_for_pairing",
        connector_node_id=node_id,
        assignment_generation=1,
    )
    assert (
        connection.connection_mode
        == ConnectionMode.MANAGED_WEB
    )
    assert (
        connection.status
        == ConnectionStatus.WAITING_FOR_PAIRING
    )

    pairing = PairingSession(
        id=uuid4(),
        channel_account_id=101,
        client_id=501,
        method="phone_code",
        status="assigned",
        connector_node_id=node_id,
        initiated_by_user_id=9001,
        expires_at=(
            datetime.now(timezone.utc)
            + timedelta(minutes=5)
        ),
    )
    assert pairing.method == PairingMethod.PHONE_CODE
    assert pairing.status == PairingStatus.ASSIGNED

    command = ConnectorCommand(
        id=1,
        channel_account_id=101,
        client_id=501,
        connector_node_id=node_id,
        command_type="send_message",
        idempotency_key="reply-job:7001",
        reply_job_id=7001,
        payload={
            "message_type": "text",
            "content": "Hello",
        },
    )
    assert (
        command.command_type
        == ConnectorCommandType.SEND_MESSAGE
    )

    expect_error(
        ValueError,
        lambda: ChannelConnection(
            channel_account_id=101,
            client_id=501,
            connection_mode="managed_web",
            status="connected",
            connector_node_id=None,
        )
    )

    expect_error(
        ValueError,
        lambda: ConnectorNodeCapacity(
            node_id=node_id,
            max_sessions=10,
            active_sessions=9,
            reserved_sessions=2,
        )
    )

    expect_error(
        ValueError,
        lambda: ConnectorCommand(
            id=2,
            channel_account_id=101,
            client_id=501,
            connector_node_id=node_id,
            command_type="send_message",
            idempotency_key="missing-reply-job",
            reply_job_id=None,
            payload={"content": "Unsafe"},
        )
    )


def verify_thousand_account_contract_plan():
    node_ids = [
        uuid4()
        for _ in range(100)
    ]
    capacities = {
        node_id: 0
        for node_id in node_ids
    }
    connections = []

    for number in range(1, 1001):
        node_id = node_ids[
            (number - 1) % len(node_ids)
        ]
        capacities[node_id] += 1
        connections.append(
            ChannelConnection(
                channel_account_id=10000 + number,
                client_id=20000 + number,
                connection_mode="managed_web",
                status="waiting_for_pairing",
                connector_node_id=node_id,
                assignment_generation=1,
            )
        )

    assert len(connections) == 1000

    assert len({
        connection.channel_account_id
        for connection in connections
    }) == 1000

    assert len({
        connection.client_id
        for connection in connections
    }) == 1000

    assert set(capacities.values()) == {10}


def main():
    verify_migration_contract()
    verify_contract_validation()
    verify_thousand_account_contract_plan()

    print("Managed connector tables specified: 9/9")
    print("Connection modes specified: 4/4")
    print(
        "Mobile pairing methods specified: "
        "phone_code + QR"
    )
    print("Composite tenant foreign keys: present")
    print(
        "Plaintext password/token/pairing "
        "artifacts: absent"
    )
    print("Ingress and command idempotency: present")
    print("Managed connection validation: passed")
    print(
        "1,000-account/100-node contract plan: passed"
    )
    print(
        "Existing Account 1 mode preserved: local_web"
    )
    print(
        "\n✅ MANAGED CONNECTOR FOUNDATION TEST PASSED"
    )


if __name__ == "__main__":
    main()