import json
import sys
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from uuid import UUID


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    AccountLocked,
    AuthenticatedPrincipal,
    ClientOnboardingResult,
    InvalidAccessToken,
    InvalidCredentials,
    InvalidRefreshToken,
    LoginResult,
    LogoutResult,
    MembershipSelectionRequired,
    RefreshResult,
)
from control_plane.http_api import ControlPlaneAPI  # noqa: E402


ADMIN_KEY = "admin-test-key-with-at-least-32-characters"
SESSION_ID = UUID("00000000-0000-0000-0000-000000000789")
FIXED_NOW = datetime(
    2026,
    8,
    24,
    16,
    0,
    tzinfo=timezone.utc,
)
ACCESS_TOKEN = "ofa_http_api_access_secret"
REFRESH_TOKEN = "ofr_http_api_refresh_secret"
ROTATED_ACCESS_TOKEN = "ofa_http_api_rotated_access_secret"
ROTATED_REFRESH_TOKEN = "ofr_http_api_rotated_refresh_secret"


class FakeOnboardingService:
    def onboard(self, request):
        return ClientOnboardingResult(
            request_id=UUID("00000000-0000-0000-0000-000000000123"),
            client_id=501,
            owner_user_id=9001,
            channel_account_id=101,
            agent_id=UUID("00000000-0000-0000-0000-000000000456"),
            agent_version_id=7001,
        )


class FakeAuthenticationService:
    def __init__(
        self,
        login_error=None,
        authentication_error=None,
        refresh_error=None,
        logout_error=None,
    ):
        self.login_error = login_error
        self.authentication_error = authentication_error
        self.refresh_error = refresh_error
        self.logout_error = logout_error
        self.login_requests = []
        self.refresh_requests = []
        self.logout_requests = []
        self.access_tokens = []

    def login(self, request):
        self.login_requests.append(request)

        if self.login_error is not None:
            raise self.login_error

        return LoginResult(
            session_id=SESSION_ID,
            user_id=9001,
            client_id=501,
            role="owner",
            access_token=ACCESS_TOKEN,
            refresh_token=REFRESH_TOKEN,
            access_expires_at=(
                FIXED_NOW + timedelta(minutes=15)
            ),
            refresh_expires_at=(
                FIXED_NOW + timedelta(days=30)
            ),
        )

    def refresh(self, request):
        self.refresh_requests.append(request)

        if self.refresh_error is not None:
            raise self.refresh_error

        return RefreshResult(
            session_id=SESSION_ID,
            user_id=9001,
            client_id=501,
            role="owner",
            access_token=ROTATED_ACCESS_TOKEN,
            refresh_token=ROTATED_REFRESH_TOKEN,
            access_expires_at=(
                FIXED_NOW + timedelta(minutes=15)
            ),
            refresh_expires_at=(
                FIXED_NOW + timedelta(days=30)
            ),
        )

    def logout(self, request):
        self.logout_requests.append(request)

        if self.logout_error is not None:
            raise self.logout_error

        return LogoutResult(
            session_id=SESSION_ID,
            user_id=9001,
            client_id=501,
            revoked=True,
        )

    def authenticate_access_token(self, token):
        self.access_tokens.append(token)

        if self.authentication_error is not None:
            raise self.authentication_error

        return AuthenticatedPrincipal(
            session_id=SESSION_ID,
            user_id=9001,
            client_id=501,
            role="owner",
            email="owner@example.com",
            display_name="Owner Name",
            access_expires_at=(
                FIXED_NOW + timedelta(minutes=15)
            ),
        )


def call(app, method, path, body=None, bearer=None):
    encoded = (
        b""
        if body is None
        else json.dumps(body).encode("utf-8")
    )
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": str(len(encoded)),
        "wsgi.input": BytesIO(encoded),
        "HTTP_X_REQUEST_ID": "auth-http-test",
    }

    if bearer is not None:
        environ["HTTP_AUTHORIZATION"] = f"Bearer {bearer}"

    response = {}

    def start_response(status, headers):
        response["status"] = status
        response["headers"] = dict(headers)

    raw = b"".join(app(environ, start_response))
    response["json"] = (
        None
        if not raw
        else json.loads(raw.decode("utf-8"))
    )
    return response


def app(authentication):
    return ControlPlaneAPI(
        FakeOnboardingService(),
        ADMIN_KEY,
        authentication_service=authentication,
    )


