from dataclasses import dataclass, field
from typing import Any, Mapping, Optional
from uuid import UUID

from control_plane import (
    ConnectionStatus,
    ConnectorCommandStatus,
)


def positive_integer(
    value,
    field_name,
):
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


def required_text(
    value,
    field_name,
    maximum=None,
):
    normalized = str(
        value or ""
    ).strip()

    if not normalized:
        raise ValueError(
            f"{field_name} is required"
        )

    if (
        maximum is not None
        and len(normalized) > maximum
    ):
        raise ValueError(
            f"{field_name} cannot exceed "
            f"{maximum} characters"
        )

    return normalized


@dataclass(frozen=True)
class ConnectorNodeConfig:
    node_id: UUID
    node_name: str
    region: str
    max_sessions: int

    credential_digest: str = field(
        repr=False
    )

    heartbeat_interval_seconds: float = 20.0
    reconcile_interval_seconds: float = 5.0
    command_interval_seconds: float = 1.0
    command_batch_size: int = 20
    command_lease_seconds: int = 60

    def __post_init__(self):
        if not isinstance(
            self.node_id,
            UUID,
        ):
            raise TypeError(
                "node_id must be a UUID"
            )

        object.__setattr__(
            self,
            "node_name",
            required_text(
                self.node_name,
                "node_name",
                255,
            ),
        )

        object.__setattr__(
            self,
            "region",
            required_text(
                self.region,
                "region",
                100,
            ).lower(),
        )

        object.__setattr__(
            self,
            "max_sessions",
            positive_integer(
                self.max_sessions,
                "max_sessions",
            ),
        )

        digest = required_text(
            self.credential_digest,
            "credential_digest",
            64,
        ).lower()

        if (
            len(digest) != 64
            or any(
                character
                not in "0123456789abcdef"
                for character in digest
            )
        ):
            raise ValueError(
                "credential_digest must be a "
                "64-character SHA-256 digest"
            )

        object.__setattr__(
            self,
            "credential_digest",
            digest,
        )

        for field_name in (
            "heartbeat_interval_seconds",
            "reconcile_interval_seconds",
            "command_interval_seconds",
        ):
            value = float(
                getattr(
                    self,
                    field_name,
                )
            )

            if value <= 0:
                raise ValueError(
                    f"{field_name} must be positive"
                )

            object.__setattr__(
                self,
                field_name,
                value,
            )

        object.__setattr__(
            self,
            "command_batch_size",
            positive_integer(
                self.command_batch_size,
                "command_batch_size",
            ),
        )

        object.__setattr__(
            self,
            "command_lease_seconds",
            positive_integer(
                self.command_lease_seconds,
                "command_lease_seconds",
            ),
        )

        if self.command_batch_size > 100:
            raise ValueError(
                "command_batch_size "
                "cannot exceed 100"
            )


@dataclass(frozen=True)
class ManagedSessionAssignment:
    channel_account_id: int
    client_id: int
    connector_node_id: UUID
    assignment_generation: int
    platform: str
    status: ConnectionStatus
    session_locator: Optional[str] = None

    metadata: Mapping[str, Any] = (
        field(default_factory=dict)
    )

    def __post_init__(self):
        object.__setattr__(
            self,
            "channel_account_id",
            positive_integer(
                self.channel_account_id,
                "channel_account_id",
            ),
        )

        object.__setattr__(
            self,
            "client_id",
            positive_integer(
                self.client_id,
                "client_id",
            ),
        )

        if not isinstance(
            self.connector_node_id,
            UUID,
        ):
            raise TypeError(
                "connector_node_id "
                "must be a UUID"
            )

        object.__setattr__(
            self,
            "assignment_generation",
            positive_integer(
                self.assignment_generation,
                "assignment_generation",
            ),
        )

        object.__setattr__(
            self,
            "platform",
            required_text(
                self.platform,
                "platform",
                30,
            ).lower(),
        )

        object.__setattr__(
            self,
            "status",
            ConnectionStatus(
                self.status
            ),
        )

        if self.session_locator is not None:
            object.__setattr__(
                self,
                "session_locator",
                required_text(
                    self.session_locator,
                    "session_locator",
                    500,
                ),
            )


@dataclass(frozen=True)
class CommandExecutionResult:
    outcome: ConnectorCommandStatus
    external_message_id: Optional[str] = None
    error: Optional[str] = None

    def __post_init__(self):
        outcome = ConnectorCommandStatus(
            self.outcome
        )

        if outcome not in {
            ConnectorCommandStatus.SUCCEEDED,
            ConnectorCommandStatus.FAILED,
            ConnectorCommandStatus.UNKNOWN,
        }:
            raise ValueError(
                "command outcome must be "
                "succeeded, failed, or unknown"
            )

        object.__setattr__(
            self,
            "outcome",
            outcome,
        )


@dataclass(frozen=True)
class ConnectorNodeTickResult:
    assignments_seen: int
    sessions_started: int
    sessions_stopped: int
    active_sessions: int
    reserved_sessions: int
    commands_claimed: int
    commands_acknowledged: int