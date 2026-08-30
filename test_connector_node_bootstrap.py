import ast
import os
import sys
import tempfile
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from connector_node import (  # noqa: E402
    NodeBootstrapConfig,
    NodeBootstrapError,
    create_or_load_node_config,
    generate_node_bootstrap_config,
    load_node_config,
    register_node,
    verify_registered_node,
    write_node_config,
)


class FakeRepository:
    def __init__(self):
        self.identity = None
        self.digest = None

    def register_node(
        self,
        identity,
        credential_digest,
    ):
        self.identity = identity
        self.digest = credential_digest
        return identity.id


class VerifyCursor:
    def __init__(self, connection):
        self.connection = connection
        self.query = None
        self.parameters = None

    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        return False

    def execute(self, query, parameters=()):
        self.query = query
        self.parameters = tuple(parameters)
        self.connection.executions.append(
            (query, self.parameters)
        )

    def fetchone(self):
        return self.connection.row


class VerifyConnection:
    def __init__(self, row):
        self.row = row
        self.executions = []
        self.sessions = []
        self.rollbacks = 0
        self.closes = 0

    def set_session(self, **arguments):
        self.sessions.append(arguments)

    def cursor(self):
        return VerifyCursor(self)

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1


def expect_error(error_type, callback):
    try:
        callback()
    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def verify_generation_and_secret_repr():
    configs = [
        generate_node_bootstrap_config(
            node_name=f"node-{number}",
            region="PK-KHI",
            max_sessions=5,
        )
        for number in range(200)
    ]
    assert len({item.node_id for item in configs}) == 200
    assert len({item.credential for item in configs}) == 200
    assert all(
        len(item.credential) >= 40
        for item in configs
    )
    assert all(
        item.credential not in repr(item)
        for item in configs
    )
    assert all(
        len(item.credential_digest) == 64
        for item in configs
    )


def verify_atomic_config_round_trip():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / ".connector_node.env"
        config, created = create_or_load_node_config(
            path=path,
            node_name="omniflow-local-trial-1",
            region="PK-KHI",
            max_sessions=5,
        )
        assert created
        assert path.is_file()
        loaded = load_node_config(path)
        assert loaded == config

        repeated, created_again = create_or_load_node_config(
            path=path,
            node_name="omniflow-local-trial-1",
            region="pk-khi",
            max_sessions=5,
        )
        assert repeated == config
        assert not created_again

        expect_error(
            NodeBootstrapError,
            lambda: write_node_config(path, config),
        )
        expect_error(
            NodeBootstrapError,
            lambda: create_or_load_node_config(
                path=path,
                node_name="different-node",
                region="pk-khi",
                max_sessions=5,
            ),
        )

        if os.name != "nt":
            assert path.stat().st_mode & 0o077 == 0


def verify_digest_only_registration():
    config = generate_node_bootstrap_config(
        node_name="omniflow-local-trial-1",
        region="pk-khi",
        max_sessions=5,
    )
    repository = FakeRepository()
    registered_id = register_node(repository, config)

    assert registered_id == config.node_id
    assert repository.identity.id == config.node_id
    assert repository.identity.status.value == "offline"
    assert repository.digest == config.credential_digest
    assert config.credential not in repr(repository.identity)
    assert config.credential not in repository.digest


def verify_read_only_database_check():
    config = NodeBootstrapConfig(
        node_id=uuid4(),
        node_name="omniflow-local-trial-1",
        region="pk-khi",
        max_sessions=5,
        credential=(
            "high-entropy-local-node-credential-value-123456789"
        ),
    )
    connection = VerifyConnection((
        config.node_name,
        config.region,
        config.max_sessions,
        config.credential_digest,
        "offline",
        0,
        0,
    ))
    result = verify_registered_node(
        lambda: connection,
        config,
    )

    assert result["node_id"] == config.node_id
    assert result["status"] == "offline"
    assert connection.sessions == [
        {
            "readonly": True,
            "autocommit": False,
        }
    ]
    assert connection.rollbacks == 1
    assert connection.closes == 1
    assert str(config.node_id) in connection.executions[0][1]


def verify_source_safety():
    bootstrap_source = (
        SRC_DIR
        / "connector_node"
        / "bootstrap.py"
    ).read_text(encoding="utf-8")
    cli_source = (
        PROJECT_ROOT
        / "bootstrap_connector_node.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(bootstrap_source)

    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "replace"
        for node in ast.walk(tree)
    )
    lowered = (bootstrap_source + cli_source).lower()
    assert "token_urlsafe" in lowered
    assert "credential_digest" in lowered
    assert "readonly=true" in "".join(lowered.split())
    assert "playwright" not in lowered
    assert "run_channel" not in lowered
    assert "whatsapp_sessions" not in lowered
    assert "print(config.credential" not in lowered
    assert "print(result['credential" not in lowered


def main():
    verify_generation_and_secret_repr()
    verify_atomic_config_round_trip()
    verify_digest_only_registration()
    verify_read_only_database_check()
    verify_source_safety()

    print("Node IDs and credentials: 200/200 unique")
    print("Credential repr/log suppression: passed")
    print("Atomic restrictive config write: passed")
    print("Idempotent existing-config load: passed")
    print("Database credential persistence: digest only")
    print("Read-only registration verification: passed")
    print("Browser/WhatsApp side effects: absent")
    print("\nCONNECTOR NODE BOOTSTRAP TEST PASSED")


if __name__ == "__main__":
    main()
