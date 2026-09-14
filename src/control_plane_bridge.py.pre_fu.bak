"""Control Plane bridge for the laptop WhatsApp connector.

Reports session status, ingests inbound/outbound messages and polls
portal commands from the OmniFlow Control Plane API (Vercel).

Stdlib only (urllib) — no new dependencies. Every network call is
failure-tolerant: the bridge never crashes the bot loop.

Env (from .env, loaded by run_channel.py):
  OMNIFLOW_SERVICE_KEY          (required — the value stored in oflow_service_key.txt)
  OMNIFLOW_CP_BASE_URL          (optional, default: production Control Plane)
  OMNIFLOW_CLIENT_ID            (optional, default: 1)
  OMNIFLOW_COMMAND_POLL_SECONDS (optional, default: 15)
  OMNIFLOW_PHONE                (optional — shown as the connected WhatsApp number in the portal)
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request


DEFAULT_BASE_URL = "https://omniflow-control-plane-rho.vercel.app"


class ControlPlaneBridge:
    """Failure-tolerant HTTP reporter/poller for the Control Plane."""

    def __init__(self, account_name=None):
        self.base_url = str(
            os.getenv("OMNIFLOW_CP_BASE_URL", DEFAULT_BASE_URL)
        ).rstrip("/")

        self.service_key = str(
            os.getenv("OMNIFLOW_SERVICE_KEY", "")
        ).strip()

        if not self.service_key:
            raise RuntimeError(
                "OMNIFLOW_SERVICE_KEY not found in .env — "
                "put the value from oflow_service_key.txt into .env"
            )

        self.client_id = int(
            os.getenv("OMNIFLOW_CLIENT_ID", "1")
        )

        self.phone = (
            str(os.getenv("OMNIFLOW_PHONE", "")).strip() or None
        )

        self.command_poll_seconds = max(
            5.0,
            float(
                os.getenv(
                    "OMNIFLOW_COMMAND_POLL_SECONDS",
                    "15",
                )
            ),
        )

        self.timeout_seconds = max(
            3.0,
            float(
                os.getenv(
                    "OMNIFLOW_HTTP_TIMEOUT_SECONDS",
                    "8",
                )
            ),
        )

        self.max_batch = 100

        self.account_name = (
            str(account_name).strip()
            if account_name
            else None
        )

        self._pending = []
        self._lock = threading.Lock()
        self._last_heartbeat = 0.0

        print(
            "CP bridge: "
            + self.base_url
            + " (client_id="
            + str(self.client_id)
            + ")"
        )

    # ---------- low level ----------

    def _request(self, method, path, payload=None):
        data = None
        headers = {
            "X-Omniflow-Key": self.service_key,
        }

        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(
                request,
                timeout=self.timeout_seconds,
            ) as response:
                body = response.read().decode(
                    "utf-8",
                    "replace",
                )

                return (
                    response.status,
                    ControlPlaneBridge._parse(body),
                )

        except urllib.error.HTTPError as error:
            try:
                body = error.read().decode(
                    "utf-8",
                    "replace",
                )
            except Exception:
                body = ""

            return (
                error.code,
                ControlPlaneBridge._parse(body),
            )

        except Exception as error:
            print(
                "CP bridge network warning: "
                f"{error}"
            )

            return 0, {}

    @staticmethod
    def _parse(body):
        try:
            parsed = json.loads(body)

            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

        return {}

    # ---------- status ----------

    def report_status(self, state, phone=None):
        if phone is None and getattr(self, "phone", None):
            phone = self.phone
        payload = {
            "client_id": self.client_id,
            "state": state,
            "account_name": self.account_name,
        }

        if phone:
            payload["phone"] = str(phone)

        status, _ = self._request(
            "POST",
            "/api/v1/connector/whatsapp/status",
            payload,
        )

        if status == 200:
            print(f"CP bridge status: {state}")

            return True

        print(
            "CP bridge status deferred (HTTP "
            f"{status})"
        )

        return False

    # ---------- message ingest ----------

    def ingest_message(
        self,
        external_user_id,
        body,
        direction="in",
        display_name=None,
    ):
        item = {
            "from": str(external_user_id or "").strip(),
            "body": "" if body is None else str(body),
            "direction": (
                "out" if direction == "out" else "in"
            ),
        }

        if not item["from"]:
            return

        if (
            display_name
            and item["direction"] == "in"
        ):
            item["name"] = str(display_name)

        with self._lock:
            if len(self._pending) >= self.max_batch:
                dropped = self._pending.pop(0)

                print(
                    "CP bridge backlog full — oldest message dropped: "
                    f"{dropped.get('from')}"
                )

            self._pending.append(item)

        try:
            self.flush()
        except Exception as flush_error:
            print(
                "CP bridge ingest warning: "
                f"{flush_error}"
            )

    def flush(self):
        with self._lock:
            batch = list(self._pending[: self.max_batch])

        if not batch:
            return True

        status, data = self._request(
            "POST",
            "/api/v1/connector/whatsapp/messages",
            {
                "client_id": self.client_id,
                "messages": batch,
            },
        )

        if status == 200:
            inserted = data.get("inserted")

            with self._lock:
                del self._pending[: len(batch)]

            print(
                "CP bridge ingest: "
                f"{inserted if inserted is not None else len(batch)}"
                " message(s) stored"
            )

            return True

        print(
            "CP bridge ingest deferred (HTTP "
            f"{status})"
        )

        return False

    # ---------- commands ----------

    def fetch_commands(self, limit=10):
        now = time.monotonic()

        if now - self._last_heartbeat >= 60.0:
            self.report_status("connected")
            self._last_heartbeat = now

        status, data = self._request(
            "GET",
            "/api/v1/connector/whatsapp/commands?client_id="
            + str(self.client_id)
            + "&limit="
            + str(max(1, min(50, int(limit)))),
        )

        try:
            if status != 200:
                return []

            commands = data.get("commands")

            if not isinstance(commands, list):
                return []

            return commands
        except Exception:
            return []

    def acknowledge_command(
        self,
        command_id,
        ok,
        note=None,
    ):
        if not isinstance(command_id, int):
            return

        status, _ = self._request(
            "POST",
            "/api/v1/connector/whatsapp/commands/ack",
            {
                "client_id": self.client_id,
                "command_id": command_id,
                "ok": bool(ok),
                "note": note,
            },
        )

        if status != 200:
            print(
                "CP bridge ack deferred (HTTP "
                f"{status})"
            )

    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        commands = self.fetch_commands()

        for command in commands:
            command_id = command.get("id")

            if not isinstance(command_id, int):
                continue

            action = str(
                command.get("action") or ""
            ).strip().lower()

            ok = True
            note = None

            try:
                if action == "connect":
                    note = (
                        "Connector session already active."
                    )

                elif action == "disconnect":
                    if stop_requested is not None:
                        stop_requested.set()

                        note = (
                            "Stop requested from portal."
                        )

                    else:
                        ok = False
                        note = (
                            "No stop handle available."
                        )

                elif action == "restart":
                    adapter.stop()
                    adapter.start()
                    self.report_status("connected")

                    note = "Session restarted."

                elif action == "send_message":
                    try:
                        from channels.contracts import OutboundMessage
                    except ImportError:
                        from src.channels.contracts import OutboundMessage

                    command_payload = command.get("payload") or {}
                    if isinstance(command_payload, str):
                        try:
                            command_payload = json.loads(command_payload)
                        except Exception:
                            command_payload = {}
                    target_user = str(
                        command_payload.get("external_user_id") or ""
                    ).strip()
                    body_text = str(command_payload.get("body") or "").strip()
                    display_name = command_payload.get("target_display_name")

                    if not target_user or not body_text:
                        ok = False
                        note = (
                            "send_message payload requires external_user_id "
                            "and body."
                        )
                    else:
                        account_id = getattr(
                            getattr(adapter, "account", None), "id", 0
                        )
                        send_result = adapter.send(
                            OutboundMessage(
                                channel_account_id=int(account_id or 0),
                                external_user_id=target_user,
                                content=body_text,
                                message_type="text",
                                metadata=(
                                    {"target_display_name": display_name}
                                    if display_name
                                    else {}
                                ),
                            )
                        )
                        if send_result.success:
                            self.ingest_message(
                                external_user_id=target_user,
                                body=body_text,
                                direction="out",
                            )
                            note = "Message sent."
                        else:
                            ok = False
                            note = "Send failed: " + str(
                                send_result.error or "unknown error"
                            )

                else:
                    ok = False
                    note = (
                        "Unsupported action on connector: "
                        + action
                    )

            except Exception as error:
                ok = False
                note = f"Execution failed: {error}"

            self.acknowledge_command(
                command_id,
                ok,
                note,
            )

            print(
                "CP bridge command "
                f"{command_id} ({action}): "
                + ("done" if ok else "failed")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )