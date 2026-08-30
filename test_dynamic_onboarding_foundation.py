import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"
MIGRATION = (
    PROJECT_ROOT
    / "migrations"
    / "004_dynamic_onboarding_agents_trials.sql"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    API_VERSION,
    ClientOnboardingRequest,
    ClientOnboardingService,
    OnboardingConflict,
    PasswordValidationError,
    TrialLimits,
    hash_password,
    password_hash_needs_upgrade,
    verify_password,
)


class ScriptedCursor:
    def __init__(self, connection):
        self.connection = connection
        self._one = None
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(
        self,
        error_type,
        error,
        traceback,
    ):
        return False

    def execute(
        self,
        query,
        parameters=(),
    ):
        self.connection.executions.append(
            (
                query,
                tuple(parameters or ()),
            )
        )

        if not self.connection.script:
            raise AssertionError(
                "Unexpected onboarding database query"
            )

        response = self.connection.script.pop(0)

        if "error" in response:
            raise response["error"]

        self._one = response.get("one")
        self.rowcount = response.get(
            "rowcount",
            1,
        )

    def fetchone(self):
        value = self._one
        self._one = None
        return value


class ScriptedConnection:
    def __init__(self, script):
        self.script = list(script)
        self.executions = []
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1


def normalized_queries(connection):
    return [
        " ".join(query.lower().split())
        for query, _ in connection.executions
    ]


def expect_error(
    error_type,
    callback,
):
    try:
        callback()
    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def make_request(
    key="onboard:test:1",
):
    return ClientOnboardingRequest(
        idempotency_key=key,
        business_name="Test Business",
        owner_name="Test Owner",
        owner_email="OWNER@EXAMPLE.COM",
        owner_phone="+923001234567",
        password="Correct-Horse-123!",
        channel_name="Test WhatsApp",
        agent_name="Sales and Support",
        agent_instruction=(
            "Answer using verified business information. "
            "Qualify leads and hand off uncertain cases."
        ),
        business_profile={
            "industry": "services",
            "timezone": "Asia/Karachi",
        },
        language_policy={
            "english": "english",
            "urdu": "pakistani_roman_urdu",
        },
        tone_policy={
            "style": "professional_friendly",
        },
        trial=TrialLimits(
            days=7,
            max_channel_accounts=1,
            max_managed_sessions=1,
            max_inbound_messages=100,
            max_ai_calls=100,
            max_outbound_messages=100,
        ),
    )


def verify_password_security():
    password = "Correct-Horse-123!"

    first = hash_password(password)
    second = hash_password(password)

    assert first != second
    assert password not in first
    assert first.startswith("scrypt$v=1$")
    assert verify_password(
        password,
        first,
    )
    assert not verify_password(
        "wrong-password",
        first,
    )
    assert not password_hash_needs_upgrade(
        first
    )
    assert password_hash_needs_upgrade(
        "legacy-hash"
    )

    expect_error(
        PasswordValidationError,
        lambda: hash_password("short"),
    )


