import hmac
import json
import os
import re
from dataclasses import asdict
from typing import Any, Mapping
from uuid import uuid4

from .auth import (
    AccountLocked,
    InvalidAccessToken,
    InvalidCredentials,
    InvalidRefreshToken,
    LoginRequest,
    LogoutRequest,
    MembershipSelectionRequired,
    PlatformAuthenticationService,
    RefreshRequest,
)
from .onboarding import (
    ClientOnboardingRequest,
    ClientOnboardingService,
    OnboardingConflict,
    TrialLimits,
)


API_PREFIX = "/api/v1"
MAX_BODY_BYTES = 64 * 1024
MIN_ADMIN_KEY_LENGTH = 32
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
ONBOARDING_FIELDS = frozenset({
    "business_name",
    "owner_name",
    "owner_email",
    "owner_phone",
    "password",
    "channel_name",
    "platform",
    "agent_name",
    "agent_instruction",
    "business_profile",
    "language_policy",
    "tone_policy",
    "knowledge_config",
    "qualification_config",
    "workflow_config",
    "fallback_config",
    "handoff_config",
    "tool_config",
    "trial",
})
TRIAL_FIELDS = frozenset({
    "days",
    "max_channel_accounts",
    "max_managed_sessions",
    "max_inbound_messages",
    "max_ai_calls",
    "max_outbound_messages",
})
LOGIN_FIELDS = frozenset({
    "email",
    "password",
    "client_id",
})
REFRESH_FIELDS = frozenset({
    "refresh_token",
})


class APIConfigurationError(RuntimeError):
    pass


class APIRequestError(ValueError):
    def __init__(self, message, status="400 Bad Request", code="bad_request"):
        super().__init__(message)
        self.status = status
        self.code = code


