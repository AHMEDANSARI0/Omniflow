"""Instagram command bridge for OmniFlow's Meta Graph adapter.

The Control Plane keeps the tenant access token. This small worker polls the
existing command queue with ``channel=instagram`` and asks the signed service
endpoint to dispatch each command through the real Instagram Graph API. It
never receives or stores provider credentials.

Required environment:
  OMNIFLOW_CONTROL_PLANE_URL  e.g. https://control-plane.example.com
  OMNIFLOW_SERVICE_KEY         connector service key
  OMNIFLOW_CLIENT_ID            workspace id
Optional:
  POLL_SECONDS                 default 5

Run from the connector-node directory with: python3 instagram_bridge.py
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict


BASE_URL = os.environ.get("OMNIFLOW_CONTROL_PLANE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("OMNIFLOW_SERVICE_KEY", "")
CLIENT_ID = os.environ.get("OMNIFLOW_CLIENT_ID", "")
POLL_SECONDS = max(1.0, float(os.environ.get("POLL_SECONDS", "5") or 5))
COMMANDS_PATH = "/api/v1/connector/whatsapp/commands"
DISPATCH_PATH = "/api/v1/connector/instagram/commands/dispatch"


def _request_json(path: str, method: str = "GET",
                  payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
    query = ""
    if method == "GET":
        query = "?" + urllib.parse.urlencode({
            "client_id": CLIENT_ID,
            "limit": "20",
            "channel": "instagram",
        })
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BASE_URL + path + query,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Omniflow-Key": SERVICE_KEY,
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read().decode("utf-8")
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}


def poll_once() -> int:
    batch = _request_json(COMMANDS_PATH)
    delivered = 0
    for command in batch.get("commands") or []:
        if not isinstance(command, dict):
            continue
        command_id = command.get("id")
        if isinstance(command_id, bool) or not isinstance(command_id, int):
            continue
        result = _request_json(
            DISPATCH_PATH,
            method="POST",
            payload={"client_id": int(CLIENT_ID), "command_id": command_id},
        )
        if result.get("ok") is True:
            delivered += 1
        else:
            print("Instagram command deferred:", command_id,
                  result.get("error", {}).get("message", "unknown error"))
    return delivered


def main() -> None:
    if not BASE_URL or not SERVICE_KEY or not CLIENT_ID.isdigit():
        raise SystemExit(
            "Set OMNIFLOW_CONTROL_PLANE_URL, OMNIFLOW_SERVICE_KEY and "
            "numeric OMNIFLOW_CLIENT_ID."
        )
    print("Instagram bridge polling", BASE_URL, "for workspace", CLIENT_ID)
    while True:
        try:
            count = poll_once()
            if count:
                print("Instagram commands delivered:", count)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            print("Instagram bridge deferred:", error)
        except Exception as error:
            print("Instagram bridge warning:", error)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
