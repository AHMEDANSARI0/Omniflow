import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    ClaimedConnectorCommand,
    ConnectorAssignment,
    ConnectorNodeIdentity,
    ControlPlaneRepository,
    PairingSession,
    RepositoryConflict,
    TenantIsolationViolation,
    generate_enrollment_token,
    generate_node_credential,
    hash_enrollment_token,
    hash_node_credential,
)


class ScriptedCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rowcount = -1
        self._one = None
        self._all = []

    def __enter__(self):
        return self

    def __exit__(
        self,
        error_type,
        error,
        traceback,
    ):
        return False

    def execute(self, query, params=None):
        self.connection.executions.append(
            (
                query,
                tuple(params or ()),
            )
        )

        if not self.connection.script:
            raise AssertionError(
                "Unexpected database execution"
            )

        response = (
            self.connection.script.pop(0)
        )

        if "error" in response:
            raise response["error"]

        self._one = response.get("one")
        self._all = list(
            response.get("all", ())
        )
        self.rowcount = response.get(
            "rowcount",
            1,
        )

    def fetchone(self):
        value = self._one
        self._one = None
        return value

    def fetchall(self):
        values = list(self._all)
        self._all = []
        return values


class ScriptedConnection:
    def __init__(self, script):
        self.script = list(script)
        self.executions = []
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1


def repository_for(connection):
    return ControlPlaneRepository(
        lambda: connection,
        heartbeat_timeout_seconds=90,
    )


def normalized_queries(connection):
    return [
        " ".join(query.lower().split())
        for query, _ in connection.executions
    ]


def verify_node_registration_and_heartbeat():
    node_id = uuid4()

    raw_credential = (
        generate_node_credential()
    )

    digest = hash_node_credential(
        raw_credential
    )

    identity = ConnectorNodeIdentity(
        id=node_id,
        node_name="managed-node-1",
        region="PK-KHI",
        max_sessions=5,
        status="registering",
        version="0.1.0",
    )

    registration_connection = (
        ScriptedConnection(
            [
                {
                    "one": (
                        str(node_id),
                        "registering",
                    )
                },
            ]
        )
    )

    repository = repository_for(
        registration_connection
    )

    registered_id = repository.register_node(
        identity,
        credential_digest=digest,
    )

    assert registered_id == node_id
    assert registration_connection.commits == 1
    assert (
        registration_connection.rollbacks
        == 0
    )
    assert registration_connection.closes == 1

    assert raw_credential not in repr(
        registration_connection.executions
    )

    assert (
        digest
        in registration_connection
        .executions[0][1]
    )

    heartbeat_connection = (
        ScriptedConnection(
            [
                {
                    "one": (
                        5,
                        2,
                        1,
                    )
                },
            ]
        )
    )

    capacity = repository_for(
        heartbeat_connection
    ).heartbeat_node(
        node_id=node_id,
        credential_digest=digest,
        active_sessions=2,
        reserved_sessions=1,
        status="online",
        version="0.1.1",
    )

    assert capacity.available_sessions == 2

    heartbeat_query = normalized_queries(
        heartbeat_connection
    )[0]

    assert (
        "credential_hash = %s"
        in heartbeat_query
    )

    assert (
        "last_heartbeat_at = current_timestamp"
        in heartbeat_query
    )

    assert heartbeat_connection.commits == 1


def verify_atomic_assignment_and_generation_fence():
    node_id = uuid4()

    assignment = ConnectorAssignment(
        channel_account_id=101,
        client_id=501,
        connector_node_id=node_id,
        assignment_generation=1,
    )

    connection = ScriptedConnection(
        [
            {
                "one": (
                    501,
                    "managed_web",
                    "waiting_for_node",
                    None,
                    0,
                )
            },
            {
                "one": (
                    "online",
                    5,
                    1,
                    1,
                    True,
                )
            },
            {
                "rowcount": 1,
            },
            {
                "rowcount": 1,
            },
        ]
    )

    result = repository_for(
        connection
    ).reserve_assignment(
        assignment
    )

    assert result == assignment
    assert connection.commits == 1
    assert connection.rollbacks == 0

    queries = normalized_queries(
        connection
    )

    assert "for update" in queries[0]
    assert "for update" in queries[1]

    assert (
        "reserved_sessions "
        "= reserved_sessions + 1"
        in queries[2]
    )

    assert (
        "assignment_generation = %s"
        in queries[3]
    )


