from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping, Optional
from uuid import UUID


class ConnectionMode(str, Enum):
    LOCAL_WEB = "local_web"
    MANAGED_WEB = "managed_web"
    CLIENT_EDGE = "client_edge"
    CLOUD_API = "cloud_api"


class ConnectionStatus(str, Enum):
    CREATED = "created"
    WAITING_FOR_NODE = "waiting_for_node"
    STARTING_BROWSER = "starting_browser"
    WAITING_FOR_PAIRING = "waiting_for_pairing"
    PAIRING_CODE_READY = "pairing_code_ready"
    QR_READY = "qr_ready"
    AUTHENTICATING = "authenticating"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    DISCONNECTED = "disconnected"
    REVOKED = "revoked"
    FAILED = "failed"


class PairingMethod(str, Enum):
    PHONE_CODE = "phone_code"
    QR = "qr"


class PairingStatus(str, Enum):
    CREATED = "created"
    ASSIGNED = "assigned"
    WAITING_FOR_ARTIFACT = "waiting_for_artifact"
    ARTIFACT_READY = "artifact_ready"
    AUTHENTICATING = "authenticating"
    CONNECTED = "connected"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    FAILED = "failed"


class ConnectorNodeStatus(str, Enum):
    REGISTERING = "registering"
    ONLINE = "online"
    DRAINING = "draining"
    OFFLINE = "offline"
    DISABLED = "disabled"
    ERROR = "error"


class ConnectorCommandType(str, Enum):
    START_PAIRING = "start_pairing"
    CANCEL_PAIRING = "cancel_pairing"
    SEND_MESSAGE = "send_message"
    RESTART_SESSION = "restart_session"
    DISCONNECT_SESSION = "disconnect_session"
    HEALTH_CHECK = "health_check"


class ConnectorCommandStatus(str, Enum):
    PENDING = "pending"
    CLAIMED = "claimed"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


def _positive_integer(value, field_name):
    try:
        normalized = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"{field_name} must be an integer"
        ) from error

    if normalized <= 0:
        raise ValueError(
            f"{field_name} must be positive"
        )

    return normalized


def _required_text(value, field_name, max_length=None):
    normalized = str(value or "").strip()

    if not normalized:
        raise ValueError(
            f"{field_name} is required"
        )

    if (
        max_length is not None
        and len(normalized) > max_length
    ):
        raise ValueError(
            f"{field_name} cannot exceed {max_length} characters"
        )

    return normalized


def _enum_value(value, enum_type, field_name):
    try:
        return enum_type(value)
    except (TypeError, ValueError) as error:
        allowed = ", ".join(
            item.value
            for item in enum_type
        )
        raise ValueError(
            f"Invalid {field_name}; allowed: {allowed}"
        ) from error


@dataclass(frozen=True)
class ConnectorNodeIdentity:
    id: UUID
    node_name: str
    region: str
    max_sessions: int
    status: ConnectorNodeStatus = ConnectorNodeStatus.REGISTERING
    version: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not isinstance(self.id, UUID):
            raise TypeError("id must be a UUID")

        object.__setattr__(
            self,
            "node_name",
            _required_text(
                self.node_name,
                "node_name",
                255
            )
        )
        object.__setattr__(
            self,
            "region",
            _required_text(
                self.region,
                "region",
                100
            ).lower()
        )
        object.__setattr__(
            self,
            "max_sessions",
            _positive_integer(
                self.max_sessions,
                "max_sessions"
            )
        )
        object.__setattr__(
            self,
            "status",
            _enum_value(
                self.status,
                ConnectorNodeStatus,
                "node status"
            )
        )

        if self.version is not None:
            object.__setattr__(
                self,
                "version",
                _required_text(
                    self.version,
                    "version",
                    100
                )
            )


