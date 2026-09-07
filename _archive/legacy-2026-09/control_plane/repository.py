import json
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Optional
from uuid import UUID, uuid4

from .contracts import (
    ChannelConnection,
    ConnectionMode,
    ConnectionStatus,
    ConnectorAssignment,
    ConnectorCommandStatus,
    ConnectorCommandType,
    ConnectorNodeCapacity,
    ConnectorNodeIdentity,
    ConnectorNodeSnapshot,
    PairingSession,
)
from .security import require_secret_digest


class ControlPlaneRepositoryError(RuntimeError):
    pass


class RecordNotFound(ControlPlaneRepositoryError):
    pass


class RepositoryConflict(ControlPlaneRepositoryError):
    pass


class TenantIsolationViolation(
    ControlPlaneRepositoryError
):
    pass


class NodeAuthenticationFailed(
    ControlPlaneRepositoryError
):
    pass


class CapacityUnavailable(ControlPlaneRepositoryError):
    pass


@dataclass(frozen=True)
class ClaimedConnectorCommand:
    id: int
    client_id: int
    channel_account_id: int
    connector_node_id: UUID
    command_type: ConnectorCommandType
    idempotency_key: str
    payload: Mapping[str, Any]
    reply_job_id: Optional[int]
    claim_token: UUID
    claim_expires_at: datetime
    attempt_count: int


