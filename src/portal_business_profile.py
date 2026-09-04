"""Portal "Business profile" ka live mirror — bot ke jawabat isi se.

Background thread har 120s fetch karta hai:
  GET /api/v1/connector/profile?client_id=1   (X-Omniflow-Key)
  -> {profile: {...free-form JSON...}, updated_at}

build_business_directives() system prompt me jaata hai — business name,
products, prices, policies, FAQs. Profile khali ho to "" (kuch inject nahi).
Network fail -> previous profile chalti rehti hai.

Env: OMNIFLOW_SERVICE_KEY, OMNIFLOW_CP_BASE_URL, OMNIFLOW_CLIENT_ID,
OMNIFLOW_PROFILE_SECONDS (refresh interval, default 120).
"""

import json
import os
import threading
import urllib.request


DEFAULT_BASE_URL = "https://omniflow-control-plane-rho.vercel.app"
FETCH_INTERVAL_SECONDS = 120.0
MAX_DIRECTIVE_CHARS = 6000

_lock = threading.Lock()
_current = {}
_updated_at = None
_started = False


def _service_key():
    return str(os.getenv("OMNIFLOW_SERVICE_KEY", "")).strip()


def _base_url():
    return str(
        os.getenv("OMNIFLOW_CP_BASE_URL", DEFAULT_BASE_URL)
    ).rstrip("/")


def _client_id():
    return int(os.getenv("OMNIFLOW_CLIENT_ID", "1"))


def _interval():
    return max(
        30.0,
        float(
            os.getenv(
                "OMNIFLOW_PROFILE_SECONDS",
                str(FETCH_INTERVAL_SECONDS),
            )
        ),
    )


def get_profile():
    with _lock:
        return dict(_current)


def _render_value(value):
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, (int, float, bool)):
        return str(value)

    if isinstance(value, list):
        parts = []

        for item in value:
            text = _render_value(item)

            if text:
                parts.append(text)

        return "; ".join(parts)

    if isinstance(value, dict):
        parts = []

        for key, item in value.items():
            text = _render_value(item)

            if text:
                parts.append(f"{key}: {text}")

        return "; ".join(parts)

    return ""


def build_business_directives():
    """System prompt ke liye business-profile section (ya "")."""
    with _lock:
        profile = dict(_current)

    if not profile:
        return ""

    lines = [
        "BUSINESS PROFILE (provided by the owner — answer customer questions "
        "from this information first; if something is not covered here, say "
        "you will check with the team. Never invent information):"
    ]

    total = len(lines[0])

    for key in sorted(profile.keys()):
        rendered = _render_value(profile[key])

        if not rendered:
            continue

        entry = f"- {key}: {rendered}"
        total += len(entry) + 1

        if total > MAX_DIRECTIVE_CHARS:
            lines.append(
                "- (aur bhi information maujood hai — zaroorat par "
                "owner se poochna)"
            )
            break

        lines.append(entry)

    if len(lines) <= 1:
        return ""

    return "\n".join(lines)


def _apply(data):
    global _current, _updated_at

    profile = {}
    updated_at = None

    if isinstance(data, dict):
        raw = data.get("profile")

        if isinstance(raw, dict):
            profile = raw

        updated_at = data.get("updated_at")

    with _lock:
        _current = profile
        _updated_at = (
            updated_at if isinstance(updated_at, str) else None
        )

    return profile


def _fetch_once():
    key = _service_key()

    if not key:
        return False

    request = urllib.request.Request(
        _base_url()
        + "/api/v1/connector/profile?client_id="
        + str(_client_id()),
        headers={"X-Omniflow-Key": key},
        method="GET",
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=8,
        ) as response:
            data = json.loads(
                response.read().decode("utf-8", "replace")
            )
    except Exception as error:
        print(f"Business profile fetch deferred: {error}")
        return False

    profile = _apply(data)

    print(
        "Business profile updated: "
        + str(len(profile))
        + " field(s)"
    )

    return True


def _loop():
    while True:
        try:
            _fetch_once()
        except Exception as error:
            print(f"Business profile loop warning: {error}")

        threading.Event().wait(_interval())


def start_background_refresh():
    """Idempotent — bot ke andar aik dafa call karo."""
    global _started

    if _started:
        return

    _started = True

    thread = threading.Thread(
        target=_loop,
        name="portal-business-profile",
        daemon=True,
    )
    thread.start()

    print(
        "Business profile refresh started (every "
        f"{_interval():g}s)"
    )