class ControlPlaneAPI:
    def __init__(
        self,
        onboarding_service,
        admin_key,
        authentication_service=None,
        max_body_bytes=MAX_BODY_BYTES,
    ):
        if not hasattr(onboarding_service, "onboard"):
            raise TypeError(
                "onboarding_service must provide onboard(request)"
            )

        if (
            authentication_service is not None
            and (
                not hasattr(authentication_service, "login")
                or not hasattr(authentication_service, "refresh")
                or not hasattr(authentication_service, "logout")
                or not hasattr(
                    authentication_service,
                    "authenticate_access_token",
                )
            )
        ):
            raise TypeError(
                "authentication_service must provide login(request), "
                "refresh(request), logout(request), and "
                "authenticate_access_token(token)"
            )

        normalized_key = str(admin_key or "")

        if len(normalized_key) < MIN_ADMIN_KEY_LENGTH:
            raise APIConfigurationError(
                "OMNIFLOW_ADMIN_API_KEY must contain at least "
                f"{MIN_ADMIN_KEY_LENGTH} characters"
            )

        try:
            normalized_limit = int(max_body_bytes)
        except (TypeError, ValueError) as error:
            raise APIConfigurationError(
                "max_body_bytes must be an integer"
            ) from error

        if normalized_limit < 1024 or normalized_limit > 1024 * 1024:
            raise APIConfigurationError(
                "max_body_bytes must be between 1024 and 1048576"
            )

        self._onboarding_service = onboarding_service
        self._authentication_service = authentication_service
        self._admin_key = normalized_key
        self._max_body_bytes = normalized_limit

    @staticmethod
    def _request_id(environ):
        supplied = str(environ.get("HTTP_X_REQUEST_ID") or "").strip()

        if supplied and REQUEST_ID_PATTERN.fullmatch(supplied):
            return supplied

        return str(uuid4())

    @staticmethod
    def _json_response(start_response, status, payload, request_id):
        body = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("X-Request-ID", request_id),
        ]
        start_response(status, headers)
        return [body]

    @staticmethod
    def _empty_response(start_response, status, request_id):
        headers = [
            ("Content-Length", "0"),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("X-Request-ID", request_id),
        ]
        start_response(status, headers)
        return [b""]

    def _error(self, start_response, status, code, message, request_id):
        return self._json_response(
            start_response,
            status,
            {
                "error": {
                    "code": code,
                    "message": message,
                    "request_id": request_id,
                }
            },
            request_id,
        )

    @staticmethod
    def _bearer_token(environ):
        authorization = str(
            environ.get("HTTP_AUTHORIZATION") or ""
        )
        prefix = "Bearer "

        if not authorization.startswith(prefix):
            return None

        token = authorization[len(prefix):].strip()
        return token or None

    def _authorized(self, environ):
        supplied = self._bearer_token(environ)

        if supplied is None:
            return False

        return hmac.compare_digest(
            supplied,
            self._admin_key,
        )

    def _read_json(self, environ):
        content_type = str(environ.get("CONTENT_TYPE") or "")

        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise APIRequestError(
                "Content-Type must be application/json",
                status="415 Unsupported Media Type",
                code="unsupported_media_type",
            )

        raw_length = str(environ.get("CONTENT_LENGTH") or "").strip()

        if not raw_length:
            raise APIRequestError(
                "Content-Length is required",
                status="411 Length Required",
                code="length_required",
            )

        try:
            content_length = int(raw_length)
        except ValueError as error:
            raise APIRequestError(
                "Content-Length is invalid"
            ) from error

        if content_length <= 0:
            raise APIRequestError(
                "JSON request body is required"
            )

        if content_length > self._max_body_bytes:
            raise APIRequestError(
                "Request body is too large",
                status="413 Payload Too Large",
                code="payload_too_large",
            )

        stream = environ.get("wsgi.input")

        if stream is None:
            raise APIRequestError(
                "Request body stream is unavailable"
            )

        body = stream.read(content_length)

        if len(body) != content_length:
            raise APIRequestError(
                "Request body was incomplete"
            )

        try:
            decoded = body.decode("utf-8")
            payload = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise APIRequestError(
                "Request body must contain valid UTF-8 JSON"
            ) from error

        if not isinstance(payload, dict):
            raise APIRequestError(
                "JSON request body must be an object"
            )

        return payload

    @staticmethod
    def _mapping(payload, field_name):
        value = payload.get(field_name, {})

        if value is None:
            return {}

        if not isinstance(value, Mapping):
            raise APIRequestError(
                f"{field_name} must be a JSON object"
            )

        return dict(value)

    @staticmethod
    def _trial(payload):
        value = payload.get("trial", {})

        if value is None:
            value = {}

        if not isinstance(value, dict):
            raise APIRequestError(
                "trial must be a JSON object"
            )

        unknown = sorted(set(value) - TRIAL_FIELDS)

        if unknown:
            raise APIRequestError(
                "Unknown trial fields: " + ", ".join(unknown)
            )

        try:
            return TrialLimits(**value)
        except (TypeError, ValueError) as error:
            raise APIRequestError(str(error)) from error

    def _onboarding_request(self, environ, payload):
        unknown = sorted(set(payload) - ONBOARDING_FIELDS)

        if unknown:
            raise APIRequestError(
                "Unknown onboarding fields: " + ", ".join(unknown)
            )

        idempotency_key = str(
            environ.get("HTTP_IDEMPOTENCY_KEY") or ""
        ).strip()

        if not idempotency_key:
            raise APIRequestError(
                "Idempotency-Key header is required",
                code="idempotency_key_required",
            )

        platform = str(payload.get("platform", "whatsapp")).strip().lower()

        if platform != "whatsapp":
            raise APIRequestError(
                "Only the whatsapp managed connector is enabled in this release",
                code="platform_not_enabled",
            )

        kwargs = {
            "idempotency_key": idempotency_key,
            "business_name": payload.get("business_name"),
            "owner_name": payload.get("owner_name"),
            "owner_email": payload.get("owner_email"),
            "owner_phone": payload.get("owner_phone"),
            "password": payload.get("password"),
            "channel_name": payload.get("channel_name", "WhatsApp"),
            "platform": platform,
            "agent_name": payload.get("agent_name", "Primary AI Agent"),
            "business_profile": self._mapping(payload, "business_profile"),
            "language_policy": self._mapping(payload, "language_policy"),
            "tone_policy": self._mapping(payload, "tone_policy"),
            "knowledge_config": self._mapping(payload, "knowledge_config"),
            "qualification_config": self._mapping(
                payload,
                "qualification_config",
            ),
            "workflow_config": self._mapping(payload, "workflow_config"),
            "fallback_config": self._mapping(payload, "fallback_config"),
            "handoff_config": self._mapping(payload, "handoff_config"),
            "tool_config": self._mapping(payload, "tool_config"),
            "trial": self._trial(payload),
        }

        if "agent_instruction" in payload:
            kwargs["agent_instruction"] = payload["agent_instruction"]

        try:
            return ClientOnboardingRequest(**kwargs)
        except (TypeError, ValueError) as error:
            raise APIRequestError(str(error)) from error

    def _handle_onboarding(self, environ, start_response, request_id):
        if not self._authorized(environ):
            return self._error(
                start_response,
                "401 Unauthorized",
                "unauthorized",
                "A valid administrator bearer token is required",
                request_id,
            )

        try:
            payload = self._read_json(environ)
            request = self._onboarding_request(environ, payload)
            result = self._onboarding_service.onboard(request)
        except APIRequestError as error:
            return self._error(
                start_response,
                error.status,
                error.code,
                str(error),
                request_id,
            )
        except OnboardingConflict as error:
            return self._error(
                start_response,
                "409 Conflict",
                "onboarding_conflict",
                str(error),
                request_id,
            )
        except Exception:
            return self._error(
                start_response,
                "500 Internal Server Error",
                "internal_error",
                "The onboarding request could not be completed",
                request_id,
            )

        response = asdict(result)
        response["request_id"] = str(result.request_id)
        response["agent_id"] = str(result.agent_id)
        response["api_version"] = "v1"
        status = (
            "200 OK"
            if result.idempotent_replay
            else "201 Created"
        )
        return self._json_response(
            start_response,
            status,
            response,
            request_id,
        )

    def _handle_login(self, environ, start_response, request_id):
        if self._authentication_service is None:
            return self._error(
                start_response,
                "503 Service Unavailable",
                "authentication_unavailable",
                "Customer authentication is not configured",
                request_id,
            )

        try:
            payload = self._read_json(environ)
            unknown = sorted(set(payload) - LOGIN_FIELDS)

            if unknown:
                raise APIRequestError(
                    "Unknown login fields: " + ", ".join(unknown)
                )

            login_request = LoginRequest(
                email=payload.get("email"),
                password=payload.get("password"),
                client_id=payload.get("client_id"),
                metadata={
                    "source": "http_api_v1",
                },
            )
            result = self._authentication_service.login(
                login_request
            )
        except APIRequestError as error:
            return self._error(
                start_response,
                error.status,
                error.code,
                str(error),
                request_id,
            )
        except (TypeError, ValueError) as error:
            return self._error(
                start_response,
                "400 Bad Request",
                "bad_request",
                str(error),
                request_id,
            )
        except InvalidCredentials:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_credentials",
                "The email, password, or client selection is invalid",
                request_id,
            )
        except AccountLocked:
            return self._error(
                start_response,
                "423 Locked",
                "account_locked",
                "Login is temporarily locked; try again later",
                request_id,
            )
        except MembershipSelectionRequired:
            return self._error(
                start_response,
                "409 Conflict",
                "client_selection_required",
                "client_id is required for this account",
                request_id,
            )
        except Exception:
            return self._error(
                start_response,
                "500 Internal Server Error",
                "internal_error",
                "The login request could not be completed",
                request_id,
            )

        return self._json_response(
            start_response,
            "200 OK",
            {
                "api_version": "v1",
                "token_type": "Bearer",
                "session_id": str(result.session_id),
                "user_id": result.user_id,
                "client_id": result.client_id,
                "role": result.role,
                "access_token": result.access_token,
                "refresh_token": result.refresh_token,
                "access_expires_at": (
                    result.access_expires_at.isoformat()
                ),
                "refresh_expires_at": (
                    result.refresh_expires_at.isoformat()
                ),
            },
            request_id,
        )

    def _handle_refresh(self, environ, start_response, request_id):
        if self._authentication_service is None:
            return self._error(
                start_response,
                "503 Service Unavailable",
                "authentication_unavailable",
                "Customer authentication is not configured",
                request_id,
            )

        try:
            payload = self._read_json(environ)
            unknown = sorted(set(payload) - REFRESH_FIELDS)

            if unknown:
                raise APIRequestError(
                    "Unknown refresh fields: " + ", ".join(unknown)
                )

            refresh_request = RefreshRequest(
                refresh_token=payload.get("refresh_token"),
                metadata={
                    "source": "http_api_v1",
                },
            )
            result = self._authentication_service.refresh(
                refresh_request
            )
        except APIRequestError as error:
            return self._error(
                start_response,
                error.status,
                error.code,
                str(error),
                request_id,
            )
        except (TypeError, ValueError) as error:
            return self._error(
                start_response,
                "400 Bad Request",
                "bad_request",
                str(error),
                request_id,
            )
        except InvalidRefreshToken:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_refresh_token",
                "The refresh token is invalid, expired, or has been reused",
                request_id,
            )
        except Exception:
            return self._error(
                start_response,
                "500 Internal Server Error",
                "internal_error",
                "The session could not be refreshed",
                request_id,
            )

        return self._json_response(
            start_response,
            "200 OK",
            {
                "api_version": "v1",
                "token_type": "Bearer",
                "session_id": str(result.session_id),
                "user_id": result.user_id,
                "client_id": result.client_id,
                "role": result.role,
                "access_token": result.access_token,
                "refresh_token": result.refresh_token,
                "access_expires_at": (
                    result.access_expires_at.isoformat()
                ),
                "refresh_expires_at": (
                    result.refresh_expires_at.isoformat()
                ),
            },
            request_id,
        )

    def _handle_logout(self, environ, start_response, request_id):
        if self._authentication_service is None:
            return self._error(
                start_response,
                "503 Service Unavailable",
                "authentication_unavailable",
                "Customer authentication is not configured",
                request_id,
            )

        access_token = self._bearer_token(environ)

        if access_token is None:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_access_token",
                "A valid access bearer token is required",
                request_id,
            )

        try:
            self._authentication_service.logout(
                LogoutRequest(
                    access_token=access_token,
                    metadata={
                        "source": "http_api_v1",
                    },
                )
            )
        except (TypeError, ValueError):
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_access_token",
                "A valid access bearer token is required",
                request_id,
            )
        except InvalidAccessToken:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_access_token",
                "The access token is invalid",
                request_id,
            )
        except Exception:
            return self._error(
                start_response,
                "500 Internal Server Error",
                "internal_error",
                "The session could not be logged out",
                request_id,
            )

        return self._empty_response(
            start_response,
            "204 No Content",
            request_id,
        )

    def _handle_me(self, environ, start_response, request_id):
        if self._authentication_service is None:
            return self._error(
                start_response,
                "503 Service Unavailable",
                "authentication_unavailable",
                "Customer authentication is not configured",
                request_id,
            )

        access_token = self._bearer_token(environ)

        if access_token is None:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_access_token",
                "A valid access bearer token is required",
                request_id,
            )

        try:
            principal = (
                self._authentication_service
                .authenticate_access_token(access_token)
            )
        except InvalidAccessToken:
            return self._error(
                start_response,
                "401 Unauthorized",
                "invalid_access_token",
                "The access token is invalid or expired",
                request_id,
            )
        except Exception:
            return self._error(
                start_response,
                "500 Internal Server Error",
                "internal_error",
                "The authenticated profile could not be loaded",
                request_id,
            )

        return self._json_response(
            start_response,
            "200 OK",
            {
                "api_version": "v1",
                "session_id": str(principal.session_id),
                "user_id": principal.user_id,
                "client_id": principal.client_id,
                "role": principal.role,
                "email": principal.email,
                "display_name": principal.display_name,
                "access_expires_at": (
                    principal.access_expires_at.isoformat()
                ),
            },
            request_id,
        )

    def __call__(self, environ, start_response):
        request_id = self._request_id(environ)
        method = str(environ.get("REQUEST_METHOD") or "GET").upper()
        path = str(environ.get("PATH_INFO") or "/")

        if path == f"{API_PREFIX}/health":
            if method != "GET":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only GET is allowed for this endpoint",
                    request_id,
                )

            return self._json_response(
                start_response,
                "200 OK",
                {
                    "api_version": "v1",
                    "service": "omniflow-control-plane",
                    "status": "ok",
                },
                request_id,
            )

        if path == f"{API_PREFIX}/auth/login":
            if method != "POST":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only POST is allowed for this endpoint",
                    request_id,
                )

            return self._handle_login(
                environ,
                start_response,
                request_id,
            )

        if path == f"{API_PREFIX}/auth/refresh":
            if method != "POST":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only POST is allowed for this endpoint",
                    request_id,
                )

            return self._handle_refresh(
                environ,
                start_response,
                request_id,
            )

        if path == f"{API_PREFIX}/auth/logout":
            if method != "POST":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only POST is allowed for this endpoint",
                    request_id,
                )

            return self._handle_logout(
                environ,
                start_response,
                request_id,
            )

        if path == f"{API_PREFIX}/auth/me":
            if method != "GET":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only GET is allowed for this endpoint",
                    request_id,
                )

            return self._handle_me(
                environ,
                start_response,
                request_id,
            )

        if path == f"{API_PREFIX}/admin/onboarding":
            if method != "POST":
                return self._error(
                    start_response,
                    "405 Method Not Allowed",
                    "method_not_allowed",
                    "Only POST is allowed for this endpoint",
                    request_id,
                )

            return self._handle_onboarding(
                environ,
                start_response,
                request_id,
            )

        return self._error(
            start_response,
            "404 Not Found",
            "not_found",
            "The requested endpoint does not exist",
            request_id,
        )


