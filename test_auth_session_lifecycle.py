import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"
MIGRATION = (
    PROJECT_ROOT
    / "migrations"
    / "006_refresh_token_rotation.sql"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    ACCESS_TOKEN_TTL,
    InvalidAccessToken,
    InvalidRefreshToken,
    LogoutRequest,
    PlatformAuthenticationService,
    RefreshRequest,
    RefreshTokenReplayDetected,
)


FIXED_NOW = datetime(
    2026,
    8,
    24,
    17,
    0,
    tzinfo=timezone.utc,
)
SESSION_ID = UUID("00000000-0000-0000-0000-000000000888")
OLD_ACCESS = "ofa_lifecycle_old_access_secret"
OLD_REFRESH = "ofr_lifecycle_old_refresh_secret"
NEW_ACCESS = "ofa_lifecycle_new_access_secret"
NEW_REFRESH = "ofr_lifecycle_new_refresh_secret"
REFRESH_EXPIRES = FIXED_NOW + timedelta(days=30)


class ScriptedCursor:
    def __init__(self, connection):
        self.connection = connection
        self.one = None
        self.many = []

    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        return False

    def execute(self, query, parameters=None):
        self.connection.executions.append(
            (query, tuple(parameters or ()))
        )

        if not self.connection.script:
            raise AssertionError("Unexpected session lifecycle query")

        response = self.connection.script.pop(0)

        if "error" in response:
            raise response["error"]

        self.one = response.get("one")
        self.many = list(response.get("many", []))

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


def expect_error(error_type, callback):
    try:
        callback()
    except error_type:
        return

    raise AssertionError(f"Expected {error_type.__name__}")


def service(connection):
    return PlatformAuthenticationService(
        lambda: connection,
        password_verifier=lambda password, encoded: False,
        clock=lambda: FIXED_NOW,
        access_token_factory=lambda: NEW_ACCESS,
        refresh_token_factory=lambda: NEW_REFRESH,
        dummy_password_hash="unused-dummy-hash",
    )


def current_row(
    status="active",
    refresh_expires_at=REFRESH_EXPIRES,
    user_status="active",
    membership_status="active",
):
    return (
        str(SESSION_ID),
        9001,
        501,
        status,
        PlatformAuthenticationService.token_hash(OLD_ACCESS),
        refresh_expires_at,
        user_status,
        "owner",
        membership_status,
    )


def verify_migration_contract():
    sql = MIGRATION.read_text(encoding="utf-8")

    def require(pattern, label):
        assert re.search(
            pattern,
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        ), label

    require(
        r"create\s+table\s+if\s+not\s+exists\s+"
        r"platform_refresh_token_history\b",
        "Refresh-token history table is missing",
    )
    require(
        r"unique\s*\(\s*id\s*,\s*user_id\s*,\s*client_id\s*\)",
        "Session identity tuple is not unique",
    )
    require(
        r"foreign\s+key\s*\(\s*session_id\s*,\s*user_id\s*,\s*client_id\s*\)\s*"
        r"references\s+platform_user_sessions\s*"
        r"\(\s*id\s*,\s*user_id\s*,\s*client_id\s*\)",
        "Tenant-bound session history foreign key is missing",
    )
    require(
        r"unique\s*\(\s*token_hash\s*\)",
        "Consumed token digest uniqueness is missing",
    )
    require(
        r"expires_at\s*>\s*consumed_at",
        "Consumed token expiry check is missing",
    )
    lowered = sql.lower()
    assert "refresh_token text" not in lowered
    assert "access_token text" not in lowered
    assert "client_id = 1" not in lowered
    assert re.search(r"\A\s*begin\s*;", sql, re.IGNORECASE)
    assert re.search(r"commit\s*;\s*\Z", sql, re.IGNORECASE)


def verify_refresh_rotation():
    connection = ScriptedConnection([
        {"one": current_row()},
        {},
        {},
        {},
    ])
    request = RefreshRequest(
        refresh_token=OLD_REFRESH,
        metadata={"source": "unit_test"},
    )
    result = service(connection).refresh(request)

    assert result.session_id == SESSION_ID
    assert result.user_id == 9001
    assert result.client_id == 501
    assert result.role == "owner"
    assert result.access_token == NEW_ACCESS
    assert result.refresh_token == NEW_REFRESH
    assert result.access_expires_at == FIXED_NOW + ACCESS_TOKEN_TTL
    assert result.refresh_expires_at == REFRESH_EXPIRES
    assert OLD_REFRESH not in repr(request)
    assert NEW_ACCESS not in repr(result)
    assert NEW_REFRESH not in repr(result)
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1
    assert not connection.script

    rendered = repr(connection.executions)
    assert OLD_ACCESS not in rendered
    assert OLD_REFRESH not in rendered
    assert NEW_ACCESS not in rendered
    assert NEW_REFRESH not in rendered
    assert PlatformAuthenticationService.token_hash(OLD_REFRESH) in rendered
    assert PlatformAuthenticationService.token_hash(NEW_ACCESS) in rendered
    assert PlatformAuthenticationService.token_hash(NEW_REFRESH) in rendered

    queries = " ".join(
        " ".join(query.lower().split())
        for query, _ in connection.executions
    )
    assert "for update of session" in queries
    assert "insert into platform_refresh_token_history" in queries
    assert "auth_method = 'refresh_token'" in queries
    assert "'user.session_refreshed'" in queries


def verify_replay_revokes_session():
    connection = ScriptedConnection([
        {"one": None},
        {
            "one": (
                str(SESSION_ID),
                9001,
                501,
                REFRESH_EXPIRES,
                "active",
            )
        },
        {},
        {},
    ])
    request = RefreshRequest(refresh_token=OLD_REFRESH)
    expect_error(
        RefreshTokenReplayDetected,
        lambda: service(connection).refresh(request),
    )

    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1
    queries = " ".join(
        " ".join(query.lower().split())
        for query, _ in connection.executions
    )
    assert "platform_refresh_token_history history" in queries
    assert "status = 'revoked'" in queries
    assert "'user.session_refresh_replay_detected'" in queries

    unknown = ScriptedConnection([
        {"one": None},
        {"one": None},
    ])
    expect_error(
        InvalidRefreshToken,
        lambda: service(unknown).refresh(
            RefreshRequest(refresh_token="unknown-refresh-token")
        ),
    )
    assert unknown.commits == 0
    assert unknown.rollbacks == 1


def verify_expired_refresh_is_terminal():
    connection = ScriptedConnection([
        {"one": current_row(refresh_expires_at=FIXED_NOW)},
        {},
        {},
    ])
    expect_error(
        InvalidRefreshToken,
        lambda: service(connection).refresh(
            RefreshRequest(refresh_token=OLD_REFRESH)
        ),
    )

    assert connection.commits == 1
    assert connection.rollbacks == 0
    queries = " ".join(
        " ".join(query.lower().split())
        for query, _ in connection.executions
    )
    assert "status = 'expired'" in queries
    assert "'user.session_expired'" in queries


def verify_logout_revocation():
    connection = ScriptedConnection([
        {
            "one": (
                str(SESSION_ID),
                9001,
                501,
                "active",
            )
        },
        {},
        {},
    ])
    request = LogoutRequest(
        access_token=NEW_ACCESS,
        metadata={"source": "unit_test"},
    )
    result = service(connection).logout(request)

    assert result.session_id == SESSION_ID
    assert result.user_id == 9001
    assert result.client_id == 501
    assert result.revoked is True
    assert NEW_ACCESS not in repr(request)
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert connection.closes == 1
    assert NEW_ACCESS not in repr(connection.executions)
    assert PlatformAuthenticationService.token_hash(NEW_ACCESS) in repr(
        connection.executions
    )
    queries = " ".join(
        " ".join(query.lower().split())
        for query, _ in connection.executions
    )
    assert "status = 'revoked'" in queries
    assert "'user.logged_out'" in queries

    repeated = ScriptedConnection([
        {
            "one": (
                str(SESSION_ID),
                9001,
                501,
                "revoked",
            )
        },
    ])
    repeated_result = service(repeated).logout(request)
    assert repeated_result.revoked is False
    assert repeated.commits == 0
    assert repeated.rollbacks == 1

    unknown = ScriptedConnection([{"one": None}])
    expect_error(
        InvalidAccessToken,
        lambda: service(unknown).logout(
            LogoutRequest(access_token="unknown-access-token")
        ),
    )
    assert unknown.commits == 0
    assert unknown.rollbacks == 1


def verify_no_runtime_or_tenant_hardcoding():
    source = (
        SRC_DIR
        / "control_plane"
        / "auth.py"
    ).read_text(encoding="utf-8").lower()
    assert "playwright" not in source
    assert "whatsapp_sessions" not in source
    assert "client_id = 1" not in source
    assert "channel_account_id = 1" not in source


def main():
    verify_migration_contract()
    verify_refresh_rotation()
    verify_replay_revokes_session()
    verify_expired_refresh_is_terminal()
    verify_logout_revocation()
    verify_no_runtime_or_tenant_hardcoding()

    print("Refresh history migration contract: passed")
    print("Atomic access/refresh token rotation: passed")
    print("Consumed refresh-token digest persistence: passed")
    print("Refresh replay detection and family revocation: passed")
    print("Expired refresh session transition: passed")
    print("Logout session revocation and audit: passed")
    print("Raw access/refresh token SQL persistence: absent")
    print("Browser and WhatsApp side effects: absent")
    print("Existing account hardcoding: absent")
    print("\nAUTH SESSION LIFECYCLE TEST PASSED")


if __name__ == "__main__":
    main()