@dataclass(frozen=True)
class ConnectorNodeCapacity:
    node_id: UUID
    max_sessions: int
    active_sessions: int = 0
    reserved_sessions: int = 0

    def __post_init__(self):
        if not isinstance(self.node_id, UUID):
            raise TypeError("node_id must be a UUID")

        maximum = _positive_integer(
            self.max_sessions,
            "max_sessions"
        )
        active = int(self.active_sessions)
        reserved = int(self.reserved_sessions)

        if active < 0 or reserved < 0:
            raise ValueError(
                "session counts cannot be negative"
            )

        if active + reserved > maximum:
            raise ValueError(
                "active and reserved sessions exceed node capacity"
            )

        object.__setattr__(self, "max_sessions", maximum)
        object.__setattr__(self, "active_sessions", active)
        object.__setattr__(self, "reserved_sessions", reserved)

    @property
    def available_sessions(self):
        return (
            self.max_sessions
            - self.active_sessions
            - self.reserved_sessions
        )


@dataclass(frozen=True)
class ConnectorNodeSnapshot:
    identity: ConnectorNodeIdentity
    capacity: ConnectorNodeCapacity
    last_heartbeat_at: Optional[datetime]

    def __post_init__(self):
        if self.identity.id != self.capacity.node_id:
            raise ValueError(
                "node identity and capacity IDs do not match"
            )

        if (
            self.last_heartbeat_at is not None
            and self.last_heartbeat_at.tzinfo is None
        ):
            raise ValueError(
                "last_heartbeat_at must be timezone-aware"
            )

    @property
    def available_sessions(self):
        return self.capacity.available_sessions


@dataclass(frozen=True)
class ConnectorAssignment:
    channel_account_id: int
    client_id: int
    connector_node_id: UUID
    assignment_generation: int

    def __post_init__(self):
        object.__setattr__(
            self,
            "channel_account_id",
            _positive_integer(
                self.channel_account_id,
                "channel_account_id"
            )
        )
        object.__setattr__(
            self,
            "client_id",
            _positive_integer(
                self.client_id,
                "client_id"
            )
        )

        if not isinstance(self.connector_node_id, UUID):
            raise TypeError(
                "connector_node_id must be a UUID"
            )

        generation = _positive_integer(
            self.assignment_generation,
            "assignment_generation"
        )
        object.__setattr__(
            self,
            "assignment_generation",
            generation
        )


@dataclass(frozen=True)
class ChannelConnection:
    channel_account_id: int
    client_id: int
    connection_mode: ConnectionMode
    status: ConnectionStatus = ConnectionStatus.CREATED
    connector_node_id: Optional[UUID] = None
    assignment_generation: int = 0
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        object.__setattr__(
            self,
            "channel_account_id",
            _positive_integer(
                self.channel_account_id,
                "channel_account_id"
            )
        )
        object.__setattr__(
            self,
            "client_id",
            _positive_integer(
                self.client_id,
                "client_id"
            )
        )
        object.__setattr__(
            self,
            "connection_mode",
            _enum_value(
                self.connection_mode,
                ConnectionMode,
                "connection_mode"
            )
        )
        object.__setattr__(
            self,
            "status",
            _enum_value(
                self.status,
                ConnectionStatus,
                "connection status"
            )
        )

        generation = int(self.assignment_generation)

        if generation < 0:
            raise ValueError(
                "assignment_generation cannot be negative"
            )

        object.__setattr__(
            self,
            "assignment_generation",
            generation
        )

        if (
            self.connector_node_id is not None
            and not isinstance(self.connector_node_id, UUID)
        ):
            raise TypeError(
                "connector_node_id must be a UUID or None"
            )

        if (
            self.connection_mode == ConnectionMode.MANAGED_WEB
            and self.status in {
                ConnectionStatus.STARTING_BROWSER,
                ConnectionStatus.WAITING_FOR_PAIRING,
                ConnectionStatus.PAIRING_CODE_READY,
                ConnectionStatus.QR_READY,
                ConnectionStatus.AUTHENTICATING,
                ConnectionStatus.CONNECTED,
                ConnectionStatus.RECONNECTING,
            }
            and self.connector_node_id is None
        ):
            raise ValueError(
                "managed_web connection state requires a connector node"
            )


@dataclass(frozen=True)
class PairingSession:
    id: UUID
    channel_account_id: int
    client_id: int
    method: PairingMethod
    status: PairingStatus
    expires_at: datetime
    connector_node_id: Optional[UUID] = None
    initiated_by_user_id: Optional[int] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not isinstance(self.id, UUID):
            raise TypeError("id must be a UUID")

        object.__setattr__(
            self,
            "channel_account_id",
            _positive_integer(
                self.channel_account_id,
                "channel_account_id"
            )
        )
        object.__setattr__(
            self,
            "client_id",
            _positive_integer(
                self.client_id,
                "client_id"
            )
        )
        object.__setattr__(
            self,
            "method",
            _enum_value(
                self.method,
                PairingMethod,
                "pairing method"
            )
        )
        object.__setattr__(
            self,
            "status",
            _enum_value(
                self.status,
                PairingStatus,
                "pairing status"
            )
        )

        if self.expires_at.tzinfo is None:
            raise ValueError(
                "expires_at must be timezone-aware"
            )

        if self.expires_at <= datetime.now(timezone.utc):
            raise ValueError(
                "pairing session must expire in the future"
            )

        if self.initiated_by_user_id is not None:
            object.__setattr__(
                self,
                "initiated_by_user_id",
                _positive_integer(
                    self.initiated_by_user_id,
                    "initiated_by_user_id"
                )
            )

        if (
            self.connector_node_id is not None
            and not isinstance(self.connector_node_id, UUID)
        ):
            raise TypeError(
                "connector_node_id must be a UUID or None"
            )

        if (
            self.status in {
                PairingStatus.ASSIGNED,
                PairingStatus.WAITING_FOR_ARTIFACT,
                PairingStatus.ARTIFACT_READY,
                PairingStatus.AUTHENTICATING,
                PairingStatus.CONNECTED,
            }
            and self.connector_node_id is None
        ):
            raise ValueError(
                "assigned pairing state requires a connector node"
            )


@dataclass(frozen=True)
class ConnectorCommand:
    id: int
    channel_account_id: int
    client_id: int
    connector_node_id: UUID
    command_type: ConnectorCommandType
    idempotency_key: str
    payload: Mapping[str, Any]
    status: ConnectorCommandStatus = ConnectorCommandStatus.PENDING
    reply_job_id: Optional[int] = None

    def __post_init__(self):
        object.__setattr__(
            self,
            "id",
            _positive_integer(self.id, "id")
        )
        object.__setattr__(
            self,
            "channel_account_id",
            _positive_integer(
                self.channel_account_id,
                "channel_account_id"
            )
        )
        object.__setattr__(
            self,
            "client_id",
            _positive_integer(
                self.client_id,
                "client_id"
            )
        )

        if not isinstance(self.connector_node_id, UUID):
            raise TypeError(
                "connector_node_id must be a UUID"
            )

        object.__setattr__(
            self,
            "command_type",
            _enum_value(
                self.command_type,
                ConnectorCommandType,
                "command type"
            )
        )
        object.__setattr__(
            self,
            "status",
            _enum_value(
                self.status,
                ConnectorCommandStatus,
                "command status"
            )
        )
        object.__setattr__(
            self,
            "idempotency_key",
            _required_text(
                self.idempotency_key,
                "idempotency_key",
                255
            )
        )

        if self.reply_job_id is not None:
            object.__setattr__(
                self,
                "reply_job_id",
                _positive_integer(
                    self.reply_job_id,
                    "reply_job_id"
                )
            )

        if (
            self.command_type == ConnectorCommandType.SEND_MESSAGE
            and self.reply_job_id is None
        ):
            raise ValueError(
                "send_message command requires reply_job_id"
            )
