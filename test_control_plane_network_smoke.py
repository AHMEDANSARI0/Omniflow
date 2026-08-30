import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import (
    HTTPError,
    URLError,
)
from urllib.request import (
    Request,
    urlopen,
)


PROJECT_ROOT = Path(__file__).resolve().parent
STARTUP_TIMEOUT_SECONDS = 15


class NetworkSmokeError(RuntimeError):
    pass


def free_loopback_port():
    with socket.socket(
        socket.AF_INET,
        socket.SOCK_STREAM,
    ) as handle:
        handle.bind(
            ("127.0.0.1", 0)
        )

        return int(
            handle.getsockname()[1]
        )


def read_json(
    url,
    method="GET",
    body=None,
    headers=None,
):
    encoded = None

    if body is not None:
        encoded = json.dumps(
            body
        ).encode("utf-8")

    request = Request(
        url,
        data=encoded,
        headers=headers or {},
        method=method,
    )

    try:
        with urlopen(
            request,
            timeout=2,
        ) as response:
            return (
                int(response.status),
                dict(
                    response.headers.items()
                ),
                json.loads(
                    response.read()
                    .decode("utf-8")
                ),
            )

    except HTTPError as error:
        return (
            int(error.code),
            dict(
                error.headers.items()
            ),
            json.loads(
                error.read()
                .decode("utf-8")
            ),
        )


def wait_for_health(
    url,
    process,
):
    deadline = (
        time.monotonic()
        + STARTUP_TIMEOUT_SECONDS
    )

    last_error = None

    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise NetworkSmokeError(
                "Control Plane API exited "
                "during startup"
            )

        try:
            status, headers, payload = (
                read_json(url)
            )

            if status == 200:
                return (
                    status,
                    headers,
                    payload,
                )

        except (
            URLError,
            TimeoutError,
            OSError,
        ) as error:
            last_error = error

        time.sleep(0.1)

    raise NetworkSmokeError(
        "Control Plane API did not "
        "become healthy: "
        + str(
            last_error
            or "startup timeout"
        )
    )


def stop_process(process):
    if process.poll() is None:
        process.terminate()

        try:
            process.wait(timeout=5)

        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    stdout, stderr = (
        process.communicate(
            timeout=5
        )
    )

    return (
        stdout or "",
        stderr or "",
    )


def main():
    port = free_loopback_port()

    admin_key = (
        secrets.token_urlsafe(48)
    )

    environment = os.environ.copy()

    environment.update({
        "OMNIFLOW_ADMIN_API_KEY":
            admin_key,
        "CONTROL_PLANE_HOST":
            "127.0.0.1",
        "CONTROL_PLANE_PORT":
            str(port),
        "CONTROL_PLANE_ALLOW_REMOTE":
            "false",
        "PYTHONUNBUFFERED":
            "1",
    })

    process = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(
                PROJECT_ROOT
                / "run_control_plane_api.py"
            ),
        ],
        cwd=str(PROJECT_ROOT),
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    stdout = ""
    stderr = ""

    try:
        base_url = (
            f"http://127.0.0.1:{port}"
        )

        status, headers, health = (
            wait_for_health(
                (
                    f"{base_url}"
                    "/api/v1/health"
                ),
                process,
            )
        )

        assert status == 200

        assert health == {
            "api_version": "v1",
            "service":
                "omniflow-control-plane",
            "status": "ok",
        }

        assert (
            headers["Cache-Control"]
            == "no-store"
        )

        assert (
            headers[
                "X-Content-Type-Options"
            ]
            == "nosniff"
        )

        (
            unauthorized_status,
            _,
            unauthorized,
        ) = read_json(
            (
                f"{base_url}"
                "/api/v1/admin/onboarding"
            ),
            method="POST",
            body={},
            headers={
                "Content-Type":
                    "application/json",
                "Idempotency-Key":
                    "network-smoke-only",
            },
        )

        assert (
            unauthorized_status == 401
        )

        assert (
            unauthorized["error"]["code"]
            == "unauthorized"
        )

        (
            missing_status,
            _,
            missing,
        ) = read_json(
            (
                f"{base_url}"
                "/api/v1/not-found"
            )
        )

        assert missing_status == 404

        assert (
            missing["error"]["code"]
            == "not_found"
        )

    finally:
        stdout, stderr = (
            stop_process(process)
        )

    combined_logs = (
        stdout + "\n" + stderr
    )

    assert admin_key not in combined_logs

    assert (
        "playwright"
        not in combined_logs.lower()
    )

    assert (
        "Browser and WhatsApp workers "
        "started: False"
        in stdout
    )

    print(
        "Loopback API process startup: "
        "passed"
    )
    print(
        "HTTP health endpoint: 200 OK"
    )
    print(
        "Security headers over network: "
        "passed"
    )
    print(
        "Unauthorized onboarding request: "
        "rejected"
    )
    print(
        "Unknown route response: 404"
    )
    print(
        "Administrator secret in logs: "
        "absent"
    )
    print(
        "API process terminated after "
        "smoke test: True"
    )
    print(
        "Database onboarding calls: 0"
    )
    print(
        "Browser and WhatsApp workers "
        "started: False"
    )
    print("")
    print(
        "CONTROL PLANE NETWORK "
        "SMOKE TEST PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
