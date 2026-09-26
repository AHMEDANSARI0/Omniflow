from dataclasses import dataclass
from typing import Dict

from control_plane import (
    ConnectorCommandStatus,
)

from .contracts import (
    CommandExecutionResult,
    ConnectorNodeConfig,
    ConnectorNodeTickResult,
    ManagedSessionAssignment,
)


class ConnectorNodeRuntimeError(
    RuntimeError
):
    pass


class ConnectorNodeNotStarted(
    ConnectorNodeRuntimeError
):
    pass


class NodeRuntimeFenceError(
    ConnectorNodeRuntimeError
):
    pass


@dataclass
class ActiveManagedSession:
    assignment: ManagedSessionAssignment
    handle: object


class ManagedConnectorNode:
    """
    Pure managed-node lifecycle coordinator.

    The gateway owns PostgreSQL transactions and
    authentication.

    The session controller owns browser/session
    processes.

    Constructing or starting this object does not
    launch a browser. Sessions start only during
    reconciliation after an explicit fenced
    assignment is returned by the gateway.
    """

    def __init__(
        self,
        config: ConnectorNodeConfig,
        gateway,
        session_controller,
        clock,
    ):
        if not isinstance(
            config,
            ConnectorNodeConfig,
        ):
            raise TypeError(
                "config must be "
                "ConnectorNodeConfig"
            )

        for dependency, name in (
            (
                gateway,
                "gateway",
            ),
            (
                session_controller,
                "session_controller",
            ),
            (
                clock,
                "clock",
            ),
        ):
            if dependency is None:
                raise TypeError(
                    f"{name} is required"
                )

        if not callable(clock):
            raise TypeError(
                "clock must be callable"
            )

        self.config = config
        self.gateway = gateway
        self.session_controller = (
            session_controller
        )
        self.clock = clock

        self._started = False
        self._draining = False

        self._sessions: Dict[
            int,
            ActiveManagedSession,
        ] = {}

        self._desired: Dict[
            int,
            ManagedSessionAssignment,
        ] = {}

        self._next_heartbeat_at = 0.0
        self._next_reconcile_at = 0.0
        self._next_command_at = 0.0

    @property
    def started(self):
        return self._started

    @property
    def draining(self):
        return self._draining

    @property
    def active_session_count(self):
        return len(
            self._sessions
        )

    @property
    def active_account_ids(self):
        return tuple(
            sorted(self._sessions)
        )

    def start(self):
        if self._started:
            return False

        now = float(
            self.clock()
        )

        self._started = True
        self._draining = False
        self._next_heartbeat_at = now
        self._next_reconcile_at = now
        self._next_command_at = now

        return True

    def begin_draining(self):
        if not self._started:
            raise ConnectorNodeNotStarted(
                "Cannot drain a node "
                "that is not started"
            )

        self._draining = True

    def _require_started(self):
        if not self._started:
            raise ConnectorNodeNotStarted(
                "Managed connector node "
                "has not been started"
            )

    def _load_desired_assignments(self):
        assignments = tuple(
            self.gateway.list_assignments(
                node_id=(
                    self.config.node_id
                ),
                credential_digest=(
                    self.config
                    .credential_digest
                ),
            )
        )

        desired = {}

        for assignment in assignments:
            if not isinstance(
                assignment,
                ManagedSessionAssignment,
            ):
                raise TypeError(
                    "gateway assignments must "
                    "be ManagedSessionAssignment"
                )

            if (
                assignment.connector_node_id
                != self.config.node_id
            ):
                raise NodeRuntimeFenceError(
                    "Gateway returned an "
                    "assignment for another node"
                )

            account_id = (
                assignment
                .channel_account_id
            )

            if account_id in desired:
                raise NodeRuntimeFenceError(
                    "Gateway returned duplicate "
                    "account assignments"
                )

            if (
                assignment.status.value
                == "revoked"
            ):
                continue

            desired[account_id] = (
                assignment
            )

        return desired

    def _stop_session(
        self,
        account_id,
        reason,
    ):
        active = self._sessions.pop(
            account_id,
            None,
        )

        if active is None:
            return False

        self.session_controller.stop_session(
            active.handle,
            reason=reason,
        )

        return True

    def _reconcile(self):
        desired = (
            self._load_desired_assignments()
        )

        stopped = 0
        started = 0

        for account_id in sorted(
            tuple(self._sessions)
        ):
            active = self._sessions[
                account_id
            ]

            replacement = desired.get(
                account_id
            )

            if replacement is None:
                stopped += int(
                    self._stop_session(
                        account_id,
                        reason=(
                            "assignment-removed"
                        ),
                    )
                )

                continue

            if (
                replacement
                .assignment_generation
                != active
                .assignment
                .assignment_generation
            ):
                stopped += int(
                    self._stop_session(
                        account_id,
                        reason=(
                            "assignment-generation-"
                            "changed"
                        ),
                    )
                )

        self._desired = desired

        if self._draining:
            return started, stopped

        candidates = sorted(
            desired.values(),
            key=lambda assignment: (
                assignment.client_id,
                assignment.channel_account_id,
            ),
        )

        for assignment in candidates:
            if (
                assignment.channel_account_id
                in self._sessions
            ):
                continue

            if (
                len(self._sessions)
                >= self.config.max_sessions
            ):
                break

            handle = (
                self
                .session_controller
                .start_session(
                    assignment
                )
            )

            if handle is None:
                continue

            self._sessions[
                assignment.channel_account_id
            ] = ActiveManagedSession(
                assignment=assignment,
                handle=handle,
            )

            started += 1

        return started, stopped

    def _capacity_counts(self):
        active = len(
            self._sessions
        )

        pending = len(
            [
                account_id
                for account_id
                in self._desired
                if account_id
                not in self._sessions
            ]
        )

        reserved = min(
            pending,
            max(
                0,
                (
                    self.config.max_sessions
                    - active
                ),
            ),
        )

        return active, reserved

    def _heartbeat(
        self,
        status=None,
    ):
        (
            active,
            reserved,
        ) = self._capacity_counts()

        self.gateway.heartbeat_node(
            node_id=self.config.node_id,
            credential_digest=(
                self.config
                .credential_digest
            ),
            active_sessions=active,
            reserved_sessions=reserved,
            status=(
                status
                or (
                    "draining"
                    if self._draining
                    else "online"
                )
            ),
        )

    def _execute_commands(self):
        commands = tuple(
            self.gateway.claim_commands(
                node_id=(
                    self.config.node_id
                ),
                credential_digest=(
                    self.config
                    .credential_digest
                ),
                limit=(
                    self.config
                    .command_batch_size
                ),
                lease_seconds=(
                    self.config
                    .command_lease_seconds
                ),
            )
        )

        acknowledged = 0

        for command in commands:
            active = self._sessions.get(
                command.channel_account_id
            )

            if active is None:
                result = (
                    CommandExecutionResult(
                        outcome=(
                            ConnectorCommandStatus
                            .FAILED
                        ),
                        error=(
                            "No active generation-"
                            "fenced session for "
                            "command account"
                        ),
                    )
                )

            else:
                try:
                    result = (
                        self
                        .session_controller
                        .execute_command(
                            active.handle,
                            command,
                        )
                    )

                    if not isinstance(
                        result,
                        CommandExecutionResult,
                    ):
                        raise TypeError(
                            "execute_command must "
                            "return "
                            "CommandExecutionResult"
                        )

                except Exception as error:
                    result = (
                        CommandExecutionResult(
                            outcome=(
                                ConnectorCommandStatus
                                .FAILED
                            ),
                            error=str(error),
                        )
                    )

            self.gateway.acknowledge_command(
                node_id=(
                    self.config.node_id
                ),
                credential_digest=(
                    self.config
                    .credential_digest
                ),
                command_id=command.id,
                claim_token=(
                    command.claim_token
                ),
                outcome=(
                    result.outcome.value
                ),
                external_message_id=(
                    result
                    .external_message_id
                ),
                last_error=result.error,
            )

            acknowledged += 1

        return (
            len(commands),
            acknowledged,
        )

    def tick(self):
        self._require_started()

        now = float(
            self.clock()
        )

        sessions_started = 0
        sessions_stopped = 0
        commands_claimed = 0
        commands_acknowledged = 0

        if now >= self._next_reconcile_at:
            (
                sessions_started,
                sessions_stopped,
            ) = self._reconcile()

            self._next_reconcile_at = (
                now
                + self.config
                .reconcile_interval_seconds
            )

        if now >= self._next_heartbeat_at:
            self._heartbeat()

            self._next_heartbeat_at = (
                now
                + self.config
                .heartbeat_interval_seconds
            )

        if now >= self._next_command_at:
            (
                commands_claimed,
                commands_acknowledged,
            ) = self._execute_commands()

            self._next_command_at = (
                now
                + self.config
                .command_interval_seconds
            )

        (
            active,
            reserved,
        ) = self._capacity_counts()

        return ConnectorNodeTickResult(
            assignments_seen=len(
                self._desired
            ),
            sessions_started=(
                sessions_started
            ),
            sessions_stopped=(
                sessions_stopped
            ),
            active_sessions=active,
            reserved_sessions=reserved,
            commands_claimed=(
                commands_claimed
            ),
            commands_acknowledged=(
                commands_acknowledged
            ),
        )

    def shutdown(self):
        if not self._started:
            return False

        self._draining = True

        for account_id in sorted(
            tuple(self._sessions)
        ):
            self._stop_session(
                account_id,
                reason="node-shutdown",
            )

        self._desired = {}

        self._heartbeat(
            status="offline"
        )

        self._started = False

        return True