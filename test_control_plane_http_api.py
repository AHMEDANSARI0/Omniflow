import json
import sys
from dataclasses import replace
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
    OnboardingConflict,
    RefreshResult,
)
from control_plane.http_api import (  # noqa: E402
    APIConfigurationError,
    ControlPlaneAPI,
)


ADMIN_KEY = "admin-test-key-with-at-least-32-characters"
REQUEST_ID = UUID("00000000-0000-0000-0000-000000000123")
AGENT_ID = UUID("00000000-0000-0000-0000-000000000456")
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
    def __init__(self, result=None, error=None):
        self.result = result or ClientOnboardingResult(
            request_id=REQUEST_ID,
            client_id=501,
            owner_user_id=9001,
            channel_account_id=101,
            agent_id=AGENT_ID,
            agent_version_id=7001,
        )
        self.error = error
        self.requests = []

    def onboard(self, request):
        self.requests.append(request)

        if self.error is not None:
            raise self.error

        return self.result


class FakeAuthenticationService:
    def __init__(
        self,
        login_result=None,
        principal=None,
        login_error=None,
        authentication_error=None,
        refresh_error=None,
        logout_error=None,
    ):
        self.login_result = login_result or LoginResult(
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
        self.principal = principal or AuthenticatedPrincipal(
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

        return self.login_result

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

        return self.principal


def payload(password="Correct-Horse-123!"):
    return {
        "business_name": "API Test Business",
        "owner_name": "API Test Owner",
        "owner_email": "OWNER@EXAMPLE.COM",
        "owner_phone": "+923001234567",
        "password": password,
        "channel_name": "API Test WhatsApp",
        "platform": "whatsapp",
        "agent_name": "API Test Agent",
        "agent_instruction": (
            "Answer accurately using verified business information."
        ),
        "business_profile": {
            "industry": "services",
            "timezone": "Asia/Karachi",
        },
        "language_policy": {
            "english": "english",
            "urdu": "pakistani_roman_urdu",
        },
        "trial": {
            "days": 7,
            "max_channel_accounts": 1,
            "max_managed_sessions": 1,
            "max_inbound_messages": 100,
            "max_ai_calls": 100,
            "max_outbound_messages": 100,
        },
    }


def request(
    app,
    method,
    path,
    body=None,
    authorized=False,
    bearer_token=None,
    idempotency_key="api:test:1",
    content_type="application/json",
    content_length=None,
):
    encoded = (
        b""
        if body is None
        else (
            body
            if isinstance(body, bytes)
            else json.dumps(body).encode("utf-8")
        )
    )
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_TYPE": content_type,
        "CONTENT_LENGTH": str(
            len(encoded)
            if content_length is None
            else content_length
        ),
        "wsgi.input": BytesIO(encoded),
        "REMOTE_ADDR": "127.0.0.1",
        "HTTP_X_REQUEST_ID": "test-request-123",
    }

    if bearer_token is not None:
        environ["HTTP_AUTHORIZATION"] = f"Bearer {bearer_token}"
    elif authorized:
        environ["HTTP_AUTHORIZATION"] = f"Bearer {ADMIN_KEY}"

    if idempotency_key is not None:
        environ["HTTP_IDEMPOTENCY_KEY"] = idempotency_key

    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    chunks = app(environ, start_response)
    raw = b"".join(chunks)
    captured["json"] = (
        None
        if not raw
        else json.loads(raw.decode("utf-8"))
    )
    return captured


def expect_status(response, expected):
    assert response["status"] == expected, response
    assert response["headers"]["Cache-Control"] == "no-store"
    assert response["headers"]["X-Content-Type-Options"] == "nosniff"
    assert response["headers"]["X-Frame-Options"] == "DENY"
    assert response["headers"]["X-Request-ID"] == "test-request-123"


def verify_configuration_gate():
    service = FakeOnboardingService()

    try:
        ControlPlaneAPI(service, "short")
    except APIConfigurationError:
        pass
    else:
        raise AssertionError("Short administrator key was accepted")


def verify_health_and_routing():
    service = FakeOnboardingService()
    app = ControlPlaneAPI(service, ADMIN_KEY)

    health = request(
        app,
        "GET",
        "/api/v1/health",
        idempotency_key=None,
    )
    expect_status(health, "200 OK")
    assert health["json"] == {
        "api_version": "v1",
        "service": "omniflow-control-plane",
        "status": "ok",
    }

    missing = request(
        app,
        "GET",
        "/api/v1/missing",
        idempotency_key=None,
    )
    expect_status(missing, "404 Not Found")

    wrong_method = request(
        app,
        "GET",
        "/api/v1/admin/onboarding",
        idempotency_key=None,
    )
    expect_status(wrong_method, "405 Method Not Allowed")
    assert not service.requests


def verify_authentication_and_validation():
    service = FakeOnboardingService()
    app = ControlPlaneAPI(service, ADMIN_KEY)

    unauthorized = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
    )
    expect_status(unauthorized, "401 Unauthorized")
    assert not service.requests

    wrong_type = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
        authorized=True,
        content_type="text/plain",
    )
    expect_status(wrong_type, "415 Unsupported Media Type")

    invalid_json = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        b"{invalid",
        authorized=True,
    )
    expect_status(invalid_json, "400 Bad Request")

    missing_key = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
        authorized=True,
        idempotency_key=None,
    )
    expect_status(missing_key, "400 Bad Request")
    assert (
        missing_key["json"]["error"]["code"]
        == "idempotency_key_required"
    )

    unknown = payload()
    unknown["client_id"] = 1
    unknown_response = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        unknown,
        authorized=True,
    )
    expect_status(unknown_response, "400 Bad Request")

    disabled = payload()
    disabled["platform"] = "instagram"
    disabled_response = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        disabled,
        authorized=True,
    )
    expect_status(disabled_response, "400 Bad Request")
    assert (
        disabled_response["json"]["error"]["code"]
        == "platform_not_enabled"
    )

    oversized = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
        authorized=True,
        content_length=70 * 1024,
    )
    expect_status(oversized, "413 Payload Too Large")
    assert not service.requests


