import os
import sys
from datetime import (
    datetime,
    timezone,
)
from pathlib import Path
from uuid import uuid4

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

load_dotenv(
    PROJECT_ROOT / ".env"
)

from control_plane import (  # noqa: E402
    ClientOnboardingRequest,
    ClientOnboardingService,
    LoginRequest,
    PlatformAuthenticationService,
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
    "control_plane_audit_log",
)

FIXED_NOW = datetime(
    2026,
    8,
    24,
    15,
    0,
    tzinfo=timezone.utc,
)

ACCESS_TOKEN = (
    "ofa_postgres_dry_run_"
    "access_secret"
)

REFRESH_TOKEN = (
    "ofr_postgres_dry_run_"
    "refresh_secret"
)


class AuthDryRunError(RuntimeError):
    pass


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
        raise AuthDryRunError(message)


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
        raise AuthDryRunError(
            "Missing database environment "
            "values: "
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
        application_name=(
            "omniflow-auth-"
            "postgres-dry-run"
        ),
    )

    result.set_session(
        readonly=readonly,
        autocommit=False,
    )

    return result


def counts(cursor):
    result = {}

    for table in COUNTED_TABLES:
        cursor.execute(
            f"SELECT COUNT(*) "
            f"FROM {table}"
        )

        result[table] = int(
            cursor.fetchone()[0]
        )

    return result


def verify_session(
    cursor,
    login_result,
):
    cursor.execute(
        """
        SELECT
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
            revoked_at
        FROM platform_user_sessions
        WHERE id = %s
        """,
        (
            str(
                login_result.session_id
            ),
        ),
    )

    row = cursor.fetchone()

    require(
        row is not None,
        "Platform login session "
        "is missing",
    )

    expected_access_hash = (
        PlatformAuthenticationService
        .token_hash(ACCESS_TOKEN)
    )

    expected_refresh_hash = (
        PlatformAuthenticationService
        .token_hash(REFRESH_TOKEN)
    )

    require(
        row[0] == login_result.user_id
        and row[1]
            == login_result.client_id
        and row[2]
            == expected_access_hash
        and row[3]
            == expected_refresh_hash
        and row[4] == "active"
        and row[5] == "password"
        and row[6] == FIXED_NOW
        and row[7]
            == login_result
               .access_expires_at
        and row[8]
            == login_result
               .refresh_expires_at
        and row[9] == FIXED_NOW
        and row[10] is None,
        (
            "Platform login session "
            "fields are incorrect"
        ),
    )

    rendered = repr(row)

    require(
        ACCESS_TOKEN not in rendered
        and REFRESH_TOKEN
            not in rendered,
        (
            "Raw session token appeared "
            "in PostgreSQL"
        ),
    )

    cursor.execute(
        """
        SELECT COUNT(*)
        FROM control_plane_audit_log
        WHERE client_id = %s
          AND actor_user_id = %s
          AND action = 'user.logged_in'
          AND resource_type
              = 'platform_user_session'
          AND resource_id = %s
        """,
        (
            login_result.client_id,
            login_result.user_id,
            str(
                login_result.session_id
            ),
        ),
    )

    require(
        int(cursor.fetchone()[0]) == 1,
        (
            "Successful login audit "
            "event is missing"
        ),
    )