def verify_migration_contract():
    sql = MIGRATION.read_text(
        encoding="utf-8"
    )

    def require(pattern, label):
        match = re.search(
            pattern,
            sql,
            flags=(
                re.IGNORECASE
                | re.DOTALL
            ),
        )
        assert match is not None, label

    required_tables = (
        "ai_agents",
        "ai_agent_versions",
        "channel_agent_assignments",
        "client_trial_entitlements",
        "client_usage_counters",
        "onboarding_requests",
    )

    for table in required_tables:
        require(
            rf"create\s+table\s+if\s+"
            rf"not\s+exists\s+{table}\b",
            f"Missing table contract: {table}",
        )

    require(
        r"references\s+channel_accounts\s*"
        r"\(\s*id\s*,\s*client_id\s*\)",
        (
            "Composite channel-account "
            "tenant foreign key is missing"
        ),
    )

    require(
        r"references\s+ai_agents\s*"
        r"\(\s*id\s*,\s*client_id\s*\)",
        (
            "Composite AI-agent tenant "
            "foreign key is missing"
        ),
    )

    require(
        r"where\s+status\s*=\s*'active'",
        (
            "Single-active-agent index "
            "predicate is missing"
        ),
    )

    require(
        r"unique\s*\(\s*agent_id\s*,"
        r"\s*version_number\s*\)",
        "Agent version uniqueness is missing",
    )

    require(
        r"unique\s*\(\s*idempotency_key\s*\)",
        (
            "Onboarding idempotency "
            "uniqueness is missing"
        ),
    )

    require(
        r"request_fingerprint\s+char\s*"
        r"\(\s*64\s*\)\s+not\s+null",
        (
            "Request fingerprint contract "
            "is missing"
        ),
    )

    require(
        r"max_managed_sessions\s+integer"
        r"\s+not\s+null",
        (
            "Managed-session trial limit "
            "is missing"
        ),
    )

    require(
        r"system_instruction\s+text"
        r"\s+not\s+null",
        (
            "Agent instruction contract "
            "is missing"
        ),
    )

    require(
        r"tool_config\s+jsonb"
        r"\s+not\s+null",
        (
            "Agent tool configuration "
            "is missing"
        ),
    )

    require(
        r"handoff_config\s+jsonb"
        r"\s+not\s+null",
        (
            "Agent handoff configuration "
            "is missing"
        ),
    )

    account_one_hardcoding = re.search(
        r"\bclient_id\s*=\s*1\b",
        sql,
        flags=re.IGNORECASE,
    )

    assert account_one_hardcoding is None, (
        "Hardcoded client_id=1 found"
    )

    channel_one_hardcoding = re.search(
        r"\bchannel_account_id\s*=\s*1\b",
        sql,
        flags=re.IGNORECASE,
    )

    assert channel_one_hardcoding is None, (
        "Hardcoded channel_account_id=1 found"
    )

    require(
        r"\A\s*begin\s*;",
        "Migration must start with BEGIN;",
    )

    require(
        r"commit\s*;\s*\Z",
        "Migration must end with COMMIT;",
    )

    do_blocks = re.findall(
        r"\bdo\s+\$\$",
        sql,
        flags=re.IGNORECASE,
    )

    do_endings = re.findall(
        r"\$\$\s*;",
        sql,
    )

    assert len(do_blocks) == 1, (
        "Expected exactly one PostgreSQL "
        "DO block"
    )

    assert len(do_endings) == 1, (
        "Expected exactly one PostgreSQL "
        "DO block ending"
    )

    require(
        r"raise\s+exception\s+"
        r"'migration invariant failed:\s*"
        r"cross-tenant channel agent "
        r"assignment'\s*;",
        (
            "First migration invariant "
            "is missing or malformed"
        ),
    )

    require(
        r"raise\s+exception\s+"
        r"'migration invariant failed:\s*"
        r"cross-tenant agent version'\s*;",
        (
            "Second migration invariant "
            "is missing or malformed"
        ),
    )

    adjacent_literals = re.search(
        r"raise\s+exception\s+"
        r"'(?:''|[^'])*'\s+'",
        sql,
        flags=(
            re.IGNORECASE
            | re.DOTALL
        ),
    )

    assert adjacent_literals is None, (
        "Adjacent PostgreSQL string literals "
        "remain in RAISE EXCEPTION"
    )


