import hmac
import os
import secrets
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from uuid import UUID, uuid4

from control_plane import (
    ConnectorNodeIdentity,
    hash_node_credential,
)


class NodeBootstrapError(RuntimeError):
    pass


@dataclass(frozen=True)
class NodeBootstrapConfig:
    node_id: UUID
    node_name: str
    region: str
    max_sessions: int

    credential: str = field(
        repr=False
    )

    def __post_init__(self):
        if not isinstance(
            self.node_id,
            UUID,
        ):
            raise TypeError(
                "node_id must be a UUID"
            )

        node_name = str(
            self.node_name or ""
        ).strip()

        region = str(
            self.region or ""
        ).strip().lower()

        credential = str(
            self.credential or ""
        ).strip()

        maximum = int(
            self.max_sessions
        )

        if (
            not node_name
            or len(node_name) > 255
        ):
            raise ValueError(
                "node_name must contain "
                "1 to 255 characters"
            )

        if (
            not region
            or len(region) > 100
        ):
            raise ValueError(
                "region must contain "
                "1 to 100 characters"
            )

        if maximum <= 0:
            raise ValueError(
                "max_sessions must "
                "be positive"
            )

        if len(credential) < 40:
            raise ValueError(
                "credential does not "
                "have sufficient entropy"
            )

        object.__setattr__(
            self,
            "node_name",
            node_name,
        )

        object.__setattr__(
            self,
            "region",
            region,
        )

        object.__setattr__(
            self,
            "max_sessions",
            maximum,
        )

        object.__setattr__(
            self,
            "credential",
            credential,
        )

    @property
    def credential_digest(self):
        return hash_node_credential(
            self.credential
        )

    def as_environment_text(self):
        values = {
            "CONNECTOR_NODE_ID": (
                str(self.node_id)
            ),
            "CONNECTOR_NODE_NAME": (
                self.node_name
            ),
            "CONNECTOR_NODE_REGION": (
                self.region
            ),
            "CONNECTOR_NODE_MAX_SESSIONS": (
                str(self.max_sessions)
            ),
            "CONNECTOR_NODE_CREDENTIAL": (
                self.credential
            ),
        }

        for key, value in values.items():
            if any(
                character in value
                for character in "\r\n="
            ):
                raise NodeBootstrapError(
                    f"Unsafe character in {key}"
                )

        return "".join(
            f"{key}={value}\n"
            for key, value in values.items()
        )


def generate_node_bootstrap_config(
    node_name,
    region,
    max_sessions,
):
    return NodeBootstrapConfig(
        node_id=uuid4(),
        node_name=node_name,
        region=region,
        max_sessions=max_sessions,
        credential=(
            secrets.token_urlsafe(32)
        ),
    )


def parse_environment_text(text):
    values = {}

    for line_number, raw_line in enumerate(
        str(text or "").splitlines(),
        start=1,
    ):
        line = raw_line.strip()

        if (
            not line
            or line.startswith("#")
        ):
            continue

        if "=" not in line:
            raise NodeBootstrapError(
                "Invalid config line "
                f"{line_number}"
            )

        key, value = line.split(
            "=",
            1,
        )

        key = key.strip()
        value = value.strip()

        if (
            not key
            or key in values
        ):
            raise NodeBootstrapError(
                "Invalid or duplicate config "
                f"key at line {line_number}"
            )

        values[key] = value

    required = {
        "CONNECTOR_NODE_ID",
        "CONNECTOR_NODE_NAME",
        "CONNECTOR_NODE_REGION",
        "CONNECTOR_NODE_MAX_SESSIONS",
        "CONNECTOR_NODE_CREDENTIAL",
    }

    missing = sorted(
        required - set(values)
    )

    if missing:
        raise NodeBootstrapError(
            "Missing connector-node "
            "config values: "
            + ", ".join(missing)
        )

    unexpected = sorted(
        set(values) - required
    )

    if unexpected:
        raise NodeBootstrapError(
            "Unexpected connector-node "
            "config values: "
            + ", ".join(unexpected)
        )

    try:
        node_id = UUID(
            values["CONNECTOR_NODE_ID"]
        )

    except ValueError as error:
        raise NodeBootstrapError(
            "CONNECTOR_NODE_ID "
            "is not a UUID"
        ) from error

    return NodeBootstrapConfig(
        node_id=node_id,
        node_name=(
            values[
                "CONNECTOR_NODE_NAME"
            ]
        ),
        region=(
            values[
                "CONNECTOR_NODE_REGION"
            ]
        ),
        max_sessions=(
            values[
                "CONNECTOR_NODE_MAX_SESSIONS"
            ]
        ),
        credential=(
            values[
                "CONNECTOR_NODE_CREDENTIAL"
            ]
        ),
    )


def write_node_config(
    path,
    config,
):
    if not isinstance(
        config,
        NodeBootstrapConfig,
    ):
        raise TypeError(
            "config must be "
            "NodeBootstrapConfig"
        )

    path = Path(path)

    if path.exists():
        raise NodeBootstrapError(
            "Refusing to overwrite "
            "existing node config: "
            f"{path}"
        )

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temporary = path.with_suffix(
        path.suffix + ".creating"
    )

    if temporary.exists():
        temporary.unlink()

    try:
        temporary.write_text(
            config.as_environment_text(),
            encoding="utf-8",
            newline="\n",
        )

        os.chmod(
            temporary,
            0o600,
        )

        temporary.replace(
            path
        )

        os.chmod(
            path,
            0o600,
        )

    except Exception:
        if temporary.exists():
            temporary.unlink()

        raise

    return path


def load_node_config(path):
    path = Path(path)

    if not path.is_file():
        raise NodeBootstrapError(
            "Connector-node config "
            "does not exist: "
            f"{path}"
        )

    return parse_environment_text(
        path.read_text(
            encoding="utf-8-sig"
        )
    )


def create_or_load_node_config(
    path,
    node_name,
    region,
    max_sessions,
):
    path = Path(path)

    if path.exists():
        config = load_node_config(
            path
        )

        if (
            config.node_name
            != str(node_name).strip()
        ):
            raise NodeBootstrapError(
                "Existing node config name "
                "does not match request"
            )

        if (
            config.region
            != str(region).strip().lower()
        ):
            raise NodeBootstrapError(
                "Existing node config region "
                "does not match request"
            )

        if (
            config.max_sessions
            != int(max_sessions)
        ):
            raise NodeBootstrapError(
                "Existing node config capacity "
                "does not match request"
            )

        return config, False

    config = (
        generate_node_bootstrap_config(
            node_name=node_name,
            region=region,
            max_sessions=max_sessions,
        )
    )

    write_node_config(
        path,
        config,
    )

    return config, True


def register_node(
    repository,
    config,
):
    if not isinstance(
        config,
        NodeBootstrapConfig,
    ):
        raise TypeError(
            "config must be "
            "NodeBootstrapConfig"
        )

    identity = ConnectorNodeIdentity(
        id=config.node_id,
        node_name=config.node_name,
        region=config.region,
        max_sessions=(
            config.max_sessions
        ),
        status="offline",
        version="0.1.0",
        metadata={
            "bootstrap": "local_trial",
        },
    )

    registered_id = (
        repository.register_node(
            identity,
            credential_digest=(
                config.credential_digest
            ),
        )
    )

    if registered_id != config.node_id:
        raise NodeBootstrapError(
            "Repository returned "
            "a different node ID"
        )

    return registered_id


def verify_registered_node(
    connection_factory,
    config,
):
    if not isinstance(
        config,
        NodeBootstrapConfig,
    ):
        raise TypeError(
            "config must be "
            "NodeBootstrapConfig"
        )

    connection = (
        connection_factory()
    )

    try:
        connection.set_session(
            readonly=True,
            autocommit=False,
        )

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    node_name,
                    region,
                    max_sessions,
                    credential_hash,
                    status,
                    active_sessions,
                    reserved_sessions
                FROM connector_nodes
                WHERE id = %s
                """,
                (
                    str(config.node_id),
                ),
            )

            row = cursor.fetchone()

        connection.rollback()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()

    if row is None:
        raise NodeBootstrapError(
            "Registered connector node "
            "was not found"
        )

    expected = (
        config.node_name,
        config.region,
        config.max_sessions,
    )

    if tuple(row[:3]) != expected:
        raise NodeBootstrapError(
            "Registered node identity or "
            "capacity does not match config"
        )

    if not hmac.compare_digest(
        str(row[3]),
        config.credential_digest,
    ):
        raise NodeBootstrapError(
            "Registered node credential "
            "digest does not match"
        )

    if row[4] not in {
        "registering",
        "online",
        "draining",
        "offline",
        "error",
    }:
        raise NodeBootstrapError(
            "Registered node has "
            "an invalid state"
        )

    if (
        int(row[5]) < 0
        or int(row[6]) < 0
    ):
        raise NodeBootstrapError(
            "Registered node has "
            "invalid capacity counters"
        )

    return {
        "node_id": config.node_id,
        "node_name": row[0],
        "region": row[1],
        "max_sessions": int(row[2]),
        "status": row[4],
        "active_sessions": int(row[5]),
        "reserved_sessions": int(row[6]),
    }