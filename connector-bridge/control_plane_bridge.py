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

                return response.status, body

        except urllib.error.HTTPError as error:
            try:
                body = error.read().decode(
                    "utf-8",
                    "replace",
                )
            except Exception:
                body = ""

            return error.code, body

        except Exception as error:
            print(
                "CP bridge network warning: "
                f"{error}"
            )

            return 0, ""

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

        self.flush()

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
        status, data = self._request(
            "GET",
            "/api/v1/connector/whatsapp/commands?client_id="
            + str(self.client_id)
            + "&limit="
            + str(max(1, min(50, int(limit)))),
        )

        if status != 200:
            return []

        commands = data.get("commands")

        if not isinstance(commands, list):
            return []

        return commands

    def acknowledge_command(
        self,
        command_id,
        ok,
        note=None,
        provider_message_id=None,
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
                **({"provider_message_id": provider_message_id}
                   if provider_message_id else {}),
            },
        )

        if status != 200:
            print(
                "CP bridge ack deferred (HTTP "
                f"{status})"
            )

    def send_media_message(self, payload, adapter):
        """Deliver a send_media command: download the stored asset from
        the CP, upload it to the WhatsApp Cloud media API and send the
        image / document / audio message. Graceful when the Cloud API
        env is missing - returns a clear note instead of raising."""
        import json as _json
        import os as _os
        import urllib.request as _urllib
        import uuid as _uuid

        to = str(payload.get("external_user_id") or "").strip()
        try:
            asset_id = int(payload.get("asset_id") or 0)
        except (TypeError, ValueError):
            asset_id = 0
        kind = str(payload.get("kind") or "image")
        caption = str(payload.get("caption") or "")
        filename = str(payload.get("filename") or "file")
        if not to or asset_id <= 0:
            return "Invalid media payload."

        cloud_url = _os.environ.get("OMNIFLOW_WA_CLOUD_URL", "").strip()
        token = _os.environ.get("OMNIFLOW_WA_TOKEN", "").strip()
        header_name = (
            _os.environ.get("OMNIFLOW_WA_AUTH_HEADER", "").strip()
            or "Authorization"
        )
        header_value = (
            _os.environ.get("OMNIFLOW_WA_AUTH_VALUE", "").strip()
            or ("Bearer " + token)
        )
        if not cloud_url or not token:
            return ("WhatsApp Cloud not configured - set "
                    "OMNIFLOW_WA_CLOUD_URL + OMNIFLOW_WA_TOKEN.")
        endpoint = cloud_url
        if not endpoint.endswith("/"):
            endpoint = endpoint + "/"

        download_url = (self.base_url.rstrip("/")
                        + "/api/v1/connector/media/" + str(asset_id)
                        + "?client_id=" + str(self.client_id))
        request = _urllib.Request(download_url)
        request.add_header("X-Omniflow-Key", self.service_key)
        try:
            with _urllib.urlopen(request, timeout=30) as response:
                asset_bytes = response.read()
                asset_mime = (response.headers.get("Content-Type")
                              or "").split(";")[0].strip()
        except Exception as error:
            return "Asset download failed: " + str(error)
        if not asset_bytes:
            return "Asset download failed: empty response."

        mime_map = {"image": "image/jpeg",
                    "document": "application/pdf",
                    "audio": "audio/ogg"}
        upload_mime = asset_mime or mime_map.get(
            kind, "application/octet-stream")

        boundary = "omniflow" + _uuid.uuid4().hex
        parts = [
            ("--%s\r\nContent-Disposition: form-data; name=\"file\";"
             " filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
             % (boundary, filename, upload_mime)).encode("utf-8"),
            asset_bytes,
            ("\r\n--%s--\r\n" % boundary).encode("utf-8"),
        ]
        body = b"".join(parts)
        request = _urllib.Request(endpoint + "media", data=body,
                                  method="POST")
        request.add_header("Content-Type",
                           "multipart/form-data; boundary=" + boundary)
        request.add_header(header_name, header_value)
        try:
            with _urllib.urlopen(request, timeout=60) as response:
                upload = _json.loads(
                    response.read().decode("utf-8", "replace") or "{}")
        except Exception as error:
            return "Media upload failed: " + str(error)
        media_id = str(upload.get("id") or "")
        if not media_id:
            return ("Media upload refused: "
                    + _json.dumps(upload)[:180])

        message = {"messaging_product": "whatsapp", "to": to,
                   "type": kind}
        if kind == "image":
            message["image"] = {"id": media_id, "caption": caption}
        elif kind == "audio":
            message["audio"] = {"id": media_id}
        else:
            message["document"] = {"id": media_id,
                                   "filename": filename}
            if caption:
                message["document"]["caption"] = caption
        request = _urllib.Request(
            endpoint + "messages",
            data=_json.dumps(message).encode("utf-8"), method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header(header_name, header_value)
        try:
            with _urllib.urlopen(request, timeout=30) as response:
                _json.loads(response.read().decode("utf-8", "replace")
                            or "{}")
        except Exception as error:
            return "Media send failed: " + str(error)
        return "Media " + media_id + " sent as " + kind + "."


    def send_template_message(self, payload, adapter):
        """Deliver a send_template command: POST a Cloud API template
        message. No text fallback - an unapproved or mis-parameterized
        template is rejected by the API and the failure lands in the
        command note instead."""
        to = str(payload.get("external_user_id") or "").strip()
        template_name = str(payload.get("template_name") or "").strip()
        language_code = (
            str(payload.get("language_code") or "").strip() or "en"
        )
        raw_parameters = payload.get("parameters")
        if not isinstance(raw_parameters, list):
            raw_parameters = []
        parameters = [
            {"type": "text", "text": str(item)[:500]}
            for item in raw_parameters[:10]
            if str(item).strip()
        ]
        if not to or not template_name:
            return "Invalid template payload."

        cloud_url = os.environ.get("OMNIFLOW_WA_CLOUD_URL", "").strip()
        token = os.environ.get("OMNIFLOW_WA_TOKEN", "").strip()
        if not cloud_url or not token:
            return (
                "Cloud API not configured - set OMNIFLOW_WA_CLOUD_URL"
                " + OMNIFLOW_WA_TOKEN to send templates."
            )
        header_name = (
            os.environ.get("OMNIFLOW_WA_AUTH_HEADER", "").strip()
            or "Authorization"
        )
        header_value = (
            os.environ.get("OMNIFLOW_WA_AUTH_VALUE", "").strip()
            or ("Bearer " + token)
        )
        endpoint = cloud_url
        if not endpoint.endswith("/"):
            endpoint = endpoint + "/"
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(
                {
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": to,
                    "type": "template",
                    "template": {
                        "name": template_name,
                        "language": {"code": language_code},
                        "components": [
                            {"type": "body", "parameters": parameters}
                        ],
                    },
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                header_name: header_value,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
        return "Template sent via Cloud API."

    def sync_message_templates(self):
        """Push the Meta template list into the portal snapshot (best
        effort - the portal's Cloud templates card reads this list)."""
        cloud_url = os.environ.get("OMNIFLOW_WA_CLOUD_URL", "").strip()
        token = os.environ.get("OMNIFLOW_WA_TOKEN", "").strip()
        if not cloud_url or not token:
            return
        base = cloud_url
        if base.endswith("/"):
            base = base[:-1]
        if not base.endswith("/messages"):
            return
        list_url = base[: -len("/messages")] + "/message_templates?limit=200"
        header_name = (
            os.environ.get("OMNIFLOW_WA_AUTH_HEADER", "").strip()
            or "Authorization"
        )
        header_value = (
            os.environ.get("OMNIFLOW_WA_AUTH_VALUE", "").strip()
            or ("Bearer " + token)
        )
        request = urllib.request.Request(
            list_url,
            headers={
                "Accept": "application/json",
                header_name: header_value,
            },
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(
                response.read().decode("utf-8", "replace")
            )
        templates = []
        for row in (payload.get("data") or [])[:200]:
            if not isinstance(row, dict) or not str(row.get("name") or "").strip():
                continue
            language = row.get("language")
            if isinstance(language, dict):
                language = language.get("code")
            templates.append(
                {
                    "name": str(row.get("name")).strip()[:120],
                    "language": str(language or "").strip()[:20],
                    "status": str(row.get("status") or "").strip()[:20],
                    "category": str(row.get("category") or "").strip()[:60],
                }
            )
        status, _body = self._request(
            "POST",
            "/api/v1/connector/cloud-templates/sync",
            {"client_id": self.client_id, "templates": templates},
        )
        print(
            "CP bridge template sync: HTTP "
            + str(status)
            + " ("
            + str(len(templates))
            + " templates)"
        )
    def send_interactive_message(self, payload, adapter):
        """Deliver a send_interactive command: post the WhatsApp Cloud API
        interactive body when OMNIFLOW_WA_CLOUD_URL + OMNIFLOW_WA_TOKEN are
        configured (360dialog: set OMNIFLOW_WA_AUTH_HEADER=D360-API-KEY),
        otherwise fall back to a numbered plain-text menu through the normal
        adapter so the customer still gets the menu."""
        import json as _json
        import os as _os
        import urllib.request as _urllib

        interactive = payload.get("interactive")
        to = str(payload.get("external_user_id") or "").strip()
        body = str(payload.get("body") or "")
        if not isinstance(interactive, dict) or not to:
            return "Invalid interactive payload."

        cloud_url = _os.environ.get("OMNIFLOW_WA_CLOUD_URL", "").strip()
        token = _os.environ.get("OMNIFLOW_WA_TOKEN", "").strip()
        header_name = (
            _os.environ.get("OMNIFLOW_WA_AUTH_HEADER", "").strip()
            or "Authorization"
        )
        header_value = (
            _os.environ.get("OMNIFLOW_WA_AUTH_VALUE", "").strip()
            or ("Bearer " + token)
        )
        if cloud_url and token:
            endpoint = cloud_url
            if not endpoint.endswith("/"):
                endpoint = endpoint + "/"
            request = _urllib.Request(
                endpoint,
                data=_json.dumps(
                    {
                        "messaging_product": "whatsapp",
                        "recipient_type": "individual",
                        "to": to,
                        **interactive,
                    }
                ).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    header_name: header_value,
                },
                method="POST",
            )
            try:
                with _urllib.urlopen(request, timeout=20) as response:
                    response.read()
                return "Interactive sent via Cloud API."
            except Exception as error:
                print(
                    "interactive cloud send failed: "
                    + str(error)
                    + " - falling back to text"
                )

        lines = []
        ival = interactive.get("interactive") or {}
        if isinstance(ival.get("header"), dict):
            lines.append("*" + str(ival["header"].get("text", "")) + "*")
        if isinstance(ival.get("body"), dict):
            lines.append(str(ival["body"].get("text", "")))
        action = ival.get("action") or {}
        rows = []
        for section in action.get("sections") or []:
            rows.extend(section.get("rows") or [])
        for index, row in enumerate(rows, start=1):
            line = str(index) + ". " + str(row.get("title", ""))
            description = str(row.get("description", ""))
            if description:
                line = line + " - " + description
            lines.append(line)
        if action.get("button"):
            lines.append(
                "(" + str(action["button"]) + " - reply with a number)"
            )
        if isinstance(ival.get("footer"), dict):
            lines.append(str(ival["footer"].get("text", "")))
        text = "\n".join(lines) or body
        if adapter is not None:
            adapter.send(OutboundMessage(to=to, body=text))
        return (
            "Sent as text menu"
            " (set OMNIFLOW_WA_CLOUD_URL + OMNIFLOW_WA_TOKEN for real"
            " buttons)."
        )

    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        try:
            self.process_due_followups(adapter)
        except Exception as followup_error:
            print(f"CP bridge followups warning: {followup_error}")

        try:
            self.process_due_away(adapter)
        except Exception as away_error:
            print(f"CP bridge away warning: {away_error}")

        now = time.time()
        if now - getattr(self, "_last_template_sync", 0.0) > 600:
            self._last_template_sync = now
            try:
                self.sync_message_templates()
            except Exception as error:
                print("CP bridge template sync failed: " + str(error))

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

                elif action == "send_interactive":
                    note = self.send_interactive_message(
                        command.get("payload") or {}, adapter
                    )
                elif action == "send_media":
                    note = self.send_media_message(
                        command.get("payload") or {}, adapter
                    )

                elif action == "send_template":
                    note = self.send_template_message(
                        command.get("payload") or {}, adapter
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

    # ---------- follow-ups ----------

    def fetch_due_followups(self, limit=5):
        status, data = self._request(
            "GET",
            "/api/v1/connector/followups?client_id="
            + str(self.client_id)
            + "&limit="
            + str(int(limit)),
        )
        if status != 200:
            return []
        followups = data.get("followups") if isinstance(data, dict) else None
        if not isinstance(followups, list):
            return []
        return followups

    def acknowledge_followup(self, followup_id, ok, note=None):
        self._request(
            "POST",
            "/api/v1/connector/followups/ack",
            {
                "followup_id": followup_id,
                "ok": bool(ok),
                "note": note,
            },
        )

    def process_due_followups(self, adapter):
        try:
            followups = self.fetch_due_followups()
        except Exception as error:
            print(f"CP bridge followups warning: {error}")
            return
        if not followups:
            return

        try:
            from channels.contracts import OutboundMessage
        except ImportError:
            from src.channels.contracts import OutboundMessage

        account_id = getattr(
            getattr(adapter, "account", None), "id", 0
        )

        for followup in followups:
            followup_id = followup.get("id")
            if not isinstance(followup_id, int):
                continue

            target_user = str(
                followup.get("external_user_id") or ""
            ).strip()
            body_text = str(followup.get("body") or "").strip()
            display_name = followup.get("contact_name")

            if not target_user or not body_text:
                self.acknowledge_followup(
                    followup_id, False, "Invalid follow-up payload."
                )
                continue

            send_result = None
            note = None
            try:
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
            except Exception as error:
                note = f"Follow-up send error: {error}"

            success = (
                send_result is not None
                and send_result.success
            )

            if success:
                try:
                    self.ingest_message(
                        external_user_id=target_user,
                        body=body_text,
                        direction="out",
                    )
                except Exception:
                    pass
                note = "Follow-up sent."
            elif send_result is not None:
                note = "Follow-up send failed: " + str(
                    send_result.error or "unknown error"
                )

            self.acknowledge_followup(followup_id, success, note)

            print(
                "CP bridge follow-up "
                f"{followup_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )

    # ---------- away replies ----------

    def fetch_due_away(self, limit=5):
        status, data = self._request(
            "GET",
            "/api/v1/connector/away-replies?client_id="
            + str(self.client_id)
            + "&limit="
            + str(int(limit)),
        )
        if status != 200:
            return []
        rows = data.get("away_replies") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        return rows

    def acknowledge_away(self, away_id, ok, note=None):
        self._request(
            "POST",
            "/api/v1/connector/away-replies/ack",
            {
                "away_id": away_id,
                "ok": bool(ok),
                "note": note,
            },
        )

    def process_due_away(self, adapter):
        try:
            replies = self.fetch_due_away()
        except Exception as error:
            print(f"CP bridge away warning: {error}")
            return
        if not replies:
            return

        try:
            from channels.contracts import OutboundMessage
        except ImportError:
            from src.channels.contracts import OutboundMessage

        account_id = getattr(
            getattr(adapter, "account", None), "id", 0
        )

        for reply in replies:
            away_id = reply.get("id")
            if not isinstance(away_id, int):
                continue

            target_user = str(
                reply.get("external_user_id") or ""
            ).strip()
            body_text = str(reply.get("body") or "").strip()

            if not target_user or not body_text:
                self.acknowledge_away(away_id, False, "Invalid away payload.")
                continue

            send_result = None
            note = None
            try:
                send_result = adapter.send(
                    OutboundMessage(
                        channel_account_id=int(account_id or 0),
                        external_user_id=target_user,
                        content=body_text,
                        message_type="text",
                        metadata={},
                    )
                )
            except Exception as error:
                note = f"Away send error: {error}"

            success = (
                send_result is not None
                and send_result.success
            )

            if success:
                try:
                    self.ingest_message(
                        external_user_id=target_user,
                        body=body_text,
                        direction="out",
                    )
                except Exception:
                    pass
                note = "Away reply sent."
            elif send_result is not None:
                note = "Away send failed: " + str(
                    send_result.error or "unknown error"
                )

            self.acknowledge_away(away_id, success, note)

            print(
                "CP bridge away reply "
                f"{away_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )
