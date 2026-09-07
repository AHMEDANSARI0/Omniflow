import hashlib
import json
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional
from uuid import UUID, uuid4

from .passwords import hash_password, verify_password


ACCESS_TOKEN_TTL = timedelta(minutes=15)
REFRESH_TOKEN_TTL = timedelta(days=30)
MAX_FAILED_ATTEMPTS = 5
LOCK_DURATION = timedelta(minutes=15)


class AuthenticationError(RuntimeError):
    pass


class InvalidCredentials(AuthenticationError):
    pass


class AccountLocked(AuthenticationError):
    pass


class MembershipSelectionRequired(AuthenticationError):
    pass


class InvalidAccessToken(AuthenticationError):
    pass


class InvalidRefreshToken(AuthenticationError):
    pass


class RefreshTokenReplayDetected(InvalidRefreshToken):
    pass


def _required_text(value, field_name, maximum):
    normalized = str(value or "").strip()

    if not normalized:
        raise ValueError(f"{field_name} is required")

    if len(normalized) > maximum:
        raise ValueError(
            f"{field_name} cannot exceed {maximum} characters"
        )

    return normalized


@dataclass(frozen=True)
class LoginRequest:
    email: str
    password: str = field(repr=False)
    client_id: Optional[int] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        email = _required_text(
            self.email,
            "email",
            320,
        ).lower()

        if "@" not in email or email.startswith("@") or email.endswith("@"):
            raise ValueError("email is invalid")

        if not isinstance(self.password, str) or not self.password:
            raise ValueError("password is required")

        if len(self.password) > 1024:
            raise ValueError("password is too long")

        normalized_client_id = self.client_id

        if normalized_client_id is not None:
            try:
                normalized_client_id = int(normalized_client_id)
            except (TypeError, ValueError) as error:
                raise ValueError("client_id must be an integer") from error

            if normalized_client_id <= 0:
                raise ValueError("client_id must be positive")

        if not isinstance(self.metadata, Mapping):
            raise ValueError("metadata must be a mapping")

        object.__setattr__(self, "email", email)
        object.__setattr__(self, "client_id", normalized_client_id)


@dataclass(frozen=True)
class LoginResult:
    session_id: UUID
    user_id: int
    client_id: int
    role: str
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    access_expires_at: datetime
    refresh_expires_at: datetime


@dataclass(frozen=True)
class RefreshRequest:
    refresh_token: str = field(repr=False)
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not isinstance(self.refresh_token, str):
            raise ValueError("refresh_token is required")

        token = self.refresh_token.strip()

        if not token:
            raise ValueError("refresh_token is required")

        if len(token) > 4096:
            raise ValueError("refresh_token is too long")

        if not isinstance(self.metadata, Mapping):
            raise ValueError("metadata must be a mapping")

        object.__setattr__(self, "refresh_token", token)


@dataclass(frozen=True)
class RefreshResult:
    session_id: UUID
    user_id: int
    client_id: int
    role: str
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    access_expires_at: datetime
    refresh_expires_at: datetime


@dataclass(frozen=True)
class LogoutRequest:
    access_token: str = field(repr=False)
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not isinstance(self.access_token, str):
            raise ValueError("access token is required")

        token = self.access_token.strip()

        if not token:
            raise ValueError("access token is required")

        if len(token) > 4096:
            raise ValueError("access token is too long")

        if not isinstance(self.metadata, Mapping):
            raise ValueError("metadata must be a mapping")

        object.__setattr__(self, "access_token", token)


@dataclass(frozen=True)
class LogoutResult:
    session_id: UUID
    user_id: int
    client_id: int
    revoked: bool


@dataclass(frozen=True)
class AuthenticatedPrincipal:
    session_id: UUID
    user_id: int
    client_id: int
    role: str
    email: str
    display_name: Optional[str]
    access_expires_at: datetime