def verify_atomic_onboarding():
    request = make_request()

    fixed_now = datetime(
        2026,
        8,
        23,
        12,
        0,
        tzinfo=timezone.utc,
    )

    script = [
        {},
        {"one": None},
        {},
        {"one": (501,)},
        {"one": (9001,)},
        {},
        {},
        {"one": (101,)},
        {},
        {},
        {"one": (7001,)},
        {},
        {},
        {},
        {"rowcount": 1},
        {},
    ]

    connection = ScriptedConnection(
        script
    )

    service = ClientOnboardingService(
        lambda: connection,
        clock=lambda: fixed_now,
    )

    result = service.onboard(request)

    assert result.client_id == 501
    assert result.owner_user_id == 9001
    assert result.channel_account_id == 101
    assert result.agent_version_id == 7001
    assert isinstance(
        result.agent_id,
        UUID,
    )
    assert (
        result.connection_status
        == "waiting_for_node"
    )
    assert not result.idempotent_replay

    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1
    assert not connection.script

    recorded = repr(
        connection.executions
    )

    assert request.password not in recorded
    assert "scrypt$v=1$" in recorded

    queries = normalized_queries(
        connection
    )
    combined = " ".join(queries)

    assert (
        "pg_advisory_xact_lock"
        in queries[0]
    )
    assert "insert into clients" in combined
    assert (
        "insert into platform_users"
        in combined
    )
    assert (
        "insert into user_password_credentials"
        in combined
    )
    assert (
        "insert into client_memberships"
        in combined
    )
    assert (
        "insert into channel_accounts"
        in combined
    )
    assert (
        "insert into channel_connections"
        in combined
    )
    assert "'pending'" in combined
    assert "'managed_web'" in combined
    assert "'waiting_for_node'" in combined
    assert (
        "insert into ai_agents"
        in combined
    )
    assert (
        "insert into ai_agent_versions"
        in combined
    )
    assert (
        "insert into channel_agent_assignments"
        in combined
    )
    assert (
        "insert into client_trial_entitlements"
        in combined
    )
    assert (
        "insert into client_usage_counters"
        in combined
    )
    assert (
        "insert into control_plane_audit_log"
        in combined
    )


def verify_idempotent_replay_and_conflict():
    request = make_request(
        "onboard:replay:1"
    )

    agent_id = UUID(
        "00000000-0000-0000-"
        "0000-000000000777"
    )

    existing_row = (
        "completed",
        request.fingerprint,
        str(request.request_id),
        501,
        9001,
        101,
        str(agent_id),
        7001,
    )

    connection = ScriptedConnection([
        {},
        {"one": existing_row},
    ])

    service = ClientOnboardingService(
        lambda: connection,
        password_hasher=lambda password: (
            "unused-password-hash"
        ),
    )

    result = service.onboard(request)

    assert result.idempotent_replay
    assert result.client_id == 501
    assert result.agent_id == agent_id
    assert len(connection.executions) == 2
    assert connection.commits == 1
    assert connection.rollbacks == 0

    different = ClientOnboardingRequest(
        idempotency_key=(
            request.idempotency_key
        ),
        business_name="Different Business",
        owner_name=request.owner_name,
        owner_email=request.owner_email,
        password=request.password,
    )

    conflict_connection = (
        ScriptedConnection([
            {},
            {"one": existing_row},
        ])
    )

    conflict_service = (
        ClientOnboardingService(
            lambda: conflict_connection,
            password_hasher=lambda password: (
                "unused-password-hash"
            ),
        )
    )

    expect_error(
        OnboardingConflict,
        lambda: conflict_service.onboard(
            different
        ),
    )

    assert (
        conflict_connection.commits == 0
    )
    assert (
        conflict_connection.rollbacks == 1
    )
    assert (
        conflict_connection.closes == 1
    )


def main():
    assert API_VERSION == "v1"

    verify_password_security()
    verify_migration_contract()
    verify_atomic_onboarding()
    verify_idempotent_replay_and_conflict()

    print(
        "Scrypt password hashing/"
        "verification: passed"
    )
    print(
        "Password plaintext persistence/"
        "logging: absent"
    )
    print(
        "Versioned agent schema: passed"
    )
    print(
        "Per-channel agent assignment "
        "schema: passed"
    )
    print(
        "Trial entitlement/usage "
        "schema: passed"
    )
    print(
        "API v1 idempotency journal: passed"
    )
    print(
        "Atomic client/user/channel/agent "
        "onboarding: passed"
    )
    print(
        "Managed channel initial state: "
        "waiting_for_node"
    )
    print(
        "Idempotent replay and conflict "
        "detection: passed"
    )
    print(
        "Existing account hardcoding: absent"
    )
    print("")
    print(
        "DYNAMIC ONBOARDING FOUNDATION "
        "TEST PASSED"
    )


if __name__ == "__main__":
    main()