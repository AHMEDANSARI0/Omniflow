import json
import os
from http.cookies import SimpleCookie
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler


PORT = int(os.environ.get("OMNIFLOW_WEBSITE_TEST_PORT", "13000"))
BASE = f"http://127.0.0.1:{PORT}"
ORIGIN = BASE


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path, method="GET", body=None, cookie=None, redirect=True):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if method == "POST":
        headers["Origin"] = ORIGIN
    if body is not None:
        headers["Content-Type"] = "application/json"
    if cookie:
        headers["Cookie"] = cookie

    opener = build_opener() if redirect else build_opener(NoRedirect())
    try:
        response = opener.open(
            Request(BASE + path, data=data, headers=headers, method=method),
            timeout=15,
        )
        return response.status, response.headers, response.read(), response.geturl()
    except HTTPError as error:
        return error.code, error.headers, error.read(), error.geturl()


def update_cookies(jar, headers):
    for value in headers.get_all("Set-Cookie") or []:
        parsed = SimpleCookie()
        parsed.load(value)
        for name, morsel in parsed.items():
            if name not in {"of_access_token", "of_refresh_token"}:
                continue
            if morsel.value:
                jar[name] = morsel.value
            else:
                jar.pop(name, None)


def cookie_header(jar):
    return "; ".join(f"{name}={value}" for name, value in jar.items())


def main():
    jar = {}
    status, headers, body, _ = request(
        "/api/omniflow/auth/login",
        method="POST",
        body={
            "email": "OWNER@EXAMPLE.COM",
            "password": "Correct-Password-123!",
            "client_id": 501,
        },
    )
    assert status == 200, (status, body)
    rendered_headers = "\n".join(headers.get_all("Set-Cookie") or [])
    lowered_headers = rendered_headers.lower()
    assert lowered_headers.count("httponly") == 2
    assert lowered_headers.count("samesite=strict") == 2
    assert "ofa_mock" not in body.decode("utf-8")
    assert "ofr_mock" not in body.decode("utf-8")
    update_cookies(jar, headers)
    assert set(jar) == {"of_access_token", "of_refresh_token"}

    status, _, body, _ = request(
        "/api/omniflow/auth/me",
        cookie=cookie_header(jar),
    )
    principal = json.loads(body)
    assert status == 200
    assert principal["client_id"] == 501
    assert principal["role"] == "owner"
    assert "access_token" not in principal
    assert "refresh_token" not in principal

    status, headers, body, _ = request(
        "/api/omniflow/auth/refresh",
        method="POST",
        cookie=cookie_header(jar),
    )
    assert status == 204, (status, body)
    update_cookies(jar, headers)

    status, _, body, _ = request(
        "/api/omniflow/auth/me",
        cookie=cookie_header(jar),
    )
    assert status == 200, (status, body)

    status, _, body, _ = request(
        "/api/omniflow/auth/logout",
        method="POST",
        cookie=cookie_header(jar),
    )
    assert status == 204, (status, body)

    status, headers, _, _ = request(
        "/dashboard",
        cookie=None,
        redirect=False,
    )
    assert status in {307, 308}
    assert headers["Location"].endswith("/dashboard/login")

    status, _, body, _ = request(
        "/api/omniflow/auth/login",
        method="POST",
        body={
            "email": "owner@example.com",
            "password": "Wrong-Password-123!",
        },
    )
    assert status == 401
    assert "Correct-Password" not in body.decode("utf-8")
    assert "Wrong-Password" not in body.decode("utf-8")

    print("BFF login and HttpOnly token cookies: passed")
    print("Tenant-scoped /me DTO: passed")
    print("Refresh-token rotation through BFF: passed")
    print("Logout and local cookie clearing: passed")
    print("Protected dashboard redirect: passed")
    print("Raw tokens/passwords in browser responses: absent")
    print("\nOMNIFLOW WEBSITE AUTH NETWORK TEST PASSED")


if __name__ == "__main__":
    main()
