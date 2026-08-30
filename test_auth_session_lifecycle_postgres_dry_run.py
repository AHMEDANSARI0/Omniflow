import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

load_dotenv(PROJECT_ROOT / ".env")

from control_plane import (  # noqa: E402
    ClientOnboardingRequest,
    ClientOnboardingService,
    LoginRequest,
    LogoutRequest,
    PlatformAuthenticationService,
    RefreshRequest,
    RefreshTokenReplayDetected,
    TrialLimits,
    hash_password,
)


REQUIRED_ENVIRONMENT = (
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
)
COUNTED_TABLES = (
    "clients",
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "channel_accounts",
    "channel_connections",
    "ai_agents",
    "ai_agent_versions",
    "channel_agent_assignments",
    "client_trial_entitlements",
    "client_usage_counters",
    "onboarding_requests",
    "platform_user_sessions",
    "platform_refresh_token_history",
    "control_plane_audit_log",
)
FIXED_NOW = datetime(
    2026,
    8,
    24,
    18,
    0,
    tzinfo=timezone.utc,
)
ACCESS_A1 = "ofa_postgres_lifecycle_access_a1"
REFRESH_A1 = "ofr_postgres_lifecycle_refresh_a1"
ACCESS_A2 = "ofa_postgres_lifecycle_access_a2"
REFRESH_A2 = "ofr_postgres_lifecycle_refresh_a2"
ACCESS_B1 = "ofa_postgres_lifecycle_access_b1"
REFRESH_B1 = "ofr_postgres_lifecycle_refresh_b1"


class LifecycleDryRunError(RuntimeError):
    pass


class SequenceFactory:
    def __init__(self, values):
        self.values = list(values)

    def __call__(self):
        if not self.values:
            raise LifecycleDryRunError(
                "Token test factory was exhausted"
            )
        return self.values.pop(0)


class RollbackOnlyConnection:
    def __init__(self, raw):
        self.raw = raw
        self.commit_attempts = 0
        self.rollback_attempts = 0
        self.close_attempts = 0

    def cursor(self):
        return self.raw.cursor()

    def commit(self):
        self.commit_attempts += 1

    def rollback(self):
        self.rollback_attempts += 1
        self.raw.rollback()

    def close(self):
        self.close_attempts += 1


def require(condition, message):
    if not condition:
        raise LifecycleDryRunError(message)


def environment():
    values = {
        name: os.getenv(name)
        for name in REQUIRED_ENVIRONMENT
    }
    missing = [
        name
        for name, value in values.items()
        if not str(value or "").strip()
    ]

    if missing:
        raise LifecycleDryRunError(
            "Missing database environment values: "
            + ", ".join(missing)
        )

    return values


def connect(readonly=False):
    values = environment()
    result = psycopg2.connect(
        host=values["DB_HOST"],
        port=values["DB_PORT"],
        database=values["DB_NAME"],
        user=values["DB_USER"],
        password=values["DB_PASSWORD"],
        connect_timeout=10,
        application_name="omniflow-auth-lifecycle-postgres-dry-run",
    )
    result.set_session(readonly=readonly, autocommit=False)
    return result


def counts(cursor):
    result = {}

    for table in COUNTED_TABLES:
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        result[table] = int(cursor.fetchone()[0])

    return result


def audit_count(cursor, session_id, action):
    cursor.execute(
        """
        SELECT COUNT(*)
        FROM control_plane_audit_log
        WHERE resource_type = 'platform_user_session'
          AND resource_id = %s
          AND action = %s
        """,
        (str(session_id), action),
    )
    return int(cursor.fetchone()[0])


def main():
    token = uuid4().hex
    password = "Postgres-Lifecycle-Dry-Run-123!"
    email = f"auth-lifecycle-{token}@example.invalid"
    idempotency_key = f"auth-lifecycle-postgres:{token}"
    onboarding_request = ClientOnboardingRequest(
        idempotency_key=idempotency_key,
        request_id=uuid4(),
        business_name=f"Lifecycle Dry Run {token[:8]}",
        owner_name="Lifecycle Dry Run Owner",
        owner_email=email,
        password=password,
        channel_name="Lifecycle Dry Run WhatsApp",
        platform="whatsapp",
        agent_name="Lifecycle Dry Run Agent",
        agent_instruction=(
            "Use verified business information and hand off uncertainty."
        ),
        business_profile={
            "test_mode": "rollback_only",
            "timezone": "Asia/Karachi",
        },
        trial=TrialLimits(
            days=7,
            max_channel_accounts=1,
            max_managed_sessions=1,
            max_inbound_messages=10,
            max_ai_calls=10,
            max_outbound_messages=10,
        ),
    )

    raw = connect(readonly=False)
    wrapper = RollbackOnlyConnection(raw)
    before = None

    try:
        with raw.cursor() as cursor:
            before = counts(cursor)

        onboarded = ClientOnboardingService(
            lambda: wrapper,
            clock=lambda: FIXED_NOW,
        ).onboard(onboarding_request)
        authentication = PlatformAuthenticationService(
            lambda: wrapper,
            clock=lambda: FIXED_NOW,
            access_token_factory=SequenceFactory([
                ACCESS_A1,
                ACCESS_A2,
                ACCESS_B1,
            ]),
            refresh_token_factory=SequenceFactory([
                REFRESH_A1,
                REFRESH_A2,
                REFRESH_B1,
            ]),
            dummy_password_hash=hash_password(
                "Lifecycle-Dummy-Password-123!"
            ),
        )
        login_a = authentication.login(
            LoginRequest(
                email=email,
                password=password,
                client_id=onboarded.client_id,
                metadata={"test_mode": "rollback_only"},
            )
        )
        rotated = authentication.refresh(
            RefreshRequest(
                refresh_token=REFRESH_A1,
                metadata={"test_mode": "rollback_only"},
            )
        )
        require(
            rotated.session_id == login_a.session_id
            and rotated.user_id == onboarded.owner_user_id
            and rotated.client_id == onboarded.client_id,
            "Rotated session escaped its tenant or identity",
        )
        require(
            rotated.access_token == ACCESS_A2
            and rotated.refresh_token == REFRESH_A2,
            "Rotated token values are incorrect",
        )
        principal = authentication.authenticate_access_token(
            ACCESS_A2
        )
        require(
            principal.session_id == login_a.session_id
            and principal.client_id == onboarded.client_id,
            "Rotated access token did not authenticate its session",
        )

        with raw.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    access_token_hash,
                    refresh_token_hash,
                    status,
                    auth_method
                FROM platform_user_sessions
                WHERE id = %s
                """,
                (str(login_a.session_id),),
            )
            session_row = cursor.fetchone()
            require(
                session_row
                == (
                    PlatformAuthenticationService.token_hash(ACCESS_A2),
                    PlatformAuthenticationService.token_hash(REFRESH_A2),
                    "active",
                    "refresh_token",
                ),
                "Rotated session digest state is incorrect",
            )
            cursor.execute(
                """
                SELECT
                    token_hash,
                    user_id,
                    client_id,
                    expires_at
                FROM platform_refresh_token_history
                WHERE session_id = %s
                """,
                (str(login_a.session_id),),
            )
            history_row = cursor.fetchone()
            require(
                history_row is not None
                and history_row[0]
                == PlatformAuthenticationService.token_hash(REFRESH_A1)
                and history_row[1] == onboarded.owner_user_id
                and history_row[2] == onboarded.client_id
                and history_row[3] == login_a.refresh_expires_at,
                "Consumed refresh-token history is incorrect",
            )
            require(
                REFRESH_A1 not in repr(history_row)
                and REFRESH_A2 not in repr(session_row)
                and ACCESS_A2 not in repr(session_row),
                "Raw session token appeared in PostgreSQL",
            )
            require(
                audit_count(
                    cursor,
                    login_a.session_id,
                    "user.session_refreshed",
                )
                == 1,
                "Refresh audit event is missing",
            )

        try:
            authentication.refresh(
                RefreshRequest(refresh_token=REFRESH_A1)
            )
        except RefreshTokenReplayDetected:
            pass
        else:
            raise LifecycleDryRunError(
                "Consumed refresh token was accepted again"
            )

        with raw.cursor() as cursor:
            cursor.execute(
                """
                SELECT status, revoked_at
                FROM platform_user_sessions
                WHERE id = %s
                """,
                (str(login_a.session_id),),
            )
            replayed_row = cursor.fetchone()
            require(
                replayed_row is not None
                and replayed_row[0] == "revoked"
                and replayed_row[1] == FIXED_NOW,
                "Replay did not revoke the rotated session",
            )
            require(
                audit_count(
                    cursor,
                    login_a.session_id,
                    "user.session_refresh_replay_detected",
                )
                == 1,
                "Replay-detection audit event is missing",
            )

        login_b = authentication.login(
            LoginRequest(
                email=email,
                password=password,
                client_id=onboarded.client_id,
                metadata={"test_mode": "rollback_only"},
            )
        )
        logout = authentication.logout(
            LogoutRequest(
                access_token=ACCESS_B1,
                metadata={"test_mode": "rollback_only"},
            )
        )
        require(
            logout.session_id == login_b.session_id
            and logout.revoked is True,
            "Logout did not revoke its active session",
        )

        with raw.cursor() as cursor:
            cursor.execute(
                """
                SELECT status, revoked_at
                FROM platform_user_sessions
                WHERE id = %s
                """,
                (str(login_b.session_id),),
            )
            logout_row = cursor.fetchone()
            require(
                logout_row is not None
                and logout_row[0] == "revoked"
                and logout_row[1] == FIXED_NOW,
                "Logged-out session remains active",
            )
            require(
                audit_count(
                    cursor,
                    login_b.session_id,
                    "user.logged_out",
                )
                == 1,
                "Logout audit event is missing",
            )

        require(
            wrapper.rollback_attempts == 0,
            "Unexpected service rollback occurred before outer rollback",
        )
        require(
            wrapper.commit_attempts == 7,
            "Expected seven successful service commit boundaries",
        )
        raw.rollback()

    except Exception:
        raw.rollback()
        raise

    finally:
        raw.close()

    verification = connect(readonly=True)

    try:
        with verification.cursor() as cursor:
            after = counts(cursor)
            cursor.execute(
                "SELECT COUNT(*) FROM platform_users WHERE email = %s",
                (email,),
            )
            user_rows = int(cursor.fetchone()[0])
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM onboarding_requests
                WHERE idempotency_key = %s
                """,
                (idempotency_key,),
            )
            onboarding_rows = int(cursor.fetchone()[0])

        require(
            after == before,
            "Rollback-only lifecycle test changed persistent row counts",
        )
        require(
            user_rows == 0 and onboarding_rows == 0,
            "Rollback-only lifecycle test persisted temporary identities",
        )
        verification.rollback()

    except Exception:
        verification.rollback()
        raise

    finally:
        verification.close()

    print("Temporary tenant/session lifecycle: verified")
    print("PostgreSQL refresh-token rotation: verified")
    print("Consumed digest history: verified")
    print("Rotated access-token authentication: verified")
    print("Refresh replay family revocation: verified")
    print("Logout revocation: verified")
    print("Refresh/replay/logout audits: verified")
    print("Raw tokens in PostgreSQL: absent")
    print("Transaction intentionally rolled back: True")
    print("Persistent row-count changes: 0")
    print("Browser and WhatsApp workers started: False")
    print("\nAUTH SESSION LIFECYCLE POSTGRES DRY RUN PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