def verify_cross_tenant_assignment_rolls_back():
    node_id = uuid4()

    connection = ScriptedConnection(
        [
            {
                "one": (
                    999,
                    "managed_web",
                    "waiting_for_node",
                    None,
                    0,
                )
            },
        ]
    )

    repository = repository_for(
        connection
    )

    try:
        repository.reserve_assignment(
            ConnectorAssignment(
                channel_account_id=101,
                client_id=501,
                connector_node_id=node_id,
                assignment_generation=1,
            )
        )

    except TenantIsolationViolation:
        pass

    else:
        raise AssertionError(
            "Cross-tenant assignment "
            "was not rejected"
        )

    assert connection.commits == 0
    assert connection.rollbacks == 1
    assert connection.closes == 1
    assert len(connection.executions) == 1


def verify_pairing_token_digest_only():
    node_id = uuid4()
    pairing_id = uuid4()

    raw_token = generate_enrollment_token()

    digest = hash_enrollment_token(
        raw_token
    )

    pairing = PairingSession(
        id=pairing_id,
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

    connection = ScriptedConnection(
        [
            {
                "one": (
                    str(pairing_id),
                )
            },
        ]
    )

    repository_for(
        connection
    ).create_pairing_session(
        pairing,
        enrollment_token_digest=digest,
    )

    recorded = repr(
        connection.executions
    )

    assert raw_token not in recorded

    assert (
        digest
        in connection.executions[0][1]
    )

    query = normalized_queries(
        connection
    )[0]

    assert (
        "enrollment_token_hash"
        in query
    )

    assert (
        "connection.client_id = %s"
        in query
    )

    assert (
        "connection.connector_node_id = %s"
        in query
    )


def verify_command_idempotency_claim_and_ack():
    node_id = uuid4()

    credential_digest = (
        hash_node_credential(
            generate_node_credential()
        )
    )

    enqueue_connection = (
        ScriptedConnection(
            [
                {
                    "one": (
                        7001,
                    )
                },
            ]
        )
    )

    command_id = repository_for(
        enqueue_connection
    ).enqueue_command(
        client_id=501,
        channel_account_id=101,
        connector_node_id=node_id,
        command_type="send_message",
        idempotency_key="reply-job:8001",
        payload={
            "message_type": "text",
            "content": "Hello",
        },
        reply_job_id=8001,
    )

    assert command_id == 7001

    enqueue_query = normalized_queries(
        enqueue_connection
    )[0]

    assert "on conflict" in enqueue_query

    assert (
        "connection.client_id = %s"
        in enqueue_query
    )

    assert (
        "connection.connector_node_id = %s"
        in enqueue_query
    )

    claim_expiry = (
        datetime.now(timezone.utc)
        + timedelta(seconds=60)
    )

    claim_connection = ScriptedConnection(
        [
            {
                "all": [
                    (
                        7001,
                        501,
                        101,
                        str(node_id),
                        "send_message",
                        "reply-job:8001",
                        {
                            "message_type": "text",
                            "content": "Hello",
                        },
                        8001,
                        claim_expiry,
                        1,
                    )
                ]
            },
        ]
    )

    claims = repository_for(
        claim_connection
    ).claim_commands(
        node_id=node_id,
        credential_digest=credential_digest,
        limit=10,
        lease_seconds=60,
    )

    assert len(claims) == 1

    assert isinstance(
        claims[0],
        ClaimedConnectorCommand,
    )

    assert claims[0].id == 7001
    assert (
        claims[0].channel_account_id
        == 101
    )
    assert claims[0].reply_job_id == 8001

    claim_query = normalized_queries(
        claim_connection
    )[0]

    assert "skip locked" in claim_query

    assert (
        "node.credential_hash = %s"
        in claim_query
    )

    assert (
        "command.status = 'claimed'"
        in claim_query
    )

    assert (
        "command.claim_expires_at"
        in claim_query
    )

    assert (
        "node.last_heartbeat_at"
        in claim_query
    )

    assert (
        "connection.connector_node_id "
        "= command.connector_node_id"
        in claim_query
    )

    ack_connection = ScriptedConnection(
        [
            {
                "one": (
                    7001,
                )
            },
        ]
    )

    acknowledged = repository_for(
        ack_connection
    ).acknowledge_command(
        node_id=node_id,
        credential_digest=credential_digest,
        command_id=7001,
        claim_token=claims[0].claim_token,
        outcome="succeeded",
        external_message_id=(
            "provider-message-1"
        ),
    )

    assert acknowledged == 7001

    ack_query = normalized_queries(
        ack_connection
    )[0]

    assert (
        "command.claim_token = %s"
        in ack_query
    )

    assert (
        "command.claim_expires_at "
        ">= current_timestamp"
        in ack_query
    )

    assert (
        "node.credential_hash = %s"
        in ack_query
    )

    assert (
        "connection.connector_node_id = %s"
        in ack_query
    )


def verify_conflict_causes_rollback():
    node_id = uuid4()

    connection = ScriptedConnection(
        [
            {
                "one": (
                    501,
                    "managed_web",
                    "connected",
                    str(node_id),
                    4,
                )
            },
        ]
    )

    try:
        repository_for(
            connection
        ).reserve_assignment(
            ConnectorAssignment(
                channel_account_id=101,
                client_id=501,
                connector_node_id=node_id,
                assignment_generation=5,
            )
        )

    except RepositoryConflict:
        pass

    else:
        raise AssertionError(
            "Expected assignment conflict"
        )

    assert connection.commits == 0
    assert connection.rollbacks == 1
    assert connection.closes == 1


def verify_source_transaction_signatures():
    source = (
        SRC_DIR
        / "control_plane"
        / "repository.py"
    ).read_text(
        encoding="utf-8"
    ).lower()

    normalized = " ".join(
        source.split()
    )

    assert "connection.commit()" in source
    assert "connection.rollback()" in source
    assert "connection.close()" in source

    assert (
        "for update of command skip locked"
        in normalized
    )

    assert (
        "assignment generation fence"
        in source
    )

    assert "credential_hash = %s" in source
    assert "enrollment_token_hash" in source
    assert "::jsonb" in source
    assert "import psycopg" not in source
    assert "print(" not in source


def main():
    verify_node_registration_and_heartbeat()

    verify_atomic_assignment_and_generation_fence()

    verify_cross_tenant_assignment_rolls_back()

    verify_pairing_token_digest_only()

    verify_command_idempotency_claim_and_ack()

    verify_conflict_causes_rollback()

    verify_source_transaction_signatures()

    print(
        "Node registration/heartbeat "
        "transactions: passed"
    )

    print(
        "Credential digest "
        "authentication: passed"
    )

    print(
        "Atomic capacity reservation: passed"
    )

    print(
        "Assignment-generation fencing: passed"
    )

    print(
        "Cross-tenant assignment "
        "rollback: passed"
    )

    print(
        "Pairing token plaintext "
        "persistence: absent"
    )

    print("Command idempotency: passed")

    print(
        "SKIP LOCKED command claim: passed"
    )

    print(
        "Expired command-claim recovery: passed"
    )

    print(
        "Claim-token/expiry "
        "acknowledgement fence: passed"
    )

    print(
        "Commit/rollback/close "
        "boundaries: passed"
    )

    print(
        "\n✅ CONTROL-PLANE "
        "REPOSITORY TEST PASSED"
    )


if __name__ == "__main__":
    main()