class ControlPlaneRepository:
    """
    Transaction boundary for the managed connector control plane.

    The connection factory must return a PEP-249 compatible
    PostgreSQL connection.

    No database driver is imported here, so unit tests and
    control-plane contracts remain isolated from a specific
    driver.
    """

    _ASSIGNABLE_STATUSES = {
        ConnectionStatus.CREATED.value,
        ConnectionStatus.WAITING_FOR_NODE.value,
        ConnectionStatus.DISCONNECTED.value,
        ConnectionStatus.FAILED.value,
    }

    def __init__(
        self,
        connection_factory,
        heartbeat_timeout_seconds=90,
    ):
        if not callable(connection_factory):
            raise TypeError(
                "connection_factory must be callable"
            )

        heartbeat_timeout_seconds = int(
            heartbeat_timeout_seconds
        )

        if heartbeat_timeout_seconds <= 0:
            raise ValueError(
                "heartbeat_timeout_seconds must be positive"
            )

        self._connection_factory = connection_factory
        self.heartbeat_timeout_seconds = (
            heartbeat_timeout_seconds
        )

    @contextmanager
    def _transaction(self):
        connection = self._connection_factory()

        try:
            with connection.cursor() as cursor:
                yield cursor

            connection.commit()

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

    @staticmethod
    def _uuid(value, field_name):
        if isinstance(value, UUID):
            return value

        try:
            return UUID(str(value))

        except (TypeError, ValueError) as error:
            raise ValueError(
                f"{field_name} must be a UUID"
            ) from error

    @staticmethod
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

    @staticmethod
    def _json_payload(value, field_name):
        if not isinstance(value, Mapping):
            raise ValueError(
                f"{field_name} must be a mapping"
            )

        try:
            return json.dumps(
                dict(value),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )

        except (TypeError, ValueError) as error:
            raise ValueError(
                f"{field_name} must be JSON serializable"
            ) from error

    @staticmethod
    def _mapping(value):
        if value is None:
            return {}

        if isinstance(value, Mapping):
            return dict(value)

        if isinstance(value, str):
            parsed = json.loads(value)

            if isinstance(parsed, Mapping):
                return dict(parsed)

        raise ValueError(
            "database JSON value must be an object"
        )

    def register_node(
        self,
        identity: ConnectorNodeIdentity,
        credential_digest,
        public_key=None,
    ):
        if not isinstance(
            identity,
            ConnectorNodeIdentity,
        ):
            raise TypeError(
                "identity must be ConnectorNodeIdentity"
            )

        credential_digest = require_secret_digest(
            credential_digest,
            "credential_digest",
        )

        metadata = self._json_payload(
            identity.metadata,
            "node metadata",
        )

        with self._transaction() as cursor:
            cursor.execute(
                """
                INSERT INTO connector_nodes (
                    id,
                    node_name,
                    region,
                    status,
                    version,
                    public_key,
                    credential_hash,
                    max_sessions,
                    metadata,
                    updated_at
                )
                VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s::jsonb,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (id)
                DO UPDATE SET
                    node_name = EXCLUDED.node_name,
                    region = EXCLUDED.region,
                    status = CASE
                        WHEN connector_nodes.status
                             = 'disabled'
                        THEN connector_nodes.status
                        ELSE EXCLUDED.status
                    END,
                    version = EXCLUDED.version,
                    public_key = EXCLUDED.public_key,
                    credential_hash
                        = EXCLUDED.credential_hash,
                    max_sessions = EXCLUDED.max_sessions,
                    metadata = EXCLUDED.metadata,
                    updated_at = CURRENT_TIMESTAMP
                WHERE
                    connector_nodes.active_sessions
                    + connector_nodes.reserved_sessions
                    <= EXCLUDED.max_sessions
                RETURNING id, status
                """,
                (
                    str(identity.id),
                    identity.node_name,
                    identity.region,
                    identity.status.value,
                    identity.version,
                    public_key,
                    credential_digest,
                    identity.max_sessions,
                    metadata,
                ),
            )

            row = cursor.fetchone()

            if row is None:
                raise CapacityUnavailable(
                    "Node capacity cannot be reduced "
                    "below current usage"
                )

            return self._uuid(
                row[0],
                "node id",
            )

    def heartbeat_node(
        self,
        node_id,
        credential_digest,
        active_sessions,
        reserved_sessions,
        status="online",
        version=None,
        last_error=None,
    ):
        node_id = self._uuid(
            node_id,
            "node_id",
        )

        credential_digest = require_secret_digest(
            credential_digest,
            "credential_digest",
        )

        active_sessions = int(active_sessions)
        reserved_sessions = int(reserved_sessions)
        status = str(
            status or ""
        ).strip().lower()

        if (
            active_sessions < 0
            or reserved_sessions < 0
        ):
            raise ValueError(
                "session counts cannot be negative"
            )

        if status not in {
            "registering",
            "online",
            "draining",
            "error",
        }:
            raise ValueError(
                "invalid heartbeat node status"
            )

        with self._transaction() as cursor:
            cursor.execute(
                """
                UPDATE connector_nodes
                SET
                    status = %s,
                    version = COALESCE(%s, version),
                    active_sessions = %s,
                    reserved_sessions = %s,
                    last_heartbeat_at
                        = CURRENT_TIMESTAMP,
                    last_error = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                  AND credential_hash = %s
                  AND status <> 'disabled'
                  AND %s + %s <= max_sessions
                RETURNING
                    max_sessions,
                    active_sessions,
                    reserved_sessions
                """,
                (
                    status,
                    version,
                    active_sessions,
                    reserved_sessions,
                    last_error,
                    str(node_id),
                    credential_digest,
                    active_sessions,
                    reserved_sessions,
                ),
            )

            row = cursor.fetchone()

            if row is None:
                raise NodeAuthenticationFailed(
                    "Node authentication, state, or "
                    "capacity check failed"
                )

            return ConnectorNodeCapacity(
                node_id=node_id,
                max_sessions=row[0],
                active_sessions=row[1],
                reserved_sessions=row[2],
            )

    def list_schedulable_nodes(self):
        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    node_name,
                    region,
                    max_sessions,
                    status,
                    version,
                    metadata,
                    active_sessions,
                    reserved_sessions,
                    last_heartbeat_at
                FROM connector_nodes
                WHERE status = 'online'
                  AND last_heartbeat_at >= (
                      CURRENT_TIMESTAMP
                      - (%s * INTERVAL '1 second')
                  )
                  AND active_sessions
                      + reserved_sessions
                      < max_sessions
                ORDER BY region, node_name, id
                """,
                (
                    self.heartbeat_timeout_seconds,
                ),
            )

            rows = cursor.fetchall()

        snapshots = []

        for row in rows:
            node_id = self._uuid(
                row[0],
                "node id",
            )

            identity = ConnectorNodeIdentity(
                id=node_id,
                node_name=row[1],
                region=row[2],
                max_sessions=row[3],
                status=row[4],
                version=row[5],
                metadata=self._mapping(row[6]),
            )

            capacity = ConnectorNodeCapacity(
                node_id=node_id,
                max_sessions=row[3],
                active_sessions=row[7],
                reserved_sessions=row[8],
            )

            snapshots.append(
                ConnectorNodeSnapshot(
                    identity=identity,
                    capacity=capacity,
                    last_heartbeat_at=row[9],
                )
            )

        return tuple(snapshots)

    def list_unassigned_connections(
        self,
        limit=100,
    ):
        limit = self._positive_integer(
            limit,
            "limit",
        )

        if limit > 1000:
            raise ValueError(
                "limit cannot exceed 1000"
            )

        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT
                    channel_account_id,
                    client_id,
                    connection_mode,
                    status,
                    connector_node_id,
                    assignment_generation,
                    metadata
                FROM channel_connections
                WHERE connection_mode = 'managed_web'
                  AND connector_node_id IS NULL
                  AND status IN (
                      'created',
                      'waiting_for_node',
                      'disconnected',
                      'failed'
                  )
                ORDER BY
                    updated_at,
                    client_id,
                    channel_account_id
                LIMIT %s
                """,
                (limit,),
            )

            rows = cursor.fetchall()

        return tuple(
            ChannelConnection(
                channel_account_id=row[0],
                client_id=row[1],
                connection_mode=row[2],
                status=row[3],
                connector_node_id=(
                    self._uuid(
                        row[4],
                        "connector_node_id",
                    )
                    if row[4] is not None
                    else None
                ),
                assignment_generation=row[5],
                metadata=self._mapping(row[6]),
            )
            for row in rows
        )

    def reserve_assignment(
        self,
        assignment: ConnectorAssignment,
    ):
        if not isinstance(
            assignment,
            ConnectorAssignment,
        ):
            raise TypeError(
                "assignment must be ConnectorAssignment"
            )

        expected_generation = (
            assignment.assignment_generation - 1
        )

        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT
                    client_id,
                    connection_mode,
                    status,
                    connector_node_id,
                    assignment_generation
                FROM channel_connections
                WHERE channel_account_id = %s
                FOR UPDATE
                """,
                (
                    assignment.channel_account_id,
                ),
            )

            connection_row = cursor.fetchone()

            if connection_row is None:
                raise RecordNotFound(
                    "Channel connection does not exist"
                )

            if (
                int(connection_row[0])
                != assignment.client_id
            ):
                raise TenantIsolationViolation(
                    "Channel account does not "
                    "belong to client"
                )

            if (
                connection_row[1]
                != ConnectionMode.MANAGED_WEB.value
            ):
                raise RepositoryConflict(
                    "Only managed_web connections "
                    "can be assigned"
                )

            if (
                connection_row[2]
                not in self._ASSIGNABLE_STATUSES
            ):
                raise RepositoryConflict(
                    "Connection is not in an "
                    "assignable state"
                )

            if connection_row[3] is not None:
                raise RepositoryConflict(
                    "Connection is already assigned"
                )

            if (
                int(connection_row[4])
                != expected_generation
            ):
                raise RepositoryConflict(
                    "Assignment generation fence "
                    "rejected stale assignment"
                )

            cursor.execute(
                """
                SELECT
                    status,
                    max_sessions,
                    active_sessions,
                    reserved_sessions,
                    last_heartbeat_at >= (
                        CURRENT_TIMESTAMP
                        - (
                            %s
                            * INTERVAL '1 second'
                        )
                    ) AS heartbeat_healthy
                FROM connector_nodes
                WHERE id = %s
                FOR UPDATE
                """,
                (
                    self.heartbeat_timeout_seconds,
                    str(
                        assignment.connector_node_id
                    ),
                ),
            )

            node_row = cursor.fetchone()

            if node_row is None:
                raise RecordNotFound(
                    "Connector node does not exist"
                )

            if (
                node_row[0] != "online"
                or not node_row[4]
            ):
                raise CapacityUnavailable(
                    "Connector node is not healthy "
                    "and online"
                )

            if (
                int(node_row[2])
                + int(node_row[3])
                >= int(node_row[1])
            ):
                raise CapacityUnavailable(
                    "Connector node has no "
                    "available capacity"
                )

            cursor.execute(
                """
                UPDATE connector_nodes
                SET
                    reserved_sessions
                        = reserved_sessions + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                  AND active_sessions
                      + reserved_sessions
                      < max_sessions
                """,
                (
                    str(
                        assignment.connector_node_id
                    ),
                ),
            )

            if cursor.rowcount != 1:
                raise CapacityUnavailable(
                    "Connector node capacity "
                    "changed concurrently"
                )

            cursor.execute(
                """
                UPDATE channel_connections
                SET
                    connector_node_id = %s,
                    assignment_generation = %s,
                    status = 'waiting_for_pairing',
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE channel_account_id = %s
                  AND client_id = %s
                  AND connector_node_id IS NULL
                  AND assignment_generation = %s
                """,
                (
                    str(
                        assignment.connector_node_id
                    ),
                    assignment.assignment_generation,
                    assignment.channel_account_id,
                    assignment.client_id,
                    expected_generation,
                ),
            )

            if cursor.rowcount != 1:
                raise RepositoryConflict(
                    "Connection assignment "
                    "changed concurrently"
                )

        return assignment

    def create_pairing_session(
        self,
        pairing: PairingSession,
        enrollment_token_digest,
    ):
        if not isinstance(
            pairing,
            PairingSession,
        ):
            raise TypeError(
                "pairing must be PairingSession"
            )

        enrollment_token_digest = (
            require_secret_digest(
                enrollment_token_digest,
                "enrollment_token_digest",
            )
        )

        metadata = self._json_payload(
            pairing.metadata,
            "pairing metadata",
        )

        with self._transaction() as cursor:
            cursor.execute(
                """
                INSERT INTO pairing_sessions (
                    id,
                    channel_account_id,
                    client_id,
                    connector_node_id,
                    initiated_by_user_id,
                    pairing_method,
                    status,
                    enrollment_token_hash,
                    expires_at,
                    metadata
                )
                SELECT
                    %s,
                    connection.channel_account_id,
                    connection.client_id,
                    connection.connector_node_id,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s::jsonb
                FROM channel_connections connection
                WHERE
                    connection.channel_account_id
                        = %s
                  AND connection.client_id = %s
                  AND connection.connector_node_id
                        = %s
                  AND connection.connection_mode
                        = 'managed_web'
                  AND connection.status
                        NOT IN ('revoked')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """,
                (
                    str(pairing.id),
                    pairing.initiated_by_user_id,
                    pairing.method.value,
                    pairing.status.value,
                    enrollment_token_digest,
                    pairing.expires_at,
                    metadata,
                    pairing.channel_account_id,
                    pairing.client_id,
                    (
                        str(
                            pairing.connector_node_id
                        )
                        if (
                            pairing.connector_node_id
                            is not None
                        )
                        else None
                    ),
                ),
            )

            row = cursor.fetchone()

            if row is None:
                raise RepositoryConflict(
                    "Pairing session assignment or "
                    "idempotency check failed"
                )

        return pairing

    def enqueue_command(
        self,
        client_id,
        channel_account_id,
        connector_node_id,
        command_type,
        idempotency_key,
        payload,
        reply_job_id=None,
    ):
        client_id = self._positive_integer(
            client_id,
            "client_id",
        )

        channel_account_id = (
            self._positive_integer(
                channel_account_id,
                "channel_account_id",
            )
        )

        connector_node_id = self._uuid(
            connector_node_id,
            "connector_node_id",
        )

        command_type = ConnectorCommandType(
            command_type
        )

        idempotency_key = str(
            idempotency_key or ""
        ).strip()

        if (
            not idempotency_key
            or len(idempotency_key) > 255
        ):
            raise ValueError(
                "idempotency_key must contain "
                "1 to 255 characters"
            )

        if reply_job_id is not None:
            reply_job_id = self._positive_integer(
                reply_job_id,
                "reply_job_id",
            )

        if (
            command_type
            == ConnectorCommandType.SEND_MESSAGE
            and reply_job_id is None
        ):
            raise ValueError(
                "send_message requires reply_job_id"
            )

        payload_json = self._json_payload(
            payload,
            "command payload",
        )

        with self._transaction() as cursor:
            cursor.execute(
                """
                INSERT INTO connector_commands (
                    client_id,
                    channel_account_id,
                    connector_node_id,
                    reply_job_id,
                    command_type,
                    idempotency_key,
                    payload
                )
                SELECT
                    connection.client_id,
                    connection.channel_account_id,
                    connection.connector_node_id,
                    %s,
                    %s,
                    %s,
                    %s::jsonb
                FROM channel_connections connection
                WHERE
                    connection.channel_account_id
                        = %s
                  AND connection.client_id = %s
                  AND connection.connector_node_id
                        = %s
                  AND connection.connection_mode
                        = 'managed_web'
                  AND connection.status <> 'revoked'
                ON CONFLICT (
                    channel_account_id,
                    idempotency_key
                )
                DO NOTHING
                RETURNING id
                """,
                (
                    reply_job_id,
                    command_type.value,
                    idempotency_key,
                    payload_json,
                    channel_account_id,
                    client_id,
                    str(connector_node_id),
                ),
            )

            row = cursor.fetchone()

            if row is not None:
                return int(row[0])

            cursor.execute(
                """
                SELECT id
                FROM connector_commands
                WHERE channel_account_id = %s
                  AND client_id = %s
                  AND connector_node_id = %s
                  AND idempotency_key = %s
                  AND command_type = %s
                  AND payload = %s::jsonb
                  AND reply_job_id
                      IS NOT DISTINCT FROM %s
                """,
                (
                    channel_account_id,
                    client_id,
                    str(connector_node_id),
                    idempotency_key,
                    command_type.value,
                    payload_json,
                    reply_job_id,
                ),
            )

            existing = cursor.fetchone()

            if existing is None:
                raise RepositoryConflict(
                    "Idempotency key was reused "
                    "with different command data"
                )

            return int(existing[0])

    def claim_commands(
        self,
        node_id,
        credential_digest,
        limit=10,
        lease_seconds=60,
    ):
        node_id = self._uuid(
            node_id,
            "node_id",
        )

        credential_digest = require_secret_digest(
            credential_digest,
            "credential_digest",
        )

        limit = self._positive_integer(
            limit,
            "limit",
        )

        lease_seconds = self._positive_integer(
            lease_seconds,
            "lease_seconds",
        )

        if limit > 100:
            raise ValueError(
                "limit cannot exceed 100"
            )

        claim_token = uuid4()

        with self._transaction() as cursor:
            cursor.execute(
                """
                WITH candidates AS (
                    SELECT command.id
                    FROM connector_commands command

                    JOIN channel_connections connection
                      ON connection.channel_account_id
                         = command.channel_account_id
                     AND connection.client_id
                         = command.client_id
                     AND connection.connector_node_id
                         = command.connector_node_id

                    JOIN connector_nodes node
                      ON node.id
                         = command.connector_node_id

                    WHERE command.connector_node_id
                              = %s
                      AND node.credential_hash = %s
                      AND node.status IN (
                          'online',
                          'draining'
                      )
                      AND node.last_heartbeat_at >= (
                          CURRENT_TIMESTAMP
                          - (
                              %s
                              * INTERVAL '1 second'
                          )
                      )
                      AND (
                          (
                              command.status IN (
                                  'pending',
                                  'failed'
                              )
                              AND command.available_at
                                  <= CURRENT_TIMESTAMP
                          )
                          OR
                          (
                              command.status
                                  = 'claimed'
                              AND command.claim_expires_at
                                  < CURRENT_TIMESTAMP
                          )
                      )

                    ORDER BY
                        command.available_at,
                        command.id

                    FOR UPDATE OF command
                    SKIP LOCKED

                    LIMIT %s
                )

                UPDATE connector_commands command
                SET
                    status = 'claimed',
                    attempt_count
                        = command.attempt_count + 1,
                    claimed_at = CURRENT_TIMESTAMP,
                    claim_expires_at = (
                        CURRENT_TIMESTAMP
                        + (
                            %s
                            * INTERVAL '1 second'
                        )
                    ),
                    claim_token = %s,
                    updated_at = CURRENT_TIMESTAMP
                FROM candidates
                WHERE command.id = candidates.id
                RETURNING
                    command.id,
                    command.client_id,
                    command.channel_account_id,
                    command.connector_node_id,
                    command.command_type,
                    command.idempotency_key,
                    command.payload,
                    command.reply_job_id,
                    command.claim_expires_at,
                    command.attempt_count
                """,
                (
                    str(node_id),
                    credential_digest,
                    self.heartbeat_timeout_seconds,
                    limit,
                    lease_seconds,
                    str(claim_token),
                ),
            )

            rows = cursor.fetchall()

        return tuple(
            ClaimedConnectorCommand(
                id=int(row[0]),
                client_id=int(row[1]),
                channel_account_id=int(row[2]),
                connector_node_id=self._uuid(
                    row[3],
                    "connector_node_id",
                ),
                command_type=ConnectorCommandType(
                    row[4]
                ),
                idempotency_key=row[5],
                payload=self._mapping(row[6]),
                reply_job_id=(
                    int(row[7])
                    if row[7] is not None
                    else None
                ),
                claim_token=claim_token,
                claim_expires_at=row[8],
                attempt_count=int(row[9]),
            )
            for row in rows
        )

    def acknowledge_command(
        self,
        node_id,
        credential_digest,
        command_id,
        claim_token,
        outcome,
        external_message_id=None,
        last_error=None,
        retry_delay_seconds=30,
    ):
        node_id = self._uuid(
            node_id,
            "node_id",
        )

        claim_token = self._uuid(
            claim_token,
            "claim_token",
        )

        credential_digest = require_secret_digest(
            credential_digest,
            "credential_digest",
        )

        command_id = self._positive_integer(
            command_id,
            "command_id",
        )

        outcome = ConnectorCommandStatus(
            outcome
        )

        if outcome not in {
            ConnectorCommandStatus.SUCCEEDED,
            ConnectorCommandStatus.FAILED,
            ConnectorCommandStatus.UNKNOWN,
        }:
            raise ValueError(
                "acknowledgement outcome must be "
                "succeeded, failed, or unknown"
            )

        retry_delay_seconds = (
            self._positive_integer(
                retry_delay_seconds,
                "retry_delay_seconds",
            )
        )

        with self._transaction() as cursor:
            cursor.execute(
                """
                UPDATE connector_commands command
                SET
                    status = %s,

                    acknowledged_at = CASE
                        WHEN %s IN (
                            'succeeded',
                            'unknown'
                        )
                        THEN CURRENT_TIMESTAMP
                        ELSE NULL
                    END,

                    external_message_id = %s,
                    last_error = %s,

                    available_at = CASE
                        WHEN %s = 'failed'
                        THEN
                            CURRENT_TIMESTAMP
                            + (
                                %s
                                * INTERVAL '1 second'
                            )
                        ELSE command.available_at
                    END,

                    claim_expires_at = NULL,
                    claim_token = NULL,
                    updated_at = CURRENT_TIMESTAMP

                FROM
                    channel_connections connection,
                    connector_nodes node

                WHERE command.id = %s
                  AND command.connector_node_id = %s
                  AND command.status = 'claimed'
                  AND command.claim_token = %s
                  AND command.claim_expires_at
                      >= CURRENT_TIMESTAMP

                  AND connection.channel_account_id
                      = command.channel_account_id
                  AND connection.client_id
                      = command.client_id
                  AND connection.connector_node_id
                      = %s

                  AND node.id = %s
                  AND node.credential_hash = %s
                  AND node.status IN (
                      'online',
                      'draining'
                  )

                RETURNING command.id
                """,
                (
                    outcome.value,
                    outcome.value,
                    external_message_id,
                    last_error,
                    outcome.value,
                    retry_delay_seconds,
                    command_id,
                    str(node_id),
                    str(claim_token),
                    str(node_id),
                    str(node_id),
                    credential_digest,
                ),
            )

            row = cursor.fetchone()

            if row is None:
                raise RepositoryConflict(
                    "Command acknowledgement fence "
                    "rejected the request"
                )

        return command_id