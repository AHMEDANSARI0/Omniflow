import json
from contextlib import contextmanager
from typing import Mapping
from uuid import UUID

from control_plane import (
    ControlPlaneRepository,
    NodeAuthenticationFailed,
    require_secret_digest,
)

from .contracts import (
    ManagedSessionAssignment,
)


class ConnectorGatewayError(RuntimeError):
    pass


class PostgresConnectorGateway:
    """
    PostgreSQL boundary used by one
    authenticated connector node.
    """

    def __init__(
        self,
        connection_factory,
        heartbeat_timeout_seconds=90,
        repository=None,
    ):
        if not callable(
            connection_factory
        ):
            raise TypeError(
                "connection_factory "
                "must be callable"
            )

        timeout = int(
            heartbeat_timeout_seconds
        )

        if timeout <= 0:
            raise ValueError(
                "heartbeat_timeout_seconds "
                "must be positive"
            )

        self._connection_factory = (
            connection_factory
        )

        self.heartbeat_timeout_seconds = (
            timeout
        )

        self._repository = (
            repository
            if repository is not None
            else ControlPlaneRepository(
                connection_factory,
                heartbeat_timeout_seconds=(
                    timeout
                ),
            )
        )

    @contextmanager
    def _transaction(self):
        connection = (
            self._connection_factory()
        )

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
    def _uuid(
        value,
        field_name,
    ):
        if isinstance(
            value,
            UUID,
        ):
            return value

        try:
            return UUID(
                str(value)
            )

        except (
            TypeError,
            ValueError,
        ) as error:
            raise ValueError(
                f"{field_name} "
                "must be a UUID"
            ) from error

    @staticmethod
    def _mapping(value):
        if value is None:
            return {}

        if isinstance(
            value,
            Mapping,
        ):
            return dict(value)

        if isinstance(
            value,
            str,
        ):
            parsed = json.loads(
                value
            )

            if isinstance(
                parsed,
                Mapping,
            ):
                return dict(parsed)

        raise ValueError(
            "database metadata must "
            "be a JSON object"
        )

    def list_assignments(
        self,
        node_id,
        credential_digest,
    ):
        node_id = self._uuid(
            node_id,
            "node_id",
        )

        credential_digest = (
            require_secret_digest(
                credential_digest,
                "credential_digest",
            )
        )

        with self._transaction() as cursor:
            # Authentication is a plain SELECT.
            # Do not use FOR SHARE here because
            # readiness checks use a read-only
            # PostgreSQL transaction.
            cursor.execute(
                """
                SELECT status
                FROM connector_nodes
                WHERE id = %s
                  AND credential_hash = %s
                  AND status <> 'disabled'
                """,
                (
                    str(node_id),
                    credential_digest,
                ),
            )

            authenticated = (
                cursor.fetchone()
            )

            if authenticated is None:
                raise NodeAuthenticationFailed(
                    "Node authentication or "
                    "state check failed"
                )

            cursor.execute(
                """
                SELECT
                    connection.channel_account_id,
                    connection.client_id,
                    connection.connector_node_id,
                    connection.assignment_generation,
                    account.platform,
                    connection.status,
                    connection.session_locator,
                    connection.metadata

                FROM channel_connections connection

                JOIN channel_accounts account
                  ON account.id
                     = connection.channel_account_id
                 AND account.client_id
                     = connection.client_id

                WHERE
                    connection.connector_node_id = %s
                  AND connection.connection_mode
                      = 'managed_web'

                ORDER BY
                    connection.client_id,
                    connection.channel_account_id
                """,
                (
                    str(node_id),
                ),
            )

            rows = cursor.fetchall()

        return tuple(
            ManagedSessionAssignment(
                channel_account_id=row[0],
                client_id=row[1],
                connector_node_id=(
                    self._uuid(
                        row[2],
                        "connector_node_id",
                    )
                ),
                assignment_generation=row[3],
                platform=row[4],
                status=row[5],
                session_locator=row[6],
                metadata=self._mapping(
                    row[7]
                ),
            )
            for row in rows
        )

    def heartbeat_node(
        self,
        node_id,
        credential_digest,
        active_sessions,
        reserved_sessions,
        status="online",
    ):
        node_id = self._uuid(
            node_id,
            "node_id",
        )

        credential_digest = (
            require_secret_digest(
                credential_digest,
                "credential_digest",
            )
        )

        active_sessions = int(
            active_sessions
        )

        reserved_sessions = int(
            reserved_sessions
        )

        status = str(
            status or ""
        ).strip().lower()

        if (
            active_sessions < 0
            or reserved_sessions < 0
        ):
            raise ValueError(
                "session counts cannot "
                "be negative"
            )

        if status not in {
            "registering",
            "online",
            "draining",
            "offline",
            "error",
        }:
            raise ValueError(
                "invalid heartbeat "
                "node status"
            )

        with self._transaction() as cursor:
            cursor.execute(
                """
                UPDATE connector_nodes
                SET
                    status = %s,
                    active_sessions = %s,
                    reserved_sessions = %s,
                    last_heartbeat_at
                        = CURRENT_TIMESTAMP,
                    updated_at
                        = CURRENT_TIMESTAMP

                WHERE id = %s
                  AND credential_hash = %s
                  AND status <> 'disabled'
                  AND %s + %s
                      <= max_sessions

                RETURNING
                    max_sessions,
                    active_sessions,
                    reserved_sessions,
                    status
                """,
                (
                    status,
                    active_sessions,
                    reserved_sessions,
                    str(node_id),
                    credential_digest,
                    active_sessions,
                    reserved_sessions,
                ),
            )

            row = cursor.fetchone()

            if row is None:
                raise NodeAuthenticationFailed(
                    "Node authentication, state, "
                    "or capacity check failed"
                )

            return {
                "max_sessions": int(
                    row[0]
                ),
                "active_sessions": int(
                    row[1]
                ),
                "reserved_sessions": int(
                    row[2]
                ),
                "status": row[3],
            }

    def claim_commands(
        self,
        node_id,
        credential_digest,
        limit=20,
        lease_seconds=60,
    ):
        return (
            self._repository
            .claim_commands(
                node_id=node_id,
                credential_digest=(
                    credential_digest
                ),
                limit=limit,
                lease_seconds=(
                    lease_seconds
                ),
            )
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
    ):
        return (
            self._repository
            .acknowledge_command(
                node_id=node_id,
                credential_digest=(
                    credential_digest
                ),
                command_id=command_id,
                claim_token=claim_token,
                outcome=outcome,
                external_message_id=(
                    external_message_id
                ),
                last_error=last_error,
            )
        )