def postgres_connection_factory():
    try:
        import psycopg2
    except ImportError as error:
        raise APIConfigurationError(
            "psycopg2 is required for the control-plane API"
        ) from error

    names = (
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    )
    values = {
        name: os.getenv(name)
        for name in names
    }
    missing = [
        name
        for name, value in values.items()
        if not str(value or "").strip()
    ]

    if missing:
        raise APIConfigurationError(
            "Missing database environment values: "
            + ", ".join(missing)
        )

    return psycopg2.connect(
        host=values["DB_HOST"],
        port=values["DB_PORT"],
        database=values["DB_NAME"],
        user=values["DB_USER"],
        password=values["DB_PASSWORD"],
        connect_timeout=10,
        application_name="omniflow-control-plane-api-v1",
    )


def create_control_plane_api(
    onboarding_service=None,
    authentication_service=None,
    admin_key=None,
):
    onboarding = onboarding_service or ClientOnboardingService(
        postgres_connection_factory
    )
    authentication = (
        authentication_service
        or PlatformAuthenticationService(
            postgres_connection_factory
        )
    )
    resolved_key = (
        admin_key
        if admin_key is not None
        else os.getenv("OMNIFLOW_ADMIN_API_KEY")
    )
    return ControlPlaneAPI(
        onboarding_service=onboarding,
        authentication_service=authentication,
        admin_key=resolved_key,
    )
