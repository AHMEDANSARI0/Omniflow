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

load_dotenv(
    PROJECT_ROOT / ".env"
)

from control_plane import (  # noqa: E402
    ClientOnboardingRequest,
    ClientOnboardingService,
    TrialLimits,
    verify_password,
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
    "control_plane_audit_log",
)


class DryRunError(RuntimeError):
    pass


class RollbackOnlyConnection:
    def __init__(self, connection):
        self.raw = connection
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
        raise DryRunError(message)


def database_environment():
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
        raise DryRunError(
            "Missing database environment values: "
            + ", ".join(missing)
        )

    return values


def connect(readonly=False):
    environment = database_environment()

    connection = psycopg2.connect(
        host=environment["DB_HOST"],
        port=environment["DB_PORT"],
        database=environment["DB_NAME"],
        user=environment["DB_USER"],
        password=environment["DB_PASSWORD"],
        connect_timeout=10,
        application_name=(
            "omniflow-onboarding-"
            "postgres-dry-run"
        ),
    )

    connection.set_session(
        readonly=readonly,
        autocommit=False,
    )

    return connection


def count_rows(cursor):
    counts = {}

    for table in COUNTED_TABLES:
        cursor.execute(
            f"SELECT COUNT(*) FROM {table}"
        )

        counts[table] = int(
            cursor.fetchone()[0]
        )

    return counts


def verify_client_and_user(
    cursor,
    request,
    result,
):
    cursor.execute(
        """
        SELECT
            client.business_name,
            client.owner_name,
            client.email,
            client.status,
            member.role,
            member.status
        FROM clients client
        JOIN client_memberships member
          ON member.client_id = client.id
        WHERE client.id = %s
          AND member.user_id = %s
        """,
        (
            result.client_id,
            result.owner_user_id,
        ),
    )

    client_row = cursor.fetchone()

    require(
        client_row
        == (
            request.business_name,
            request.owner_name,
            request.owner_email,
            "active",
            "owner",
            "active",
        ),
        (
            "Client or owner membership "
            "row is incorrect"
        ),
    )

    cursor.execute(
        """
        SELECT
            user_account.email,
            user_account.display_name,
            user_account.status,
            credential.password_hash
        FROM platform_users user_account
        JOIN user_password_credentials
             credential
          ON credential.user_id
             = user_account.id
        WHERE user_account.id = %s
        """,
        (result.owner_user_id,),
    )

    user_row = cursor.fetchone()

    require(
        user_row is not None,
        (
            "Owner user or password "
            "credential is missing"
        ),
    )

    require(
        user_row[:3]
        == (
            request.owner_email,
            request.owner_name,
            "active",
        ),
        "Owner user row is incorrect",
    )

    password_hash = user_row[3]

    require(
        request.password
        not in password_hash,
        (
            "Plaintext password appeared "
            "in stored hash"
        ),
    )

    require(
        verify_password(
            request.password,
            password_hash,
        ),
        (
            "Stored password hash "
            "did not verify"
        ),
    )


def verify_channel(
    cursor,
    result,
):
    cursor.execute(
        """
        SELECT
            account.client_id,
            account.status,
            account.connection_mode,
            account.external_account_id,
            connection.client_id,
            connection.status,
            connection.connection_mode,
            connection.connector_node_id
        FROM channel_accounts account
        JOIN channel_connections connection
          ON connection.channel_account_id
             = account.id
        WHERE account.id = %s
        """,
        (result.channel_account_id,),
    )

    row = cursor.fetchone()

    require(
        row is not None,
        (
            "Channel account or "
            "connection is missing"
        ),
    )

    require(
        row[0] == result.client_id
        and row[1] == "pending"
        and row[2] == "managed_web"
        and str(row[3]).startswith(
            "pending:"
        )
        and row[4] == result.client_id
        and row[5] == "waiting_for_node"
        and row[6] == "managed_web"
        and row[7] is None,
        (
            "Managed channel initial "
            "state is incorrect"
        ),
    )


