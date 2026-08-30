import sys
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
    ManagedSessionAssignment,
    PostgresConnectorGateway,
)
from control_plane import (
    NodeAuthenticationFailed,
    hash_node_credential,
)


class ScriptedCursor:
    def __init__(
        self,
        connection,
    ):
        self.connection = connection
        self._one = None
        self._all = []
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(
        self,
        error_type,
        error,
        traceback,
    ):
        return False

    def execute(
        self,
        query,
        parameters=(),
    ):
        self.connection.executions.append(
            (
                query,
                tuple(
                    parameters or ()
                ),
            )
        )

        if not self.connection.script:
            raise AssertionError(
                "Unexpected database query"
            )

        response = (
            self.connection
            .script
            .pop(0)
        )

        if "error" in response:
            raise response["error"]

        self._one = response.get(
            "one"
        )

        self._all = list(
            response.get(
                "all",
                (),
            )
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
        values = list(
            self._all
        )

        self._all = []

        return values


class ScriptedConnection:
    def __init__(
        self,
        script,
    ):
        self.script = list(script)
        self.executions = []
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0

    def cursor(self):
        return ScriptedCursor(
            self
        )

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1


class FakeCommandRepository:
    def __init__(self):
        self.claim_arguments = None
        self.ack_arguments = None

    def claim_commands(
        self,
        **arguments,
    ):
        self.claim_arguments = (
            arguments
        )

        return (
            "claimed-command",
        )

    def acknowledge_command(
        self,
        **arguments,
    ):
        self.ack_arguments = (
            arguments
        )

        return arguments[
            "command_id"
        ]


def normalized_queries(
    connection,
):
    return [
        " ".join(
            query.lower().split()
        )
        for query, _
        in connection.executions
    ]


def verify_assignment_loading_and_authentication():
    node_id = uuid4()

    digest = hash_node_credential(
        "isolated-gateway-"
        "node-credential"
    )

    connection = ScriptedConnection(
        [
            {
                "one": (
                    "online",
                )
            },
            {
                "all": [
                    (
                        101,
                        501,
                        str(node_id),
                        3,
                        "whatsapp",
                        "connected",
                        (
                            "managed/node/"
                            "account-101"
                        ),
                        {
                            "preferred_region":
                                "pk-khi"
                        },
                    ),
                    (
                        102,
                        502,
                        str(node_id),
                        4,
                        "whatsapp",
                        (
                            "waiting_for_"
                            "pairing"
                        ),
                        (
                            "managed/node/"
                            "account-102"
                        ),
                        {},
                    ),
                ]
            },
        ]
    )

    gateway = (
        PostgresConnectorGateway(
            lambda: connection,
            repository=(
                FakeCommandRepository()
            ),
        )
    )

    assignments = (
        gateway.list_assignments(
            node_id=node_id,
            credential_digest=digest,
        )
    )

    assert len(assignments) == 2

    assert all(
        isinstance(
            item,
            ManagedSessionAssignment,
        )
        for item in assignments
    )

    assert [
        item.channel_account_id
        for item in assignments
    ] == [
        101,
        102,
    ]

    assert (
        assignments[0]
        .assignment_generation
        == 3
    )

    assert (
        assignments[0].platform
        == "whatsapp"
    )

    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1

    queries = normalized_queries(
        connection
    )

    assert (
        "credential_hash = %s"
        in queries[0]
    )

    assert (
        "status <> 'disabled'"
        in queries[0]
    )

    assert (
        "connection.connection_mode "
        "= 'managed_web'"
        in queries[1]
    )

    assert (
        "account.client_id "
        "= connection.client_id"
        in queries[1]
    )


def verify_authentication_failure_rolls_back():
    node_id = uuid4()

    digest = hash_node_credential(
        "wrong-or-disabled-"
        "node-credential"
    )

    connection = ScriptedConnection(
        [
            {
                "one": None,
            },
        ]
    )

    gateway = (
        PostgresConnectorGateway(
            lambda: connection,
            repository=(
                FakeCommandRepository()
            ),
        )
    )

    try:
        gateway.list_assignments(
            node_id=node_id,
            credential_digest=digest,
        )

    except NodeAuthenticationFailed:
        pass

    else:
        raise AssertionError(
            "Expected "
            "NodeAuthenticationFailed"
        )

    assert connection.commits == 0
    assert connection.rollbacks == 1
    assert connection.closes == 1

    assert (
        len(connection.executions)
        == 1
    )


def verify_offline_heartbeat_and_capacity_fence():
    node_id = uuid4()

    digest = hash_node_credential(
        "offline-heartbeat-"
        "node-credential"
    )

    connection = ScriptedConnection(
        [
            {
                "one": (
                    5,
                    0,
                    0,
                    "offline",
                )
            },
        ]
    )

    gateway = (
        PostgresConnectorGateway(
            lambda: connection,
            repository=(
                FakeCommandRepository()
            ),
        )
    )

    result = gateway.heartbeat_node(
        node_id=node_id,
        credential_digest=digest,
        active_sessions=0,
        reserved_sessions=0,
        status="offline",
    )

    assert result == {
        "max_sessions": 5,
        "active_sessions": 0,
        "reserved_sessions": 0,
        "status": "offline",
    }

    query = normalized_queries(
        connection
    )[0]

    assert (
        "credential_hash = %s"
        in query
    )

    assert (
        "%s + %s <= max_sessions"
        in query
    )

    assert (
        "last_heartbeat_at "
        "= current_timestamp"
        in query
    )

    assert connection.commits == 1


def verify_command_delegation():
    node_id = uuid4()

    digest = hash_node_credential(
        "command-delegation-"
        "node-credential"
    )

    repository = (
        FakeCommandRepository()
    )

    gateway = (
        PostgresConnectorGateway(
            lambda: (
                ScriptedConnection([])
            ),
            repository=repository,
        )
    )

    claimed = (
        gateway.claim_commands(
            node_id=node_id,
            credential_digest=digest,
            limit=7,
            lease_seconds=45,
        )
    )

    assert claimed == (
        "claimed-command",
    )

    assert (
        repository
        .claim_arguments["node_id"]
        == node_id
    )

    assert (
        repository
        .claim_arguments["limit"]
        == 7
    )

    claim_token = uuid4()

    acknowledged = (
        gateway.acknowledge_command(
            node_id=node_id,
            credential_digest=digest,
            command_id=7001,
            claim_token=claim_token,
            outcome="succeeded",
            external_message_id=(
                "provider-1"
            ),
        )
    )

    assert acknowledged == 7001

    assert (
        repository
        .ack_arguments["claim_token"]
        == claim_token
    )

    assert (
        repository
        .ack_arguments["outcome"]
        == "succeeded"
    )


def verify_source_safety_signatures():
    source = (
        SRC_DIR
        / "connector_node"
        / "postgres_gateway.py"
    ).read_text(
        encoding="utf-8"
    ).lower()

    normalized = " ".join(
        source.split()
    )

    compact = "".join(
        source.split()
    )

    assert (
        "connection.commit()"
        in compact
    )

    assert (
        "connection.rollback()"
        in compact
    )

    assert (
        "connection.close()"
        in compact
    )

    assert (
        "credential_hash = %s"
        in normalized
    )

    assert (
        "connection_mode = 'managed_web'"
        in normalized
    )

    assert (
        "connector_node_id = %s"
        in normalized
    )

    assert "print(" not in source

    assert (
        "import psycopg"
        not in normalized
    )


def main():
    verify_assignment_loading_and_authentication()

    verify_authentication_failure_rolls_back()

    verify_offline_heartbeat_and_capacity_fence()

    verify_command_delegation()

    verify_source_safety_signatures()

    print(
        "Authenticated assignment "
        "discovery: passed"
    )

    print(
        "Composite tenant join: passed"
    )

    print(
        "Managed-web-only "
        "filtering: passed"
    )

    print(
        "Authentication failure "
        "rollback: passed"
    )

    print(
        "Offline heartbeat "
        "support: passed"
    )

    print(
        "Heartbeat capacity "
        "fencing: passed"
    )

    print(
        "Durable command claim/ack "
        "delegation: passed"
    )

    print(
        "Driver-independent gateway "
        "import: passed"
    )

    print(
        "\nCONNECTOR NODE POSTGRES "
        "GATEWAY TEST PASSED"
    )


if __name__ == "__main__":
    main()