def verify_login_and_profile():
    authentication = FakeAuthenticationService()
    application = app(authentication)
    password = "Customer-Password-123!"
    login = call(
        application,
        "POST",
        "/api/v1/auth/login",
        {
            "email": "OWNER@EXAMPLE.COM",
            "password": password,
            "client_id": 501,
        },
    )

    assert login["status"] == "200 OK"
    assert login["headers"]["Cache-Control"] == "no-store"
    assert login["json"] == {
        "access_expires_at": (
            FIXED_NOW + timedelta(minutes=15)
        ).isoformat(),
        "access_token": ACCESS_TOKEN,
        "api_version": "v1",
        "client_id": 501,
        "refresh_expires_at": (
            FIXED_NOW + timedelta(days=30)
        ).isoformat(),
        "refresh_token": REFRESH_TOKEN,
        "role": "owner",
        "session_id": str(SESSION_ID),
        "token_type": "Bearer",
        "user_id": 9001,
    }
    request = authentication.login_requests[0]
    assert request.email == "owner@example.com"
    assert request.client_id == 501
    assert password not in repr(request)
    assert password not in json.dumps(login["json"])
    assert ADMIN_KEY not in json.dumps(login["json"])

    me = call(
        application,
        "GET",
        "/api/v1/auth/me",
        bearer=ACCESS_TOKEN,
    )
    assert me["status"] == "200 OK"
    assert authentication.access_tokens == [ACCESS_TOKEN]
    assert me["json"] == {
        "access_expires_at": (
            FIXED_NOW + timedelta(minutes=15)
        ).isoformat(),
        "api_version": "v1",
        "client_id": 501,
        "display_name": "Owner Name",
        "email": "owner@example.com",
        "role": "owner",
        "session_id": str(SESSION_ID),
        "user_id": 9001,
    }

    refreshed = call(
        application,
        "POST",
        "/api/v1/auth/refresh",
        {"refresh_token": REFRESH_TOKEN},
    )
    assert refreshed["status"] == "200 OK"
    assert refreshed["json"]["access_token"] == ROTATED_ACCESS_TOKEN
    assert refreshed["json"]["refresh_token"] == ROTATED_REFRESH_TOKEN
    refresh_request = authentication.refresh_requests[0]
    assert REFRESH_TOKEN not in repr(refresh_request)

    logged_out = call(
        application,
        "POST",
        "/api/v1/auth/logout",
        bearer=ROTATED_ACCESS_TOKEN,
    )
    assert logged_out["status"] == "204 No Content"
    assert logged_out["json"] is None
    assert logged_out["headers"]["Content-Length"] == "0"
    assert ROTATED_ACCESS_TOKEN not in repr(
        authentication.logout_requests[0]
    )


def verify_safe_auth_errors():
    missing = call(
        app(FakeAuthenticationService()),
        "GET",
        "/api/v1/auth/me",
    )
    assert missing["status"] == "401 Unauthorized"
    assert missing["json"]["error"]["code"] == "invalid_access_token"

    invalid = call(
        app(
            FakeAuthenticationService(
                authentication_error=InvalidAccessToken(
                    "database secret detail"
                )
            )
        ),
        "GET",
        "/api/v1/auth/me",
        bearer="invalid-token",
    )
    assert invalid["status"] == "401 Unauthorized"
    assert "database secret detail" not in json.dumps(invalid["json"])

    cases = (
        (
            InvalidCredentials("private detail"),
            "401 Unauthorized",
            "invalid_credentials",
        ),
        (
            AccountLocked("private detail"),
            "423 Locked",
            "account_locked",
        ),
        (
            MembershipSelectionRequired("private detail"),
            "409 Conflict",
            "client_selection_required",
        ),
    )

    for error, status, code in cases:
        response = call(
            app(
                FakeAuthenticationService(
                    login_error=error
                )
            ),
            "POST",
            "/api/v1/auth/login",
            {
                "email": "owner@example.com",
                "password": "Customer-Password-123!",
            },
        )
        assert response["status"] == status
        assert response["json"]["error"]["code"] == code
        assert "private detail" not in json.dumps(response["json"])

    refresh = call(
        app(
            FakeAuthenticationService(
                refresh_error=InvalidRefreshToken("private detail")
            )
        ),
        "POST",
        "/api/v1/auth/refresh",
        {"refresh_token": "replayed-refresh-token"},
    )
    assert refresh["status"] == "401 Unauthorized"
    assert refresh["json"]["error"]["code"] == "invalid_refresh_token"
    assert "private detail" not in json.dumps(refresh["json"])

    logout = call(
        app(
            FakeAuthenticationService(
                logout_error=InvalidAccessToken("private detail")
            )
        ),
        "POST",
        "/api/v1/auth/logout",
        bearer="invalid-access-token",
    )
    assert logout["status"] == "401 Unauthorized"
    assert logout["json"]["error"]["code"] == "invalid_access_token"
    assert "private detail" not in json.dumps(logout["json"])


def verify_validation_and_runtime_isolation():
    application = app(FakeAuthenticationService())
    unknown = call(
        application,
        "POST",
        "/api/v1/auth/login",
        {
            "email": "owner@example.com",
            "password": "Customer-Password-123!",
            "is_admin": True,
        },
    )
    assert unknown["status"] == "400 Bad Request"

    wrong_method = call(
        application,
        "GET",
        "/api/v1/auth/login",
    )
    assert wrong_method["status"] == "405 Method Not Allowed"

    bad_refresh = call(
        application,
        "POST",
        "/api/v1/auth/refresh",
        {
            "refresh_token": REFRESH_TOKEN,
            "client_id": 501,
        },
    )
    assert bad_refresh["status"] == "400 Bad Request"

    for path in (
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
    ):
        wrong = call(application, "GET", path)
        assert wrong["status"] == "405 Method Not Allowed"

    source = (
        SRC_DIR
        / "control_plane"
        / "http_api.py"
    ).read_text(encoding="utf-8").lower()
    assert "playwright" not in source
    assert "whatsapp_sessions" not in source
    assert "client_id = 1" not in source
    assert "channel_account_id = 1" not in source


def main():
    verify_login_and_profile()
    verify_safe_auth_errors()
    verify_validation_and_runtime_isolation()

    print("Customer password-login endpoint: passed")
    print("Access/refresh token response: passed")
    print("Replay-safe refresh endpoint: passed")
    print("Logout revocation endpoint: passed")
    print("Authenticated customer profile endpoint: passed")
    print("Invalid/expired token handling: passed")
    print("Lockout and client-selection mapping: passed")
    print("Password/internal-error response suppression: passed")
    print("Strict login field and method validation: passed")
    print("Browser and WhatsApp side effects: absent")
    print("Existing account hardcoding: absent")
    print("\nCUSTOMER AUTH HTTP API TEST PASSED")


if __name__ == "__main__":
    main()