class PlatformAuthenticationService:
    def __init__(
        self,
        connection_factory,
        password_verifier=verify_password,
        clock=None,
        access_token_factory=None,
        refresh_token_factory=None,
        dummy_password_hash=None,
    ):
        if not callable(connection_factory):
            raise TypeError("connection_factory must be callable")

        if not callable(password_verifier):
            raise TypeError("password_verifier must be callable")

        self._connection_factory = connection_factory
        self._password_verifier = password_verifier
        self._clock = clock or (
            lambda: datetime.now(timezone.utc)
        )
        self._access_token_factory = access_token_factory or (
            lambda: "ofa_" + secrets.token_urlsafe(32)
        )
        self._refresh_token_factory = refresh_token_factory or (
            lambda: "ofr_" + secrets.token_urlsafe(48)
        )
        self._dummy_password_hash = (
            dummy_password_hash
            or hash_password("OmniFlow-Dummy-Password-123!")
        )

    @staticmethod
    def token_hash(token):
        return hashlib.sha256(
            str(token or "").encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _json(value):
        return json.dumps(
            dict(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def _now(self):
        now = self._clock()

        if not isinstance(now, datetime) or now.tzinfo is None:
            raise ValueError(
                "clock must return a timezone-aware datetime"
            )

        return now

    @staticmethod
    def _selected_membership(rows, requested_client_id):
        active = [
            row
            for row in rows
            if row[3] == "active"
        ]

        if requested_client_id is not None:
            matches = [
                row
                for row in active
                if int(row[1]) == requested_client_id
            ]

            if len(matches) != 1:
                raise InvalidCredentials(
                    "invalid email, password, or client selection"
                )

            return matches[0]

        if len(active) == 1:
            return active[0]

        if not active:
            raise InvalidCredentials(
                "no active client membership is available"
            )

        raise MembershipSelectionRequired(
            "client_id is required for a user with multiple memberships"
        )

    def login(self, request):
        if not isinstance(request, LoginRequest):
            raise TypeError("request must be LoginRequest")

        now = self._now()
        connection = self._connection_factory()
        finalized = False

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        user_account.id,
                        user_account.email,
                        user_account.display_name,
                        user_account.status,
                        credential.password_hash,
                        credential.failed_attempt_count,
                        credential.locked_until
                    FROM platform_users user_account
                    JOIN user_password_credentials credential
                      ON credential.user_id = user_account.id
                    WHERE user_account.email = %s
                    FOR UPDATE OF user_account, credential
                    """,
                    (request.email,),
                )
                user_row = cursor.fetchone()

                if user_row is None:
                    self._password_verifier(
                        request.password,
                        self._dummy_password_hash,
                    )
                    connection.rollback()
                    finalized = True
                    raise InvalidCredentials(
                        "invalid email, password, or client selection"
                    )

                user_id = int(user_row[0])
                user_status = str(user_row[3])
                password_hash = user_row[4]
                failed_attempts = int(user_row[5])
                locked_until = user_row[6]

                if user_status != "active":
                    connection.rollback()
                    finalized = True
                    raise InvalidCredentials(
                        "invalid email, password, or client selection"
                    )

                if locked_until is not None and locked_until > now:
                    connection.rollback()
                    finalized = True
                    raise AccountLocked(
                        "account is temporarily locked"
                    )

                valid_password = self._password_verifier(
                    request.password,
                    password_hash,
                )

                if not valid_password:
                    new_attempts = failed_attempts + 1
                    new_locked_until = (
                        now + LOCK_DURATION
                        if new_attempts >= MAX_FAILED_ATTEMPTS
                        else None
                    )
                    cursor.execute(
                        """
                        UPDATE user_password_credentials
                        SET
                            failed_attempt_count = %s,
                            locked_until = %s,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE user_id = %s
                        """,
                        (
                            new_attempts,
                            new_locked_until,
                            user_id,
                        ),
                    )
                    connection.commit()
                    finalized = True
                    raise InvalidCredentials(
                        "invalid email, password, or client selection"
                    )

                cursor.execute(
                    """
                    SELECT
                        id,
                        client_id,
                        role,
                        status
                    FROM client_memberships
                    WHERE user_id = %s
                    ORDER BY client_id, id
                    """,
                    (user_id,),
                )
                membership = self._selected_membership(
                    cursor.fetchall(),
                    request.client_id,
                )
                client_id = int(membership[1])
                role = str(membership[2])
                session_id = uuid4()
                access_token = self._access_token_factory()
                refresh_token = self._refresh_token_factory()

                if not access_token or not refresh_token:
                    raise AuthenticationError(
                        "token factory returned an empty token"
                    )

                access_expires_at = now + ACCESS_TOKEN_TTL
                refresh_expires_at = now + REFRESH_TOKEN_TTL
                cursor.execute(
                    """
                    UPDATE user_password_credentials
                    SET
                        failed_attempt_count = 0,
                        locked_until = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = %s
                    """,
                    (user_id,),
                )
                cursor.execute(
                    """
                    UPDATE platform_users
                    SET
                        last_login_at = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    """,
                    (now, user_id),
                )
                cursor.execute(
                    """
                    INSERT INTO platform_user_sessions (
                        id,
                        user_id,
                        client_id,
                        access_token_hash,
                        refresh_token_hash,
                        status,
                        auth_method,
                        issued_at,
                        access_expires_at,
                        refresh_expires_at,
                        last_seen_at,
                        metadata
                    )
                    VALUES (
                        %s, %s, %s, %s, %s,
                        'active', 'password', %s, %s, %s, %s,
                        %s::jsonb
                    )
                    """,
                    (
                        str(session_id),
                        user_id,
                        client_id,
                        self.token_hash(access_token),
                        self.token_hash(refresh_token),
                        now,
                        access_expires_at,
                        refresh_expires_at,
                        now,
                        self._json(request.metadata),
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO control_plane_audit_log (
                        client_id,
                        actor_user_id,
                        action,
                        resource_type,
                        resource_id,
                        after_state,
                        metadata
                    )
                    VALUES (
                        %s, %s, 'user.logged_in',
                        'platform_user_session', %s,
                        %s::jsonb, %s::jsonb
                    )
                    """,
                    (
                        client_id,
                        user_id,
                        str(session_id),
                        self._json({
                            "role": role,
                            "access_expires_at": (
                                access_expires_at.isoformat()
                            ),
                        }),
                        self._json({
                            "auth_method": "password",
                        }),
                    ),
                )

            connection.commit()
            finalized = True
            return LoginResult(
                session_id=session_id,
                user_id=user_id,
                client_id=client_id,
                role=role,
                access_token=access_token,
                refresh_token=refresh_token,
                access_expires_at=access_expires_at,
                refresh_expires_at=refresh_expires_at,
            )

        except Exception:
            if not finalized:
                connection.rollback()
            raise

        finally:
            connection.close()

    def refresh(self, request):
        if not isinstance(request, RefreshRequest):
            raise TypeError("request must be RefreshRequest")

        now = self._now()
        presented_hash = self.token_hash(request.refresh_token)
        connection = self._connection_factory()
        finalized = False

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        session.id,
                        session.user_id,
                        session.client_id,
                        session.status,
                        session.access_token_hash,
                        session.refresh_expires_at,
                        user_account.status,
                        membership.role,
                        membership.status
                    FROM platform_user_sessions session
                    JOIN platform_users user_account
                      ON user_account.id = session.user_id
                    JOIN client_memberships membership
                      ON membership.user_id = session.user_id
                     AND membership.client_id = session.client_id
                    WHERE session.refresh_token_hash = %s
                    FOR UPDATE OF session
                    """,
                    (presented_hash,),
                )
                row = cursor.fetchone()

                if row is None:
                    cursor.execute(
                        """
                        SELECT
                            history.session_id,
                            history.user_id,
                            history.client_id,
                            history.expires_at,
                            session.status
                        FROM platform_refresh_token_history history
                        JOIN platform_user_sessions session
                          ON session.id = history.session_id
                         AND session.user_id = history.user_id
                         AND session.client_id = history.client_id
                        WHERE history.token_hash = %s
                        FOR UPDATE OF session
                        """,
                        (presented_hash,),
                    )
                    replay = cursor.fetchone()

                    if replay is None:
                        connection.rollback()
                        finalized = True
                        raise InvalidRefreshToken(
                            "refresh token is invalid"
                        )

                    session_id = str(replay[0])
                    user_id = int(replay[1])
                    client_id = int(replay[2])

                    if replay[4] == "active":
                        cursor.execute(
                            """
                            UPDATE platform_user_sessions
                            SET
                                status = 'revoked',
                                revoked_at = %s,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = %s
                              AND status = 'active'
                            """,
                            (now, session_id),
                        )
                        cursor.execute(
                            """
                            INSERT INTO control_plane_audit_log (
                                client_id,
                                actor_user_id,
                                action,
                                resource_type,
                                resource_id,
                                after_state,
                                metadata
                            )
                            VALUES (
                                %s, %s,
                                'user.session_refresh_replay_detected',
                                'platform_user_session', %s,
                                %s::jsonb, %s::jsonb
                            )
                            """,
                            (
                                client_id,
                                user_id,
                                session_id,
                                self._json({
                                    "status": "revoked",
                                    "revoked_at": now.isoformat(),
                                }),
                                self._json({
                                    "reason": "refresh_token_replay",
                                }),
                            ),
                        )
                        connection.commit()
                    else:
                        connection.rollback()

                    finalized = True
                    raise RefreshTokenReplayDetected(
                        "refresh token replay was detected"
                    )

                session_id = str(row[0])
                user_id = int(row[1])
                client_id = int(row[2])
                session_status = str(row[3])
                previous_access_hash = str(row[4])
                refresh_expires_at = row[5]
                user_status = str(row[6])
                role = str(row[7])
                membership_status = str(row[8])

                if session_status != "active":
                    connection.rollback()
                    finalized = True
                    raise InvalidRefreshToken(
                        "refresh token is inactive"
                    )

                if user_status != "active" or membership_status != "active":
                    cursor.execute(
                        """
                        UPDATE platform_user_sessions
                        SET
                            status = 'revoked',
                            revoked_at = %s,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND status = 'active'
                        """,
                        (now, session_id),
                    )
                    cursor.execute(
                        """
                        INSERT INTO control_plane_audit_log (
                            client_id,
                            actor_user_id,
                            action,
                            resource_type,
                            resource_id,
                            after_state,
                            metadata
                        )
                        VALUES (
                            %s, %s, 'user.session_revoked',
                            'platform_user_session', %s,
                            %s::jsonb, %s::jsonb
                        )
                        """,
                        (
                            client_id,
                            user_id,
                            session_id,
                            self._json({
                                "status": "revoked",
                                "revoked_at": now.isoformat(),
                            }),
                            self._json({
                                "reason": "inactive_user_or_membership",
                            }),
                        ),
                    )
                    connection.commit()
                    finalized = True
                    raise InvalidRefreshToken(
                        "refresh token is inactive"
                    )

                latest_access_expiry = (
                    refresh_expires_at - timedelta(microseconds=1)
                )

                if latest_access_expiry <= now:
                    cursor.execute(
                        """
                        UPDATE platform_user_sessions
                        SET
                            status = 'expired',
                            revoked_at = %s,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND status = 'active'
                        """,
                        (now, session_id),
                    )
                    cursor.execute(
                        """
                        INSERT INTO control_plane_audit_log (
                            client_id,
                            actor_user_id,
                            action,
                            resource_type,
                            resource_id,
                            after_state,
                            metadata
                        )
                        VALUES (
                            %s, %s, 'user.session_expired',
                            'platform_user_session', %s,
                            %s::jsonb, '{}'::jsonb
                        )
                        """,
                        (
                            client_id,
                            user_id,
                            session_id,
                            self._json({
                                "status": "expired",
                                "revoked_at": now.isoformat(),
                            }),
                        ),
                    )
                    connection.commit()
                    finalized = True
                    raise InvalidRefreshToken(
                        "refresh token has expired"
                    )

                access_token = self._access_token_factory()
                refresh_token = self._refresh_token_factory()

                if not access_token or not refresh_token:
                    raise AuthenticationError(
                        "token factory returned an empty token"
                    )

                access_hash = self.token_hash(access_token)
                refresh_hash = self.token_hash(refresh_token)

                if (
                    access_hash == previous_access_hash
                    or refresh_hash == presented_hash
                ):
                    raise AuthenticationError(
                        "token factory reused an active token"
                    )

                access_expires_at = min(
                    now + ACCESS_TOKEN_TTL,
                    latest_access_expiry,
                )
                cursor.execute(
                    """
                    INSERT INTO platform_refresh_token_history (
                        session_id,
                        user_id,
                        client_id,
                        token_hash,
                        consumed_at,
                        expires_at,
                        metadata
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s::jsonb
                    )
                    """,
                    (
                        session_id,
                        user_id,
                        client_id,
                        presented_hash,
                        now,
                        refresh_expires_at,
                        self._json(request.metadata),
                    ),
                )
                cursor.execute(
                    """
                    UPDATE platform_user_sessions
                    SET
                        access_token_hash = %s,
                        refresh_token_hash = %s,
                        auth_method = 'refresh_token',
                        access_expires_at = %s,
                        last_seen_at = %s,
                        metadata = metadata || %s::jsonb,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                      AND status = 'active'
                    """,
                    (
                        access_hash,
                        refresh_hash,
                        access_expires_at,
                        now,
                        self._json(request.metadata),
                        session_id,
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO control_plane_audit_log (
                        client_id,
                        actor_user_id,
                        action,
                        resource_type,
                        resource_id,
                        after_state,
                        metadata
                    )
                    VALUES (
                        %s, %s, 'user.session_refreshed',
                        'platform_user_session', %s,
                        %s::jsonb, %s::jsonb
                    )
                    """,
                    (
                        client_id,
                        user_id,
                        session_id,
                        self._json({
                            "status": "active",
                            "access_expires_at": (
                                access_expires_at.isoformat()
                            ),
                            "refresh_expires_at": (
                                refresh_expires_at.isoformat()
                            ),
                        }),
                        self._json({
                            "auth_method": "refresh_token",
                        }),
                    ),
                )

            connection.commit()
            finalized = True
            return RefreshResult(
                session_id=UUID(session_id),
                user_id=user_id,
                client_id=client_id,
                role=role,
                access_token=access_token,
                refresh_token=refresh_token,
                access_expires_at=access_expires_at,
                refresh_expires_at=refresh_expires_at,
            )

        except Exception:
            if not finalized:
                connection.rollback()
            raise

        finally:
            connection.close()

    def logout(self, request):
        if not isinstance(request, LogoutRequest):
            raise TypeError("request must be LogoutRequest")

        now = self._now()
        connection = self._connection_factory()
        finalized = False

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        id,
                        user_id,
                        client_id,
                        status
                    FROM platform_user_sessions
                    WHERE access_token_hash = %s
                    FOR UPDATE
                    """,
                    (self.token_hash(request.access_token),),
                )
                row = cursor.fetchone()

                if row is None:
                    connection.rollback()
                    finalized = True
                    raise InvalidAccessToken(
                        "access token is invalid"
                    )

                session_id = str(row[0])
                user_id = int(row[1])
                client_id = int(row[2])
                revoked = row[3] == "active"

                if revoked:
                    cursor.execute(
                        """
                        UPDATE platform_user_sessions
                        SET
                            status = 'revoked',
                            revoked_at = %s,
                            last_seen_at = %s,
                            metadata = metadata || %s::jsonb,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND status = 'active'
                        """,
                        (
                            now,
                            now,
                            self._json(request.metadata),
                            session_id,
                        ),
                    )
                    cursor.execute(
                        """
                        INSERT INTO control_plane_audit_log (
                            client_id,
                            actor_user_id,
                            action,
                            resource_type,
                            resource_id,
                            after_state,
                            metadata
                        )
                        VALUES (
                            %s, %s, 'user.logged_out',
                            'platform_user_session', %s,
                            %s::jsonb, %s::jsonb
                        )
                        """,
                        (
                            client_id,
                            user_id,
                            session_id,
                            self._json({
                                "status": "revoked",
                                "revoked_at": now.isoformat(),
                            }),
                            self._json({
                                "reason": "user_logout",
                            }),
                        ),
                    )
                    connection.commit()
                else:
                    connection.rollback()

            finalized = True
            return LogoutResult(
                session_id=UUID(session_id),
                user_id=user_id,
                client_id=client_id,
                revoked=revoked,
            )

        except Exception:
            if not finalized:
                connection.rollback()
            raise

        finally:
            connection.close()

    def authenticate_access_token(self, access_token):
        token = str(access_token or "").strip()

        if not token:
            raise InvalidAccessToken("access token is required")

        now = self._now()
        connection = self._connection_factory()
        finalized = False

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        session.id,
                        session.user_id,
                        session.client_id,
                        session.status,
                        session.access_expires_at,
                        user_account.email,
                        user_account.display_name,
                        user_account.status,
                        membership.role,
                        membership.status
                    FROM platform_user_sessions session
                    JOIN platform_users user_account
                      ON user_account.id = session.user_id
                    JOIN client_memberships membership
                      ON membership.user_id = session.user_id
                     AND membership.client_id = session.client_id
                    WHERE session.access_token_hash = %s
                    FOR UPDATE OF session
                    """,
                    (self.token_hash(token),),
                )
                row = cursor.fetchone()

                if row is None:
                    connection.rollback()
                    finalized = True
                    raise InvalidAccessToken("access token is invalid")

                if row[3] != "active":
                    connection.rollback()
                    finalized = True
                    raise InvalidAccessToken("access token is inactive")

                if row[4] <= now:
                    connection.rollback()
                    finalized = True
                    raise InvalidAccessToken("access token has expired")

                if row[7] != "active" or row[9] != "active":
                    connection.rollback()
                    finalized = True
                    raise InvalidAccessToken(
                        "user or membership is inactive"
                    )

                cursor.execute(
                    """
                    UPDATE platform_user_sessions
                    SET
                        last_seen_at = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                      AND status = 'active'
                    """,
                    (now, str(row[0])),
                )

            connection.commit()
            finalized = True
            return AuthenticatedPrincipal(
                session_id=UUID(str(row[0])),
                user_id=int(row[1]),
                client_id=int(row[2]),
                role=str(row[8]),
                email=str(row[5]),
                display_name=row[6],
                access_expires_at=row[4],
            )

        except Exception:
            if not finalized:
                connection.rollback()
            raise

        finally:
            connection.close()
