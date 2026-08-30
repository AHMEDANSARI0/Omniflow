import re
import sys
from datetime import (
    datetime,
    timedelta,
    timezone,
)
from pathlib import Path
from uuid import UUID


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

MIGRATION = (
    PROJECT_ROOT
    / "migrations"
    / "005_platform_auth_sessions.sql"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane.auth import (  # noqa: E402
    ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL,
    AccountLocked,
    AuthenticatedPrincipal,
    InvalidAccessToken,
    InvalidCredentials,
    LoginRequest,
    MembershipSelectionRequired,
    PlatformAuthenticationService,
)


FIXED_NOW = datetime(
    2026,
    8,
    24,
    12,
    0,
    tzinfo=timezone.utc,
)

ACCESS_TOKEN = (
    "ofa_test_access_token_secret"
)

REFRESH_TOKEN = (
    "ofr_test_refresh_token_secret"
)


class ScriptedCursor:
    def __init__(self, connection):
        self.connection = connection
        self.one = None
        self.many = []

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
        parameters=None,
    ):
        self.connection.executions.append(
            (
                query,
                tuple(parameters or ()),
            )
        )

        if not self.connection.script:
            raise AssertionError(
                "Unexpected authentication query"
            )

        response = (
            self.connection.script.pop(0)
        )

        if "error" in response:
            raise response["error"]

        self.one = response.get("one")
        self.many = list(
            response.get("many", [])
        )

    def fetchone(self):
        value = self.one
        self.one = None
        return value

    def fetchall(self):
        values = self.many
        self.many = []
        return values


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


def password_verifier(
    password,
    encoded,
):
    return (
        password
        == "Correct-Password-123!"
        and encoded == "stored-hash"
    )


def service(connection):
    return PlatformAuthenticationService(
        lambda: connection,
        password_verifier=(
            password_verifier
        ),
        clock=lambda: FIXED_NOW,
        access_token_factory=(
            lambda: ACCESS_TOKEN
        ),
        refresh_token_factory=(
            lambda: REFRESH_TOKEN
        ),
        dummy_password_hash=(
            "dummy-hash"
        ),
    )


def user_row(
    failed_attempts=0,
    locked_until=None,
    status="active",
):
    return (
        9001,
        "owner@example.com",
        "Owner Name",
        status,
        "stored-hash",
        failed_attempts,
        locked_until,
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

        assert match, label

    require(
        r"create\s+table\s+if\s+"
        r"not\s+exists\s+"
        r"platform_user_sessions\b",
        "Session table is missing",
    )

    require(
        r"foreign\s+key\s*"
        r"\(\s*client_id\s*,"
        r"\s*user_id\s*\)\s*"
        r"references\s+"
        r"client_memberships\s*"
        r"\(\s*client_id\s*,"
        r"\s*user_id\s*\)",
        (
            "Composite membership tenant "
            "foreign key is missing"
        ),
    )

    require(
        r"unique\s*\(\s*"
        r"access_token_hash\s*\)",
        (
            "Access-token digest "
            "uniqueness is missing"
        ),
    )

    require(
        r"unique\s*\(\s*"
        r"refresh_token_hash\s*\)",
        (
            "Refresh-token digest "
            "uniqueness is missing"
        ),
    )

    require(
        r"access_expires_at\s*>\s*"
        r"issued_at",
        "Access expiry check is missing",
    )

    require(
        r"refresh_expires_at\s*>\s*"
        r"access_expires_at",
        "Refresh expiry check is missing",
    )

    lowered = sql.lower()

    assert (
        "access_token text"
        not in lowered
    )

    assert (
        "refresh_token text"
        not in lowered
    )

    assert "password text" not in lowered
    assert "client_id = 1" not in lowered

    assert (
        "channel_account_id = 1"
        not in lowered
    )

    assert re.search(
        r"\A\s*begin\s*;",
        sql,
        re.IGNORECASE,
    )

    assert re.search(
        r"commit\s*;\s*\Z",
        sql,
        re.IGNORECASE,
    )


def verify_login_success():
    connection = ScriptedConnection([
        {
            "one": user_row()
        },
        {
            "many": [
                (
                    77,
                    501,
                    "owner",
                    "active",
                )
            ]
        },
        {},
        {},
        {},
        {},
    ])

    request = LoginRequest(
        email="OWNER@EXAMPLE.COM",
        password=(
            "Correct-Password-123!"
        ),
        metadata={
            "user_agent_hash":
                "safe-hash",
        },
    )

    result = service(
        connection
    ).login(request)

    assert result.user_id == 9001
    assert result.client_id == 501
    assert result.role == "owner"

    assert (
        result.access_token
        == ACCESS_TOKEN
    )

    assert (
        result.refresh_token
        == REFRESH_TOKEN
    )

    assert (
        result.access_expires_at
        == FIXED_NOW + ACCESS_TOKEN_TTL
    )

    assert (
        result.refresh_expires_at
        == FIXED_NOW + REFRESH_TOKEN_TTL
    )

    assert isinstance(
        result.session_id,
        UUID,
    )

    assert ACCESS_TOKEN not in repr(result)
    assert REFRESH_TOKEN not in repr(result)

    assert (
        request.password
        not in repr(request)
    )

    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1
    assert not connection.script

    recorded = repr(
        connection.executions
    )

    assert ACCESS_TOKEN not in recorded
    assert REFRESH_TOKEN not in recorded

    access_hash = (
        PlatformAuthenticationService
        .token_hash(ACCESS_TOKEN)
    )

    refresh_hash = (
        PlatformAuthenticationService
        .token_hash(REFRESH_TOKEN)
    )

    assert access_hash in recorded
    assert refresh_hash in recorded

    queries = " ".join(
        " ".join(
            query.lower().split()
        )
        for query, _
        in connection.executions
    )

    assert (
        "for update of user_account, "
        "credential"
        in queries
    )

    assert (
        "insert into "
        "platform_user_sessions"
        in queries
    )

    assert (
        "insert into "
        "control_plane_audit_log"
        in queries
    )

    assert "'user.logged_in'" in queries


def verify_invalid_unknown_and_locked():
    invalid_connection = (
        ScriptedConnection([
            {
                "one": user_row(
                    failed_attempts=4
                )
            },
            {},
        ])
    )

    invalid_request = LoginRequest(
        email="owner@example.com",
        password=(
            "Wrong-Password-123!"
        ),
    )

    expect_error(
        InvalidCredentials,
        lambda: service(
            invalid_connection
        ).login(invalid_request),
    )

    assert (
        invalid_connection.commits == 1
    )

    assert (
        invalid_connection.rollbacks == 0
    )

    update_parameters = (
        invalid_connection
        .executions[1][1]
    )

    assert update_parameters[0] == 5

    assert (
        update_parameters[1]
        == FIXED_NOW
        + timedelta(minutes=15)
    )

    unknown_connection = (
        ScriptedConnection([
            {"one": None},
        ])
    )

    expect_error(
        InvalidCredentials,
        lambda: service(
            unknown_connection
        ).login(invalid_request),
    )

    assert (
        unknown_connection.commits == 0
    )

    assert (
        unknown_connection.rollbacks == 1
    )

    locked_connection = (
        ScriptedConnection([
            {
                "one": user_row(
                    failed_attempts=5,
                    locked_until=(
                        FIXED_NOW
                        + timedelta(
                            minutes=5
                        )
                    ),
                )
            },
        ])
    )

    expect_error(
        AccountLocked,
        lambda: service(
            locked_connection
        ).login(invalid_request),
    )

    assert (
        locked_connection.rollbacks == 1
    )


def verify_membership_selection():
    connection = ScriptedConnection([
        {
            "one": user_row()
        },
        {
            "many": [
                (
                    77,
                    501,
                    "owner",
                    "active",
                ),
                (
                    78,
                    502,
                    "admin",
                    "active",
                ),
            ]
        },
    ])

    request = LoginRequest(
        email="owner@example.com",
        password=(
            "Correct-Password-123!"
        ),
    )

    expect_error(
        MembershipSelectionRequired,
        lambda: service(
            connection
        ).login(request),
    )

    assert connection.rollbacks == 1


def verify_access_authentication():
    session_id = UUID(
        "00000000-0000-0000-"
        "0000-000000000777"
    )

    connection = ScriptedConnection([
        {
            "one": (
                str(session_id),
                9001,
                501,
                "active",
                (
                    FIXED_NOW
                    + timedelta(
                        minutes=10
                    )
                ),
                "owner@example.com",
                "Owner Name",
                "active",
                "owner",
                "active",
            )
        },
        {},
    ])

    principal = service(
        connection
    ).authenticate_access_token(
        ACCESS_TOKEN
    )

    assert isinstance(
        principal,
        AuthenticatedPrincipal,
    )

    assert (
        principal.session_id
        == session_id
    )

    assert principal.user_id == 9001
    assert principal.client_id == 501
    assert principal.role == "owner"
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1

    assert (
        ACCESS_TOKEN
        not in repr(
            connection.executions
        )
    )

    expired_connection = (
        ScriptedConnection([
            {
                "one": (
                    str(session_id),
                    9001,
                    501,
                    "active",
                    (
                        FIXED_NOW
                        - timedelta(
                            seconds=1
                        )
                    ),
                    "owner@example.com",
                    "Owner Name",
                    "active",
                    "owner",
                    "active",
                )
            },
        ])
    )

    expect_error(
        InvalidAccessToken,
        lambda: service(
            expired_connection
        ).authenticate_access_token(
            ACCESS_TOKEN
        ),
    )

    assert (
        expired_connection.commits == 0
    )

    assert (
        expired_connection.rollbacks == 1
    )


def verify_no_secret_or_runtime_coupling():
    source = (
        PROJECT_ROOT
        / "src"
        / "control_plane"
        / "auth.py"
    ).read_text(
        encoding="utf-8"
    )

    lowered = source.lower()

    assert "playwright" not in lowered

    assert (
        "whatsapp_sessions"
        not in lowered
    )

    assert "client_id = 1" not in lowered

    assert (
        "channel_account_id = 1"
        not in lowered
    )

    session_insert = re.search(
        r"insert\s+into\s+"
        r"platform_user_sessions\s*"
        r"\((?P<columns>.*?)\)"
        r"\s*values",
        source,
        flags=(
            re.IGNORECASE
            | re.DOTALL
        ),
    )

    assert session_insert is not None, (
        "Session INSERT statement "
        "was not found"
    )

    columns = {
        column.strip().lower()
        for column
        in session_insert.group(
            "columns"
        ).split(",")
    }

    assert "access_token_hash" in columns
    assert "refresh_token_hash" in columns
    assert "access_token" not in columns
    assert "refresh_token" not in columns


def main():
    verify_migration_contract()
    verify_login_success()
    verify_invalid_unknown_and_locked()
    verify_membership_selection()
    verify_access_authentication()
    verify_no_secret_or_runtime_coupling()

    print(
        "Opaque session schema: passed"
    )
    print(
        "Composite membership tenant "
        "isolation: passed"
    )
    print(
        "Access/refresh token digest-only "
        "persistence: passed"
    )
    print(
        "Password login and session "
        "issuance: passed"
    )
    print(
        "Failed-attempt lockout threshold: "
        "passed"
    )
    print(
        "Unknown-user timing verification "
        "path: passed"
    )
    print(
        "Multi-membership client selection: "
        "passed"
    )
    print(
        "Access-token authentication and "
        "expiry: passed"
    )
    print(
        "Raw password/token repr and SQL "
        "persistence: absent"
    )
    print(
        "Browser and WhatsApp side "
        "effects: absent"
    )
    print(
        "Existing account hardcoding: absent"
    )
    print("")
    print(
        "PLATFORM AUTH FOUNDATION "
        "TEST PASSED"
    )


if __name__ == "__main__":
    main()
