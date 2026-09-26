"""
OmniFlow Control Plane — portal request authentication (customer Bearer tokens).

Portal extension endpoints authenticate the customer by asking the MAIN
Control Plane app itself: an in-process WSGI call to GET /api/v1/auth/me —
the exact same endpoint the website BFF uses. This means token/session
validation is NEVER re-implemented here and can never drift from the
platform's own rules.

`ofk_...` tokens are customer-generated PORTAL API KEYS (portal_api_keys
table, SHA-256 stored). They authenticate as the tenant but are READ-ONLY:
mutation endpoints call ensure_human_principal() which rejects them with 403.

app.py binds the composite root application once at import time
(bind_root_application). No network hop, no extra dependencies.
"""

import hashlib
import io
import json
import logging
import sys
import threading
from typing import Any, Dict, Optional

from flask import jsonify, request

import portal_db


logger = logging.getLogger("omniflow.portal-auth")

_ROOT_APP = None
_BIND_LOCK = threading.Lock()


def bind_root_application(app: Any) -> None:
    """Called by app.py AFTER the composite WSGI app is assembled."""
    global _ROOT_APP
    with _BIND_LOCK:
        _ROOT_APP = app


class PortalAuthUnavailable(RuntimeError):
    """Token verification itself failed (not a plain 401)."""


def _wsgi_environ(token: str) -> Dict[str, Any]:
    return {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/api/v1/auth/me",
        "QUERY_STRING": "",
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "443",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "CONTENT_LENGTH": "0",
        "CONTENT_TYPE": "",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "https",
        "wsgi.input": io.BytesIO(b""),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": True,
        "wsgi.multiprocess": True,
        "wsgi.run_once": False,
        "HTTP_AUTHORIZATION": "Bearer " + token,
    }


def _api_key_principal(token: str) -> Optional[Dict[str, Any]]:
    """Validate an ofk_ portal API key against portal_api_keys (SHA-256)."""
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    portal_db.ensure_tables()
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, client_id, created_by FROM "
                + portal_db._q(portal_db.APIKEY_TABLE) +
                " WHERE token_hash = %s AND revoked_at IS NULL"
                " ORDER BY id DESC LIMIT 1",
                (token_hash,),
            )
            found = portal_db.rows(cur)
            if found:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.APIKEY_TABLE) +
                    " SET last_used_at = NOW() WHERE id = %s",
                    (found[0]["id"],),
                )
        conn.commit()
    finally:
        conn.close()
    if not found:
        return None
    return {
        "session_id": "",
        "user_id": found[0].get("created_by"),
        "client_id": found[0]["client_id"],
        "role": "api_key",
        "email": "",
        "display_name": None,
        "via_api_key": True,
    }


def authenticate_portal_request() -> Optional[Dict[str, Any]]:
    """
    Validate the request's Authorization: Bearer token.

    Returns a principal dict {session_id, user_id, client_id, role, email,
    display_name, [via_api_key]}, or None when the token is
    missing/invalid/expired (401). Raises PortalAuthUnavailable when
    verification itself fails (map to 503).
    """
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    if token.startswith("ofk_"):
        try:
            return _api_key_principal(token)
        except PortalAuthUnavailable:
            raise
        except Exception:
            logger.exception("portal api-key lookup failed")
            raise PortalAuthUnavailable("api-key verification failed")
    if _ROOT_APP is None:
        raise PortalAuthUnavailable("root application not bound")

    captured: Dict[str, Any] = {}

    def start_response(status, headers, exc_info=None):
        captured["status"] = status
        captured["headers"] = headers
        return lambda chunk: None

    body_chunks = []
    try:
        for chunk in _ROOT_APP(_wsgi_environ(token), start_response):
            body_chunks.append(chunk)
    except Exception:
        logger.exception("in-process /auth/me verification call failed")
        raise PortalAuthUnavailable("principal verification crashed")

    body = b"".join(body_chunks)
    status_code = 500
    try:
        status_code = int(str(captured.get("status", "500")).split(" ")[0])
    except (TypeError, ValueError):
        pass

    if status_code in (401, 403):
        return None
    if status_code != 200:
        logger.warning("/auth/me verification returned HTTP %s", status_code)
        raise PortalAuthUnavailable("principal verification returned " + str(status_code))

    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        raise PortalAuthUnavailable("/auth/me returned a non-JSON body")
    if not isinstance(payload, dict):
        raise PortalAuthUnavailable("/auth/me payload was not an object")

    user_id = payload.get("user_id")
    client_id = payload.get("client_id")
    if isinstance(user_id, bool) or isinstance(client_id, bool):
        raise PortalAuthUnavailable("/auth/me ids malformed")
    if not isinstance(user_id, int) or not isinstance(client_id, int):
        raise PortalAuthUnavailable("/auth/me payload missing user_id/client_id")

    return {
        "session_id": str(payload.get("session_id", "")),
        "user_id": user_id,
        "client_id": client_id,
        "role": str(payload.get("role", "")),
        "email": str(payload.get("email", "")),
        "display_name": (
            payload.get("display_name")
            if isinstance(payload.get("display_name"), str)
            else None
        ),
    }


def ensure_human_principal(principal: Optional[Dict[str, Any]]) -> Optional[Any]:
    """
    Mutation guard: portal API keys (ofk_) are READ-ONLY.

    Returns a (json, 403) response when the principal is an API key,
    None for human (session) principals. Usage:

        principal = authenticate_portal_request()
        ...
        forbidden = ensure_human_principal(principal)
        if forbidden:
            return forbidden
    """
    if principal is not None and principal.get("via_api_key"):
        return (
            jsonify({"error": {"code": "read_only_principal",
                               "message": "API keys are read-only."}}),
            403,
        )
    return None
