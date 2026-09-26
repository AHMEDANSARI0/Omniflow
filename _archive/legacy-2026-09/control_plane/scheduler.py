from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional, Tuple
from uuid import UUID

from .contracts import (
    ChannelConnection,
    ConnectionMode,
    ConnectionStatus,
    ConnectorAssignment,
    ConnectorNodeSnapshot,
    ConnectorNodeStatus,
)


class NoConnectorCapacity(RuntimeError):
    """Raised when no healthy managed connector node can accept a session."""


@dataclass(frozen=True)
class ConnectorAssignmentPlan:
    assignments: Tuple[ConnectorAssignment, ...]
    unassigned: Tuple[ChannelConnection, ...]

    @property
    def complete(self):
        return not self.unassigned


class ConnectorScheduler:
    """
    Deterministic capacity-aware scheduler for managed connector sessions.

    It is intentionally pure: database row locking and assignment fencing live
    in the repository layer. This planner can therefore be tested against
    thousands of tenants without starting browsers or requiring PostgreSQL.
    """

    def __init__(
        self,
        heartbeat_timeout_seconds=90
    ):
        timeout = int(heartbeat_timeout_seconds)

        if timeout <= 0:
            raise ValueError(
                "heartbeat_timeout_seconds must be positive"
            )

        self.heartbeat_timeout_seconds = timeout

    @staticmethod
    def _utc_now(now=None):
        now = now or datetime.now(timezone.utc)

        if now.tzinfo is None:
            raise ValueError(
                "scheduler time must be timezone-aware"
            )

        return now.astimezone(timezone.utc)

    def node_is_eligible(
        self,
        node: ConnectorNodeSnapshot,
        now=None
    ):
        if not isinstance(node, ConnectorNodeSnapshot):
            raise TypeError(
                "node must be a ConnectorNodeSnapshot"
            )

        if node.identity.status != ConnectorNodeStatus.ONLINE:
            return False

        if node.available_sessions <= 0:
            return False

        if node.last_heartbeat_at is None:
            return False

        current_time = self._utc_now(now)
        oldest_healthy_heartbeat = (
            current_time
            - timedelta(
                seconds=self.heartbeat_timeout_seconds
            )
        )

        return (
            node.last_heartbeat_at.astimezone(
                timezone.utc
            )
            >= oldest_healthy_heartbeat
        )

    @staticmethod
    def _normalize_region(region):
        normalized = str(region or "").strip().lower()
        return normalized or None

    @staticmethod
    def _validate_unique_nodes(nodes):
        node_ids = [
            node.identity.id
            for node in nodes
        ]

        if len(node_ids) != len(set(node_ids)):
            raise ValueError(
                "duplicate connector node IDs are not allowed"
            )

    def choose_node(
        self,
        nodes: Iterable[ConnectorNodeSnapshot],
        preferred_region=None,
        now=None,
        additional_reservations=None
    ):
        nodes = tuple(nodes)
        self._validate_unique_nodes(nodes)
        current_time = self._utc_now(now)
        preferred_region = self._normalize_region(
            preferred_region
        )
        additional_reservations = dict(
            additional_reservations or {}
        )
        candidates = []

        for node in nodes:
            if not self.node_is_eligible(
                node,
                now=current_time
            ):
                continue

            extra = int(
                additional_reservations.get(
                    node.identity.id,
                    0
                )
            )

            if extra < 0:
                raise ValueError(
                    "additional reservations cannot be negative"
                )

            remaining = (
                node.available_sessions
                - extra
            )

            if remaining <= 0:
                continue

            used = (
                node.capacity.active_sessions
                + node.capacity.reserved_sessions
                + extra
            )
            region_penalty = int(
                preferred_region is not None
                and node.identity.region != preferred_region
            )
            utilization = (
                used
                / node.capacity.max_sessions
            )
            candidates.append(
                (
                    region_penalty,
                    utilization,
                    used,
                    node.identity.node_name,
                    str(node.identity.id),
                    node,
                )
            )

        if not candidates:
            raise NoConnectorCapacity(
                "No healthy connector node has available capacity"
            )

        candidates.sort(
            key=lambda item: item[:-1]
        )
        return candidates[0][-1]

    @staticmethod
    def _is_schedulable_connection(connection):
        return (
            connection.connection_mode
            == ConnectionMode.MANAGED_WEB
            and connection.connector_node_id is None
            and connection.status in {
                ConnectionStatus.CREATED,
                ConnectionStatus.WAITING_FOR_NODE,
                ConnectionStatus.DISCONNECTED,
                ConnectionStatus.FAILED,
            }
        )

    def plan_assignments(
        self,
        connections: Iterable[ChannelConnection],
        nodes: Iterable[ConnectorNodeSnapshot],
        now=None
    ):
        connections = tuple(connections)
        nodes = tuple(nodes)
        self._validate_unique_nodes(nodes)
        current_time = self._utc_now(now)
        reservations = {
            node.identity.id: 0
            for node in nodes
        }
        assignments = []
        unassigned = []

        ordered_connections = sorted(
            connections,
            key=lambda connection: (
                connection.client_id,
                connection.channel_account_id,
            )
        )

        for connection in ordered_connections:
            if not isinstance(
                connection,
                ChannelConnection
            ):
                raise TypeError(
                    "connections must contain ChannelConnection values"
                )

            if not self._is_schedulable_connection(
                connection
            ):
                unassigned.append(connection)
                continue

            preferred_region = connection.metadata.get(
                "preferred_region"
            )

            try:
                node = self.choose_node(
                    nodes,
                    preferred_region=preferred_region,
                    now=current_time,
                    additional_reservations=(
                        reservations
                    )
                )
            except NoConnectorCapacity:
                unassigned.append(connection)
                continue

            reservations[node.identity.id] += 1
            assignments.append(
                ConnectorAssignment(
                    channel_account_id=(
                        connection.channel_account_id
                    ),
                    client_id=connection.client_id,
                    connector_node_id=(
                        node.identity.id
                    ),
                    assignment_generation=(
                        connection.assignment_generation
                        + 1
                    ),
                )
            )

        return ConnectorAssignmentPlan(
            assignments=tuple(assignments),
            unassigned=tuple(unassigned),
        )
