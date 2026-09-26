import hashlib
import json
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional
from uuid import UUID, uuid4

from .passwords import hash_password, validate_password


API_VERSION = "v1"


class OnboardingError(RuntimeError):
    pass


class OnboardingConflict(OnboardingError):
    pass


def required_text(value, field_name, maximum=None):
    normalized = str(value or "").strip()

    if not normalized:
        raise ValueError(f"{field_name} is required")

    if maximum is not None and len(normalized) > maximum:
        raise ValueError(
            f"{field_name} cannot exceed {maximum} characters"
        )

    return normalized


def positive_integer(value, field_name, maximum=None):
    try:
        normalized = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"{field_name} must be an integer"
        ) from error

    if normalized <= 0:
        raise ValueError(f"{field_name} must be positive")

    if maximum is not None and normalized > maximum:
        raise ValueError(
            f"{field_name} cannot exceed {maximum}"
        )

    return normalized


@dataclass(frozen=True)
class TrialLimits:
    days: int = 7
    max_channel_accounts: int = 1
    max_managed_sessions: int = 1
    max_inbound_messages: int = 500
    max_ai_calls: int = 500
    max_outbound_messages: int = 500

    def __post_init__(self):
        object.__setattr__(
            self,
            "days",
            positive_integer(self.days, "trial days", 30),
        )

        for name in (
            "max_channel_accounts",
            "max_managed_sessions",
            "max_inbound_messages",
            "max_ai_calls",
            "max_outbound_messages",
        ):
            value = positive_integer(
                getattr(self, name),
                name,
                1_000_000,
            )
            object.__setattr__(self, name, value)


@dataclass(frozen=True)
class ClientOnboardingRequest:
    idempotency_key: str
    business_name: str
    owner_name: str
    owner_email: str
    password: str = field(repr=False)
    channel_name: str = "WhatsApp"
    platform: str = "whatsapp"
    owner_phone: Optional[str] = None
    agent_name: str = "Primary AI Agent"
    agent_instruction: str = (
        "Help customers accurately and concisely. "
        "Use configured business information and hand off when needed."
    )
    business_profile: Mapping[str, Any] = field(default_factory=dict)
    language_policy: Mapping[str, Any] = field(default_factory=dict)
    tone_policy: Mapping[str, Any] = field(default_factory=dict)
    knowledge_config: Mapping[str, Any] = field(default_factory=dict)
    qualification_config: Mapping[str, Any] = field(default_factory=dict)
    workflow_config: Mapping[str, Any] = field(default_factory=dict)
    fallback_config: Mapping[str, Any] = field(default_factory=dict)
    handoff_config: Mapping[str, Any] = field(default_factory=dict)
    tool_config: Mapping[str, Any] = field(default_factory=dict)
    trial: TrialLimits = field(default_factory=TrialLimits)
    request_id: UUID = field(default_factory=uuid4)

    def __post_init__(self):
        if not isinstance(self.request_id, UUID):
            raise TypeError("request_id must be a UUID")

        for name, maximum in (
            ("idempotency_key", 255),
            ("business_name", 255),
            ("owner_name", 255),
            ("channel_name", 255),
            ("agent_name", 255),
        ):
            object.__setattr__(
                self,
                name,
                required_text(
                    getattr(self, name),
                    name,
                    maximum,
                ),
            )

        email = required_text(
            self.owner_email,
            "owner_email",
            320,
        ).lower()

        if (
            "@" not in email
            or email.startswith("@")
            or email.endswith("@")
        ):
            raise ValueError("owner_email is invalid")

        object.__setattr__(self, "owner_email", email)
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
            "agent_instruction",
            required_text(
                self.agent_instruction,
                "agent_instruction",
                50_000,
            ),
        )

        if self.owner_phone is not None:
            object.__setattr__(
                self,
                "owner_phone",
                required_text(
                    self.owner_phone,
                    "owner_phone",
                    50,
                ),
            )

        validate_password(self.password)

        if not isinstance(self.trial, TrialLimits):
            raise TypeError("trial must be TrialLimits")

        for name in (
            "business_profile",
            "language_policy",
            "tone_policy",
            "knowledge_config",
            "qualification_config",
            "workflow_config",
            "fallback_config",
            "handoff_config",
            "tool_config",
        ):
            if not isinstance(getattr(self, name), Mapping):
                raise ValueError(
                    f"{name} must be a mapping"
                )

    @property
    def fingerprint(self):
        payload = {
            "api_version": API_VERSION,
            "business_name": self.business_name,
            "owner_name": self.owner_name,
            "owner_email": self.owner_email,
            "owner_phone": self.owner_phone,
            "channel_name": self.channel_name,
            "platform": self.platform,
            "agent_name": self.agent_name,
            "agent_instruction": self.agent_instruction,
            "business_profile": dict(self.business_profile),
            "language_policy": dict(self.language_policy),
            "tone_policy": dict(self.tone_policy),
            "knowledge_config": dict(self.knowledge_config),
            "qualification_config": dict(
                self.qualification_config
            ),
            "workflow_config": dict(self.workflow_config),
            "fallback_config": dict(self.fallback_config),
            "handoff_config": dict(self.handoff_config),
            "tool_config": dict(self.tool_config),
            "trial": self.trial.__dict__,
        }

        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ClientOnboardingResult:
    request_id: UUID
    client_id: int
    owner_user_id: int
    channel_account_id: int
    agent_id: UUID
    agent_version_id: int
    connection_status: str = "waiting_for_node"
    idempotent_replay: bool = False


class ClientOnboardingService:
    def __init__(
        self,
        connection_factory,
        password_hasher=hash_password,
        clock=None,
    ):
        if not callable(connection_factory):
            raise TypeError(
                "connection_factory must be callable"
            )

        if not callable(password_hasher):
            raise TypeError(
                "password_hasher must be callable"
            )

        self._connection_factory = connection_factory
        self._password_hasher = password_hasher
        self._clock = clock or (
            lambda: datetime.now(timezone.utc)
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
    def _json(value):
        return json.dumps(
            dict(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _existing_result(row, request):
        if row[1] != request.fingerprint:
            raise OnboardingConflict(
                "idempotency key was reused with "
                "different onboarding data"
            )

        if row[0] != "completed":
            raise OnboardingConflict(
                "onboarding request is already processing "
                "or failed"
            )

        return ClientOnboardingResult(
            request_id=UUID(str(row[2])),
            client_id=int(row[3]),
            owner_user_id=int(row[4]),
            channel_account_id=int(row[5]),
            agent_id=UUID(str(row[6])),
            agent_version_id=int(row[7]),
            idempotent_replay=True,
        )

    def onboard(self, request):
        if not isinstance(
            request,
            ClientOnboardingRequest,
        ):
            raise TypeError(
                "request must be ClientOnboardingRequest"
            )

        password_digest = self._password_hasher(
            request.password
        )
        now = self._clock()

        if now.tzinfo is None:
            raise ValueError(
                "clock must return timezone-aware datetime"
            )

        expires_at = now + timedelta(
            days=request.trial.days
        )
        pending_external_id = (
            f"pending:{request.request_id}"
        )
        agent_id = uuid4()

        with self._transaction() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (
                    "onboarding:"
                    + request.idempotency_key,
                ),
            )

            cursor.execute(
                """
                SELECT
                    request.status,
                    request.request_fingerprint,
                    request.id,
                    request.client_id,
                    request.owner_user_id,
                    request.channel_account_id,
                    request.agent_id,
                    assignment.agent_version_id
                FROM onboarding_requests request
                LEFT JOIN channel_agent_assignments assignment
                  ON assignment.channel_account_id
                     = request.channel_account_id
                 AND assignment.status = 'active'
                WHERE request.idempotency_key = %s
                """,
                (request.idempotency_key,),
            )

            existing = cursor.fetchone()

            if existing is not None:
                return self._existing_result(
                    existing,
                    request,
                )

            cursor.execute(
                """
                INSERT INTO onboarding_requests (
                    id,
                    api_version,
                    idempotency_key,
                    request_fingerprint,
                    status
                )
                VALUES (%s, %s, %s, %s, 'processing')
                """,
                (
                    str(request.request_id),
                    API_VERSION,
                    request.idempotency_key,
                    request.fingerprint,
                ),
            )

            cursor.execute(
                """
                INSERT INTO clients (
                    business_name,
                    owner_name,
                    email,
                    phone_number,
                    status,
                    updated_at
                )
                VALUES (
                    %s, %s, %s, %s,
                    'active', CURRENT_TIMESTAMP
                )
                RETURNING id
                """,
                (
                    request.business_name,
                    request.owner_name,
                    request.owner_email,
                    request.owner_phone,
                ),
            )

            client_id = int(cursor.fetchone()[0])

            cursor.execute(
                """
                INSERT INTO platform_users (
                    email,
                    display_name,
                    status,
                    metadata
                )
                VALUES (
                    %s, %s, 'active', %s::jsonb
                )
                RETURNING id
                """,
                (
                    request.owner_email,
                    request.owner_name,
                    self._json({
                        "source": "onboarding_v1",
                    }),
                ),
            )

            owner_user_id = int(
                cursor.fetchone()[0]
            )

            cursor.execute(
                """
                INSERT INTO user_password_credentials (
                    user_id,
                    password_hash
                )
                VALUES (%s, %s)
                """,
                (
                    owner_user_id,
                    password_digest,
                ),
            )

            cursor.execute(
                """
                INSERT INTO client_memberships (
                    client_id,
                    user_id,
                    role,
                    status
                )
                VALUES (
                    %s, %s, 'owner', 'active'
                )
                """,
                (
                    client_id,
                    owner_user_id,
                ),
            )

            cursor.execute(
                """
                INSERT INTO channel_accounts (
                    client_id,
                    external_account_id,
                    account_name,
                    status,
                    platform,
                    metadata,
                    connection_mode,
                    updated_at
                )
                VALUES (
                    %s, %s, %s, 'pending', %s,
                    %s::jsonb, 'managed_web',
                    CURRENT_TIMESTAMP
                )
                RETURNING id
                """,
                (
                    client_id,
                    pending_external_id,
                    request.channel_name,
                    request.platform,
                    self._json({
                        "onboarding_request_id": str(
                            request.request_id
                        ),
                        "trial": True,
                    }),
                ),
            )

            channel_account_id = int(
                cursor.fetchone()[0]
            )

            cursor.execute(
                """
                INSERT INTO channel_connections (
                    channel_account_id,
                    client_id,
                    connection_mode,
                    status,
                    assignment_generation,
                    metadata
                )
                VALUES (
                    %s, %s, 'managed_web',
                    'waiting_for_node', 0,
                    %s::jsonb
                )
                """,
                (
                    channel_account_id,
                    client_id,
                    self._json({
                        "preferred_region": "pk-khi",
                        "pairing_methods": [
                            "phone_code",
                            "qr",
                        ],
                    }),
                ),
            )

            cursor.execute(
                """
                INSERT INTO ai_agents (
                    id,
                    client_id,
                    agent_key,
                    display_name,
                    status,
                    metadata
                )
                VALUES (
                    %s, %s, 'primary', %s,
                    'active', %s::jsonb
                )
                """,
                (
                    str(agent_id),
                    client_id,
                    request.agent_name,
                    self._json({
                        "source": "onboarding_v1",
                    }),
                ),
            )

            cursor.execute(
                """
                INSERT INTO ai_agent_versions (
                    agent_id,
                    client_id,
                    version_number,
                    status,
                    system_instruction,
                    business_profile,
                    language_policy,
                    tone_policy,
                    knowledge_config,
                    qualification_config,
                    workflow_config,
                    fallback_config,
                    handoff_config,
                    tool_config,
                    created_by_user_id
                )
                VALUES (
                    %s, %s, 1, 'active', %s,
                    %s::jsonb, %s::jsonb,
                    %s::jsonb, %s::jsonb,
                    %s::jsonb, %s::jsonb,
                    %s::jsonb, %s::jsonb,
                    %s::jsonb, %s
                )
                RETURNING id
                """,
                (
                    str(agent_id),
                    client_id,
                    request.agent_instruction,
                    self._json(
                        request.business_profile
                    ),
                    self._json(
                        request.language_policy
                    ),
                    self._json(
                        request.tone_policy
                    ),
                    self._json(
                        request.knowledge_config
                    ),
                    self._json(
                        request.qualification_config
                    ),
                    self._json(
                        request.workflow_config
                    ),
                    self._json(
                        request.fallback_config
                    ),
                    self._json(
                        request.handoff_config
                    ),
                    self._json(
                        request.tool_config
                    ),
                    owner_user_id,
                ),
            )

            agent_version_id = int(
                cursor.fetchone()[0]
            )

            cursor.execute(
                """
                INSERT INTO channel_agent_assignments (
                    channel_account_id,
                    client_id,
                    agent_id,
                    agent_version_id,
                    status,
                    assigned_by_user_id
                )
                VALUES (
                    %s, %s, %s, %s,
                    'active', %s
                )
                """,
                (
                    channel_account_id,
                    client_id,
                    str(agent_id),
                    agent_version_id,
                    owner_user_id,
                ),
            )

            cursor.execute(
                """
                INSERT INTO client_trial_entitlements (
                    client_id,
                    status,
                    starts_at,
                    expires_at,
                    max_channel_accounts,
                    max_managed_sessions,
                    max_inbound_messages,
                    max_ai_calls,
                    max_outbound_messages,
                    metadata
                )
                VALUES (
                    %s, 'trial', %s, %s,
                    %s, %s, %s, %s, %s,
                    %s::jsonb
                )
                """,
                (
                    client_id,
                    now,
                    expires_at,
                    request.trial.max_channel_accounts,
                    request.trial.max_managed_sessions,
                    request.trial.max_inbound_messages,
                    request.trial.max_ai_calls,
                    request.trial.max_outbound_messages,
                    self._json({
                        "source": "onboarding_v1",
                    }),
                ),
            )

            cursor.execute(
                """
                INSERT INTO client_usage_counters (
                    client_id,
                    period_start,
                    period_end
                )
                VALUES (%s, %s, %s)
                """,
                (
                    client_id,
                    now,
                    expires_at,
                ),
            )

            cursor.execute(
                """
                UPDATE onboarding_requests
                SET
                    status = 'completed',
                    client_id = %s,
                    owner_user_id = %s,
                    channel_account_id = %s,
                    agent_id = %s,
                    completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                  AND status = 'processing'
                """,
                (
                    client_id,
                    owner_user_id,
                    channel_account_id,
                    str(agent_id),
                    str(request.request_id),
                ),
            )

            if cursor.rowcount != 1:
                raise OnboardingConflict(
                    "onboarding completion fence failed"
                )

            cursor.execute(
                """
                INSERT INTO control_plane_audit_log (
                    client_id,
                    actor_user_id,
                    action,
                    resource_type,
                    resource_id,
                    before_state,
                    after_state,
                    metadata
                )
                VALUES (
                    %s, %s, 'client.onboarded',
                    'channel_account', %s,
                    NULL, %s::jsonb, %s::jsonb
                )
                """,
                (
                    client_id,
                    owner_user_id,
                    str(channel_account_id),
                    self._json({
                        "connection_mode":
                            "managed_web",
                        "connection_status":
                            "waiting_for_node",
                        "agent_version": 1,
                        "trial_expires_at":
                            expires_at.isoformat(),
                    }),
                    self._json({
                        "api_version": API_VERSION,
                        "onboarding_request_id": str(
                            request.request_id
                        ),
                    }),
                ),
            )

        return ClientOnboardingResult(
            request_id=request.request_id,
            client_id=client_id,
            owner_user_id=owner_user_id,
            channel_account_id=channel_account_id,
            agent_id=agent_id,
            agent_version_id=agent_version_id,
        )
