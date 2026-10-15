import os
import sys
from pathlib import Path
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*args, **kwargs):
        return False


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

load_dotenv(PROJECT_ROOT / ".env")

from control_plane.http_api import (  # noqa: E402
    APIConfigurationError,
    create_control_plane_api,
)


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


def configured_address():
    host = os.getenv(
        "CONTROL_PLANE_HOST",
        "127.0.0.1",
    ).strip()

    try:
        port = int(
            os.getenv(
                "CONTROL_PLANE_PORT",
                "8080",
            )
        )
    except ValueError as error:
        raise APIConfigurationError(
            "CONTROL_PLANE_PORT must be an integer"
        ) from error

    if not host:
        raise APIConfigurationError(
            "CONTROL_PLANE_HOST cannot be empty"
        )

    if port < 1 or port > 65535:
        raise APIConfigurationError(
            "CONTROL_PLANE_PORT must be between 1 and 65535"
        )

    loopback_hosts = {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    allow_remote = os.getenv(
        "CONTROL_PLANE_ALLOW_REMOTE",
        "",
    ).strip().lower() in {
        "1",
        "true",
        "yes",
    }

    if host not in loopback_hosts and not allow_remote:
        raise APIConfigurationError(
            "Remote binding is blocked. Set "
            "CONTROL_PLANE_ALLOW_REMOTE=true only behind "
            "an authenticated TLS reverse proxy."
        )

    return host, port


def main():
    app = create_control_plane_api()
    host, port = configured_address()
    server = make_server(
        host,
        port,
        app,
        server_class=ThreadingWSGIServer,
    )

    print("OmniFlow Control Plane API v1")
    print(f"Listening on http://{host}:{port}")
    print("Health: /api/v1/health")
    print("Admin onboarding: POST /api/v1/admin/onboarding")
    print("Customer login: POST /api/v1/auth/login")
    print("Customer refresh: POST /api/v1/auth/refresh")
    print("Customer logout: POST /api/v1/auth/logout")
    print("Customer profile: GET /api/v1/auth/me")
    print("Browser and WhatsApp workers started: False")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Control Plane API")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
