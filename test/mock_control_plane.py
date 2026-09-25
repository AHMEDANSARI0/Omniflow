import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PORT = int(os.environ.get("MOCK_CONTROL_PLANE_PORT", "19081"))
ACCESS_1 = "ofa_mock_access_token_one"
REFRESH_1 = "ofr_mock_refresh_token_one"
ACCESS_2 = "ofa_mock_access_token_two"
REFRESH_2 = "ofr_mock_refresh_token_two"

state = {
    "access": ACCESS_1,
    "refresh": REFRESH_1,
    "revoked": False,
}


def tokens(access, refresh):
    return {
        "api_version": "v1",
        "token_type": "Bearer",
        "session_id": "00000000-0000-0000-0000-000000000999",
        "user_id": 9001,
        "client_id": 501,
        "role": "owner",
        "access_token": access,
        "refresh_token": refresh,
        "access_expires_at": "2099-08-24T12:15:00+00:00",
        "refresh_expires_at": "2099-09-23T12:00:00+00:00",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "OmniFlowMock/1"

    def log_message(self, format, *args):
        return

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, code):
        self.send_json(status, {"error": {"code": code, "message": "suppressed"}})

    def do_POST(self):
        if self.path == "/api/v1/auth/login":
            payload = self.read_json()
            if payload.get("email") != "owner@example.com" or payload.get("password") != "Correct-Password-123!":
                self.error(401, "invalid_credentials")
                return
            state.update(access=ACCESS_1, refresh=REFRESH_1, revoked=False)
            self.send_json(200, tokens(ACCESS_1, REFRESH_1))
            return

        if self.path == "/api/v1/auth/refresh":
            payload = self.read_json()
            if state["revoked"] or payload.get("refresh_token") != state["refresh"]:
                self.error(401, "invalid_refresh_token")
                return
            state.update(access=ACCESS_2, refresh=REFRESH_2)
            self.send_json(200, tokens(ACCESS_2, REFRESH_2))
            return

        if self.path == "/api/v1/auth/logout":
            if self.headers.get("Authorization") != f"Bearer {state['access']}":
                self.error(401, "invalid_access_token")
                return
            state["revoked"] = True
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.error(404, "not_found")

    def do_GET(self):
        if self.path == "/api/v1/auth/me":
            if state["revoked"] or self.headers.get("Authorization") != f"Bearer {state['access']}":
                self.error(401, "invalid_access_token")
                return
            self.send_json(
                200,
                {
                    "api_version": "v1",
                    "session_id": "00000000-0000-0000-0000-000000000999",
                    "user_id": 9001,
                    "client_id": 501,
                    "role": "owner",
                    "email": "owner@example.com",
                    "display_name": "Owner Name",
                    "access_expires_at": "2099-08-24T12:15:00+00:00",
                },
            )
            return

        self.error(404, "not_found")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"MOCK CONTROL PLANE READY {PORT}", flush=True)
    server.serve_forever()