def verify_success_and_secret_suppression():
    password = "Correct-Horse-123!"
    service = FakeOnboardingService()
    app = ControlPlaneAPI(service, ADMIN_KEY)
    response = request(
        app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(password),
        authorized=True,
        idempotency_key="api:create:501",
    )
    expect_status(response, "201 Created")
    assert len(service.requests) == 1

    onboarding_request = service.requests[0]
    assert onboarding_request.idempotency_key == "api:create:501"
    assert onboarding_request.owner_email == "owner@example.com"
    assert onboarding_request.platform == "whatsapp"
    assert onboarding_request.trial.max_ai_calls == 100
    assert password not in repr(onboarding_request)
    assert password not in json.dumps(response["json"])
    assert ADMIN_KEY not in json.dumps(response["json"])

    assert response["json"] == {
        "agent_id": str(AGENT_ID),
        "agent_version_id": 7001,
        "api_version": "v1",
        "channel_account_id": 101,
        "client_id": 501,
        "connection_status": "waiting_for_node",
        "idempotent_replay": False,
        "owner_user_id": 9001,
        "request_id": str(REQUEST_ID),
    }

    replay_service = FakeOnboardingService(
        result=replace(
            service.result,
            idempotent_replay=True,
        )
    )
    replay_app = ControlPlaneAPI(replay_service, ADMIN_KEY)
    replay = request(
        replay_app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(password),
        authorized=True,
        idempotency_key="api:create:501",
    )
    expect_status(replay, "200 OK")
    assert replay["json"]["idempotent_replay"] is True


def verify_customer_auth_endpoints():
    onboarding = FakeOnboardingService()
    authentication = FakeAuthenticationService()
    app = ControlPlaneAPI(
        onboarding,
        ADMIN_KEY,
        authentication_service=authentication,
    )
    password = "Customer-Password-123!"
    login = request(
        app,
        "POST",
        "/api/v1/auth/login",
        {
            "email": "OWNER@EXAMPLE.COM",
            "password": password,
            "client_id": 501,
        },
        idempotency_key=None,
    )
    expect_status(login, "200 OK")
    assert len(authentication.login_requests) == 1
    login_request = authentication.login_requests[0]
    assert login_request.email == "owner@example.com"
    assert login_request.client_id == 501
    assert password not in repr(login_request)
    assert password not in json.dumps(login["json"])
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

    me = request(
        app,
        "GET",
        "/api/v1/auth/me",
        bearer_token=ACCESS_TOKEN,
        idempotency_key=None,
    )
    expect_status(me, "200 OK")
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

    refreshed = request(
        app,
        "POST",
        "/api/v1/auth/refresh",
        {"refresh_token": REFRESH_TOKEN},
        idempotency_key=None,
    )
    expect_status(refreshed, "200 OK")
    assert refreshed["json"]["access_token"] == ROTATED_ACCESS_TOKEN
    assert refreshed["json"]["refresh_token"] == ROTATED_REFRESH_TOKEN
    assert REFRESH_TOKEN not in repr(authentication.refresh_requests[0])

    logged_out = request(
        app,
        "POST",
        "/api/v1/auth/logout",
        bearer_token=ROTATED_ACCESS_TOKEN,
        idempotency_key=None,
    )
    expect_status(logged_out, "204 No Content")
    assert logged_out["json"] is None
    assert logged_out["headers"]["Content-Length"] == "0"
    assert ROTATED_ACCESS_TOKEN not in repr(
        authentication.logout_requests[0]
    )

    missing_token = request(
        app,
        "GET",
        "/api/v1/auth/me",
        idempotency_key=None,
    )
    expect_status(missing_token, "401 Unauthorized")

    invalid_app = ControlPlaneAPI(
        onboarding,
        ADMIN_KEY,
        authentication_service=FakeAuthenticationService(
            authentication_error=InvalidAccessToken("secret detail")
        ),
    )
    invalid = request(
        invalid_app,
        "GET",
        "/api/v1/auth/me",
        bearer_token="invalid-token",
        idempotency_key=None,
    )
    expect_status(invalid, "401 Unauthorized")
    assert "secret detail" not in json.dumps(invalid["json"])

    invalid_refresh_app = ControlPlaneAPI(
        onboarding,
        ADMIN_KEY,
        authentication_service=FakeAuthenticationService(
            refresh_error=InvalidRefreshToken("secret detail")
        ),
    )
    invalid_refresh = request(
        invalid_refresh_app,
        "POST",
        "/api/v1/auth/refresh",
        {"refresh_token": "replayed-refresh-token"},
        idempotency_key=None,
    )
    expect_status(invalid_refresh, "401 Unauthorized")
    assert (
        invalid_refresh["json"]["error"]["code"]
        == "invalid_refresh_token"
    )
    assert "secret detail" not in json.dumps(invalid_refresh["json"])

    invalid_logout_app = ControlPlaneAPI(
        onboarding,
        ADMIN_KEY,
        authentication_service=FakeAuthenticationService(
            logout_error=InvalidAccessToken("secret detail")
        ),
    )
    invalid_logout = request(
        invalid_logout_app,
        "POST",
        "/api/v1/auth/logout",
        bearer_token="invalid-access-token",
        idempotency_key=None,
    )
    expect_status(invalid_logout, "401 Unauthorized")
    assert "secret detail" not in json.dumps(invalid_logout["json"])

    for error, status, code in (
        (InvalidCredentials("detail"), "401 Unauthorized", "invalid_credentials"),
        (AccountLocked("detail"), "423 Locked", "account_locked"),
        (
            MembershipSelectionRequired("detail"),
            "409 Conflict",
            "client_selection_required",
        ),
    ):
        error_app = ControlPlaneAPI(
            onboarding,
            ADMIN_KEY,
            authentication_service=FakeAuthenticationService(
                login_error=error
            ),
        )
        response = request(
            error_app,
            "POST",
            "/api/v1/auth/login",
            {
                "email": "owner@example.com",
                "password": password,
            },
            idempotency_key=None,
        )
        expect_status(response, status)
        assert response["json"]["error"]["code"] == code
        assert "detail" not in json.dumps(response["json"])


def verify_safe_error_mapping():
    conflict_service = FakeOnboardingService(
        error=OnboardingConflict("idempotency conflict")
    )
    conflict_app = ControlPlaneAPI(conflict_service, ADMIN_KEY)
    conflict = request(
        conflict_app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
        authorized=True,
    )
    expect_status(conflict, "409 Conflict")
    assert conflict["json"]["error"]["code"] == "onboarding_conflict"

    internal_service = FakeOnboardingService(
        error=RuntimeError("database-password-secret")
    )
    internal_app = ControlPlaneAPI(internal_service, ADMIN_KEY)
    internal = request(
        internal_app,
        "POST",
        "/api/v1/admin/onboarding",
        payload(),
        authorized=True,
    )
    expect_status(internal, "500 Internal Server Error")
    rendered = json.dumps(internal["json"])
    assert "database-password-secret" not in rendered
    assert ADMIN_KEY not in rendered


def verify_no_runtime_side_effects():
    source = (
        PROJECT_ROOT
        / "src"
        / "control_plane"
        / "http_api.py"
    ).read_text(encoding="utf-8").lower()
    assert "playwright" not in source
    assert "whatsapp_sessions" not in source
    assert "client_id = 1" not in source
    assert "channel_account_id = 1" not in source


def main():
    verify_configuration_gate()
    verify_health_and_routing()
    verify_authentication_and_validation()
    verify_success_and_secret_suppression()
    verify_customer_auth_endpoints()
    verify_safe_error_mapping()
    verify_no_runtime_side_effects()

    print("API v1 health and routing: passed")
    print("Administrator bearer authentication: passed")
    print("Strict JSON/body/idempotency validation: passed")
    print("Atomic onboarding service delegation: passed")
    print("Created/replayed response semantics: passed")
    print("Customer login and token response: passed")
    print("Customer refresh-token rotation endpoint: passed")
    print("Customer logout endpoint: passed")
    print("Authenticated customer profile endpoint: passed")
    print("Login/lockout/client-selection error mapping: passed")
    print("Password/admin-secret response suppression: passed")
    print("Conflict/internal error mapping: passed")
    print("Browser and WhatsApp side effects: absent")
    print("Existing account hardcoding: absent")
    print("\nCONTROL PLANE HTTP API V1 TEST PASSED")


if __name__ == "__main__":
    main()
