"""Platform-level settings store (admin-panel managed provider config).

One tiny table - platform_settings(key TEXT PRIMARY KEY, value TEXT,
updated_at) - holds everything the owner types into the admin panel's
Integrations page: SMTP/Brevo email credentials, the LLM engine config,
the AI feature switches and the future-channel keys (voice, video,
payments, phone verification, the WhatsApp E2E test number).

Design laws:
- STANDARD LIBRARY ONLY for the readers (portal_llm imports this inside
  the ingest hot path; flask lives in admin_providers, not here).
- Fail-soft: any read error -> None, and the caller falls back to its
  environment variable (env-config adapters stay the safety net).
- Secrets are stored as-is in the database and masked by the admin API;
  the readers here are server-side only.
- A 30-second TTL cache keeps the ingest loop from hammering the
  database; every PUT invalidates it on the instance that wrote.
"""

import time

try:  # pragma: no cover - always available in the Control Plane image
    import portal_db
except Exception:  # pragma: no cover - tests may inject a stub
    portal_db = None

TABLE = "platform_settings"
CACHE_TTL_SECONDS = 30.0

_DDL_READY = False
_cache = {}
_cache_at = 0.0

def _ddl() -> str:
    """Built lazily so importing this module never touches portal_db."""
    return (
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) + " ("
        " key TEXT PRIMARY KEY,"
        " value TEXT NOT NULL DEFAULT '',"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        ")"
    )

# group -> the exact keys the admin API accepts for that group.
GROUP_KEYS = {
    "email": ["provider", "smtp_host", "smtp_port", "smtp_user",
              "smtp_password", "smtp_from", "brevo_api_key", "reports_to"],
    "llm": ["base_url", "api_key", "model"],
    "flags": ["true_sentiment", "kb_autodraft", "phone_verification"],
    "voice": ["provider", "account_sid", "auth_token", "from_number"],
    "video": ["provider", "api_key", "zoom_account_id",
              "zoom_client_id", "zoom_client_secret"],
    "payments": ["provider", "publishable_key", "secret_key",
                 "webhook_secret"],
    "whatsapp_e2e": ["live_number"],
}

SECRET_HINTS = ("password", "api_key", "token", "secret")


def _key(group: str, name: str) -> str:
    return group + "." + name


def _ensure(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_ddl())
    _DDL_READY = True


def invalidate_cache() -> None:
    """Drop the TTL cache (called after every successful PUT)."""
    global _cache_at
    _cache.clear()
    _cache_at = 0.0


def get_setting(key: str, default=None):
    """One setting as TEXT; default on any error (fail-soft)."""
    global _cache, _cache_at
    if portal_db is None:
        return default
    now = time.monotonic()
    if _cache and (now - _cache_at) < CACHE_TTL_SECONDS:
        if key in _cache:
            return _cache[key]
        return default
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure(cur)
                cur.execute(
                    "SELECT key, value FROM " + portal_db._q(TABLE)
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
        _cache = {str(r["key"]): str(r["value"] or "") for r in rows}
        _cache_at = time.monotonic()
    except Exception:
        _cache.clear()
        _cache_at = 0.0
        return default
    return _cache.get(key, default)


def get_group(group: str) -> dict:
    """Every stored key of one group as {name: value} (no defaults)."""
    prefix = group + "."
    out = {}
    if portal_db is None:
        return out
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure(cur)
                cur.execute(
                    "SELECT key, value FROM " + portal_db._q(TABLE)
                    + " WHERE key LIKE %s",
                    (prefix + "%",),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception:
        return out
    for row in rows:
        out[str(row["key"])[len(prefix):]] = str(row["value"] or "")
    return out


def put_group(cur, group: str, values: dict) -> None:
    """Upsert one group inside the CALLER's transaction (admin PUT).

    The caller owns auth, whitelist filtering, the audit row and the
    commit; this only writes the key/value pairs.
    """
    prefix = group + "."
    for name, value in values.items():
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (key, value, updated_at) VALUES (%s, %s, NOW())"
            " ON CONFLICT (key) DO UPDATE SET"
            " value = EXCLUDED.value, updated_at = NOW()",
            (prefix + name, str(value)),
        )


def _env(name: str, default: str = "") -> str:
    import os
    return os.environ.get(name, default).strip()


def llm_config() -> dict:
    """Effective LLM config: admin panel first, env fallback.

    enabled keeps the env kill switch: OF_LLM_ENABLED explicitly off
    wins over a stored key.
    """
    stored = {}
    try:
        stored = get_group("llm")
    except Exception:
        stored = {}
    env_enabled = _env("OF_LLM_ENABLED", "1").lower() not in (
        "0", "false", "no", "off")
    api_key = str(stored.get("api_key") or _env("OF_LLM_API_KEY", ""))
    return {
        "base_url": (str(stored.get("base_url") or "")
                     or _env("OF_LLM_BASE_URL",
                             "https://api.openai.com/v1")).rstrip("/"),
        "api_key": api_key,
        "model": str(stored.get("model") or "")
                 or _env("OF_LLM_MODEL", "gpt-4o-mini"),
        "enabled": bool(api_key) and env_enabled,
    }


def video_config() -> dict:
    """Effective video-provider config: admin panel first, env fallback."""
    stored = {}
    try:
        stored = get_group("video")
    except Exception:
        stored = {}
    def pick(name, env, default=""):
        return str(stored.get(name) or "").strip() or _env(env, default)
    provider = (str(stored.get("provider") or "").strip().lower()
                or _env("OF_VIDEO_PROVIDER", "whereby"))
    return {
        "provider": provider,
        "api_key": str(stored.get("api_key") or "")
                   or os_secret_env("OF_VIDEO_API_KEY"),
        "zoom_account_id": pick("zoom_account_id", "OF_ZOOM_ACCOUNT_ID"),
        "zoom_client_id": pick("zoom_client_id", "OF_ZOOM_CLIENT_ID"),
        "zoom_client_secret": str(stored.get("zoom_client_secret") or "")
                              or os_secret_env("OF_ZOOM_CLIENT_SECRET"),
    }


def smtp_config() -> dict:
    """Effective email config: admin panel first, env fallback."""
    stored = {}
    try:
        stored = get_group("email")
    except Exception:
        stored = {}
    def pick(name, env, default=""):
        return str(stored.get(name) or "").strip() or _env(env, default)
    provider = (str(stored.get("provider") or "").strip().lower()
                or ("brevo" if _env("BREVO_API_KEY") else "smtp"))
    return {
        "provider": provider,
        "smtp_host": pick("smtp_host", "SMTP_HOST"),
        "smtp_port": pick("smtp_port", "SMTP_PORT", "587"),
        "smtp_user": pick("smtp_user", "SMTP_USER"),
        "smtp_password": str(stored.get("smtp_password") or "")
                         or os_secret_env("SMTP_PASSWORD"),
        "smtp_from": pick("smtp_from", "SMTP_FROM",
                          "OmniFlow <no-reply@omniflow.app>"),
        "brevo_api_key": str(stored.get("brevo_api_key") or "")
                         or os_secret_env("BREVO_API_KEY"),
        "reports_to": pick("reports_to", "OMNIFLOW_REPORTS_TO"),
    }


def os_secret_env(name: str) -> str:
    """Secret env fallback (os.environ read kept out of the hot path)."""
    import os
    return os.environ.get(name, "")


def flag(name: str) -> bool:
    """AI/feature switch state; every switch defaults OFF."""
    try:
        raw = str(get_setting("flags." + name, "") or "").strip().lower()
    except Exception:
        return False
    return raw in ("on", "1", "true", "yes")