def verify_agent(
    cursor,
    result,
):
    cursor.execute(
        """
        SELECT
            agent.client_id,
            agent.agent_key,
            agent.status,
            version.client_id,
            version.version_number,
            version.status,
            assignment.client_id,
            assignment.channel_account_id,
            assignment.agent_version_id,
            assignment.status
        FROM ai_agents agent
        JOIN ai_agent_versions version
          ON version.agent_id = agent.id
         AND version.client_id
             = agent.client_id
        JOIN channel_agent_assignments
             assignment
          ON assignment.agent_id = agent.id
         AND assignment.client_id
             = agent.client_id
         AND assignment.agent_version_id
             = version.id
        WHERE agent.id = %s
        """,
        (str(result.agent_id),),
    )

    row = cursor.fetchone()

    require(
        row
        == (
            result.client_id,
            "primary",
            "active",
            result.client_id,
            1,
            "active",
            result.client_id,
            result.channel_account_id,
            result.agent_version_id,
            "active",
        ),
        (
            "Agent version or channel "
            "assignment is incorrect"
        ),
    )


def verify_trial(
    cursor,
    request,
    result,
):
    cursor.execute(
        """
        SELECT
            entitlement.status,
            entitlement.max_channel_accounts,
            entitlement.max_managed_sessions,
            entitlement.max_inbound_messages,
            entitlement.max_ai_calls,
            entitlement.max_outbound_messages,
            usage.inbound_messages,
            usage.ai_calls,
            usage.outbound_messages
        FROM client_trial_entitlements
             entitlement
        JOIN client_usage_counters usage
          ON usage.client_id
             = entitlement.client_id
        WHERE entitlement.client_id = %s
        """,
        (result.client_id,),
    )

    row = cursor.fetchone()

    require(
        row
        == (
            "trial",
            request.trial.max_channel_accounts,
            request.trial.max_managed_sessions,
            request.trial.max_inbound_messages,
            request.trial.max_ai_calls,
            request.trial.max_outbound_messages,
            0,
            0,
            0,
        ),
        (
            "Trial entitlement or usage "
            "counters are incorrect"
        ),
    )


def verify_journal_and_audit(
    cursor,
    request,
    result,
):
    cursor.execute(
        """
        SELECT
            status,
            client_id,
            owner_user_id,
            channel_account_id,
            agent_id,
            request_fingerprint
        FROM onboarding_requests
        WHERE idempotency_key = %s
        """,
        (request.idempotency_key,),
    )

    journal = cursor.fetchone()

    require(
        journal is not None
        and journal[0] == "completed"
        and journal[1] == result.client_id
        and journal[2]
            == result.owner_user_id
        and journal[3]
            == result.channel_account_id
        and str(journal[4])
            == str(result.agent_id)
        and journal[5]
            == request.fingerprint,
        (
            "Onboarding idempotency "
            "journal is incorrect"
        ),
    )

    cursor.execute(
        """
        SELECT COUNT(*)
        FROM control_plane_audit_log
        WHERE client_id = %s
          AND actor_user_id = %s
          AND action = 'client.onboarded'
          AND resource_type
              = 'channel_account'
          AND resource_id = %s
        """,
        (
            result.client_id,
            result.owner_user_id,
            str(result.channel_account_id),
        ),
    )

    require(
        int(cursor.fetchone()[0]) == 1,
        (
            "Onboarding audit event "
            "is missing"
        ),
    )


def verify_inserted_graph(
    cursor,
    request,
    result,
):
    verify_client_and_user(
        cursor,
        request,
        result,
    )

    verify_channel(
        cursor,
        result,
    )

    verify_agent(
        cursor,
        result,
    )

    verify_trial(
        cursor,
        request,
        result,
    )

    verify_journal_and_audit(
        cursor,
        request,
        result,
    )