def main():
    token = uuid4().hex

    password = (
        "Postgres-Auth-"
        "Dry-Run-123!"
    )

    email = (
        f"auth-dry-run-{token}"
        "@example.invalid"
    )

    idempotency_key = (
        f"auth-postgres-dry-run:"
        f"{token}"
    )

    onboarding_request = (
        ClientOnboardingRequest(
            idempotency_key=(
                idempotency_key
            ),
            request_id=uuid4(),
            business_name=(
                "Auth Dry Run "
                f"{token[:8]}"
            ),
            owner_name=(
                "Auth Dry Run Owner"
            ),
            owner_email=email,
            password=password,
            channel_name=(
                "Auth Dry Run WhatsApp"
            ),
            platform="whatsapp",
            agent_name=(
                "Auth Dry Run Agent"
            ),
            agent_instruction=(
                "Use verified business "
                "information and hand off "
                "uncertainty."
            ),
            business_profile={
                "test_mode":
                    "rollback_only",
                "timezone":
                    "Asia/Karachi",
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
    )

    raw = connect(
        readonly=False
    )

    wrapper = RollbackOnlyConnection(
        raw
    )

    before = None

    try:
        with raw.cursor() as cursor:
            before = counts(cursor)

        onboarding = (
            ClientOnboardingService(
                lambda: wrapper,
                clock=lambda: FIXED_NOW,
            )
        )

        onboarded = onboarding.onboard(
            onboarding_request
        )

        authentication = (
            PlatformAuthenticationService(
                lambda: wrapper,
                clock=lambda: FIXED_NOW,
                access_token_factory=(
                    lambda: ACCESS_TOKEN
                ),
                refresh_token_factory=(
                    lambda: REFRESH_TOKEN
                ),
                dummy_password_hash=(
                    hash_password(
                        "Auth-Dummy-"
                        "Password-123!"
                    )
                ),
            )
        )

        login_result = (
            authentication.login(
                LoginRequest(
                    email=email,
                    password=password,
                    client_id=(
                        onboarded.client_id
                    ),
                    metadata={
                        "test_mode":
                            "rollback_only",
                    },
                )
            )
        )

        require(
            login_result.user_id
                == onboarded
                   .owner_user_id
            and login_result.client_id
                == onboarded.client_id
            and login_result.role
                == "owner",
            (
                "Login result is not "
                "scoped to the "
                "onboarded tenant"
            ),
        )

        require(
            ACCESS_TOKEN
                not in repr(login_result)
            and REFRESH_TOKEN
                not in repr(login_result),
            (
                "Login result repr "
                "exposed raw tokens"
            ),
        )

        with raw.cursor() as cursor:
            verify_session(
                cursor,
                login_result,
            )

        principal = (
            authentication
            .authenticate_access_token(
                ACCESS_TOKEN
            )
        )

        require(
            principal.user_id
                == onboarded
                   .owner_user_id
            and principal.client_id
                == onboarded.client_id
            and principal.role
                == "owner"
            and principal.email
                == email,
            (
                "Authenticated principal "
                "is incorrect"
            ),
        )

        require(
            wrapper.commit_attempts == 3,
            (
                "Expected onboarding, "
                "login, and authentication "
                "commit boundaries"
            ),
        )

        require(
            wrapper.rollback_attempts == 0,
            (
                "Unexpected rollback "
                "occurred before final "
                "test rollback"
            ),
        )

        require(
            wrapper.close_attempts == 3,
            (
                "Expected three service "
                "close boundaries"
            ),
        )

        raw.rollback()

    except Exception:
        raw.rollback()
        raise

    finally:
        raw.close()

    verification = connect(
        readonly=True
    )

    try:
        with (
            verification.cursor()
            as cursor
        ):
            after = counts(cursor)

            cursor.execute(
                """
                SELECT COUNT(*)
                FROM onboarding_requests
                WHERE idempotency_key = %s
                """,
                (idempotency_key,),
            )

            onboarding_rows = int(
                cursor.fetchone()[0]
            )

            cursor.execute(
                """
                SELECT COUNT(*)
                FROM platform_users
                WHERE email = %s
                """,
                (email,),
            )

            user_rows = int(
                cursor.fetchone()[0]
            )

        require(
            after == before,
            (
                "Rollback-only auth test "
                "changed persistent "
                "row counts"
            ),
        )

        require(
            onboarding_rows == 0
            and user_rows == 0,
            (
                "Rollback-only auth test "
                "persisted temporary "
                "identities"
            ),
        )

        verification.rollback()

    except Exception:
        verification.rollback()
        raise

    finally:
        verification.close()

    print(
        "Temporary tenant onboarding "
        "in transaction: verified"
    )

    print(
        "PostgreSQL password login: "
        "verified"
    )

    print(
        "Access/refresh token digest "
        "persistence: verified"
    )

    print(
        "Raw session tokens in "
        "database: absent"
    )

    print(
        "Tenant-scoped owner session: "
        "verified"
    )

    print(
        "Access-token authentication: "
        "verified"
    )

    print(
        "Login audit event: verified"
    )

    print(
        "Transaction intentionally "
        "rolled back: True"
    )

    print(
        "Persistent row-count changes: 0"
    )

    print(
        "Browser and WhatsApp workers "
        "started: False"
    )

    print("")
    print(
        "PLATFORM AUTH POSTGRES "
        "DRY RUN PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