def main():
    token = uuid4().hex

    request = ClientOnboardingRequest(
        idempotency_key=(
            f"postgres-dry-run:{token}"
        ),
        request_id=uuid4(),
        business_name=(
            "Rollback Only Business "
            f"{token[:8]}"
        ),
        owner_name="Rollback Test Owner",
        owner_email=(
            f"rollback-{token}"
            "@example.invalid"
        ),
        password=(
            "Rollback-Only-"
            "Password-123!"
        ),
        channel_name=(
            "Rollback Test WhatsApp"
        ),
        platform="whatsapp",
        agent_name="Rollback Test Agent",
        agent_instruction=(
            "Use verified business information "
            "and handoff uncertain requests."
        ),
        business_profile={
            "test_mode": "rollback_only",
            "timezone": "Asia/Karachi",
        },
        language_policy={
            "english": "english",
            "urdu":
                "pakistani_roman_urdu",
        },
        trial=TrialLimits(
            days=7,
            max_channel_accounts=1,
            max_managed_sessions=1,
            max_inbound_messages=25,
            max_ai_calls=25,
            max_outbound_messages=25,
        ),
    )

    require(
        request.password not in repr(request),
        (
            "Request repr exposed the "
            "plaintext password"
        ),
    )

    raw_connection = connect(
        readonly=False
    )

    wrapper = RollbackOnlyConnection(
        raw_connection
    )

    before_counts = None

    try:
        with raw_connection.cursor() as cursor:
            before_counts = count_rows(
                cursor
            )

        service = ClientOnboardingService(
            lambda: wrapper,
            clock=lambda: datetime.now(
                timezone.utc
            ),
        )

        result = service.onboard(request)

        require(
            wrapper.commit_attempts == 1,
            (
                "Service did not reach its "
                "commit boundary"
            ),
        )

        require(
            wrapper.close_attempts == 1,
            (
                "Service did not reach its "
                "close boundary"
            ),
        )

        require(
            wrapper.rollback_attempts == 0,
            (
                "Service unexpectedly rolled "
                "back before verification"
            ),
        )

        with raw_connection.cursor() as cursor:
            verify_inserted_graph(
                cursor,
                request,
                result,
            )

        raw_connection.rollback()

    except Exception:
        raw_connection.rollback()
        raise

    finally:
        raw_connection.close()

    verification_connection = connect(
        readonly=True
    )

    try:
        with (
            verification_connection.cursor()
            as cursor
        ):
            after_counts = count_rows(cursor)

            cursor.execute(
                """
                SELECT COUNT(*)
                FROM onboarding_requests
                WHERE idempotency_key = %s
                """,
                (request.idempotency_key,),
            )

            persisted_request_count = int(
                cursor.fetchone()[0]
            )

        require(
            after_counts == before_counts,
            (
                "Rollback-only test changed "
                "persistent row counts"
            ),
        )

        require(
            persisted_request_count == 0,
            (
                "Rollback-only onboarding "
                "request persisted"
            ),
        )

        verification_connection.rollback()

    except Exception:
        verification_connection.rollback()
        raise

    finally:
        verification_connection.close()

    print(
        "PostgreSQL onboarding SQL: executed"
    )
    print(
        "Atomic client/user/channel graph: "
        "verified"
    )
    print(
        "Scrypt credential persistence: "
        "verified"
    )
    print(
        "Managed channel state: "
        "waiting_for_node"
    )
    print(
        "Versioned agent assignment: "
        "verified"
    )
    print(
        "Trial entitlement and usage "
        "counters: verified"
    )
    print(
        "Idempotency journal and audit "
        "event: verified"
    )
    print(
        "Transaction intentionally "
        "rolled back: True"
    )
    print(
        "Persistent row-count changes: 0"
    )
    print("")
    print(
        "DYNAMIC ONBOARDING POSTGRES "
        "DRY RUN PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
