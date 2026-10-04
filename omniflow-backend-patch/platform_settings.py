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
- Secrets are sealed at rest by portal_vault (§223, AES-256-GCM with the
  env-only OF_SECRETS_KEY; plain legacy values keep working) and masked by
  the admin API; the readers here are server-side only and unseal.
- A 30-second TTL cache keeps the ingest loop from hammering the
  database; every PUT invalidates it on the instance that wrote.
"""

import time

try:  # pragma: no cover - always available in the Control Plane image
    import portal_db
except Exception:  # pragma: no cover - tests may inject a stub
    portal_db = None

try:  # §223 secrets vault (stdlib + lazy cryptography; fail-soft)
    import portal_vault
except Exception:  # pragma: no cover
    portal_vault = None


def _open(value) -> str:
    text = str(value or "")
    if portal_vault is None:
        return text
    return portal_vault.unseal(text)

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
    "llm": ["base_url", "api_key", "model", "prices_json"],
    "flags": ["true_sentiment", "kb_autodraft", "phone_verification"],
    # Voice (Twilio). greeting = platform voicemail greeting; ai_loop =
    # platform switch for the D5 phone AI assistant (on|off, default on -
    # each workspace still opts in); signature_check = Twilio webhook
    # signature policy (enforce|log|off, default enforce). Env fallbacks:
    # OF_VOICE_AI_LOOP, OF_TWILIO_SIGNATURE. webhook_base (§214) = the
    # public https origin Twilio calls (the Control Plane); used by the
    # "Connect in Twilio" button and the signature check. Env fallback:
    # OMNIFLOW_TWILIO_WEBHOOK_BASE.
    "voice": ["provider", "account_sid", "auth_token", "from_number",
              "greeting", "ai_loop", "signature_check", "webhook_base"],
    "video": ["provider", "api_key", "zoom_account_id",
              "zoom_client_id", "zoom_client_secret"],
    "payments": ["provider", "publishable_key", "secret_key",
                 "webhook_secret"],
    "whatsapp_e2e": ["live_number"],
    # mode (D5) = platform switch for automatic customer voice-note
    # transcription (on|off, default on). Env fallback: OF_STT_MODE.
    "stt": ["api_key", "base_url", "model", "mode"],
    # Platform AI controls (admin AI Control Center): a global pause, the
    # highest autonomy any workspace may run at, and a per-workspace daily
    # LLM call cap (0 = unlimited). Env fallbacks: OF_AI_KILL_SWITCH,
    # OF_AI_AUTONOMY_CAP, OF_AI_DAILY_CALL_CAP.
    "ai": ["kill_switch", "autonomy_cap", "daily_call_cap", "guard_mode"],
    # Knowledge semantic index (D1): OpenAI-compatible /embeddings. Blank
    # key/base reuse the AI engine above. Env fallbacks: OF_KB_EMBED_MODE,
    # OF_EMBED_API_KEY, OF_EMBED_BASE_URL, OF_EMBED_MODEL,
    # OF_EMBED_DIMENSIONS, OF_KB_EMBED_MIN_SIM (percent).
    "embeddings": ["mode", "api_key", "base_url", "model", "dimensions",
                   "min_similarity"],
    # Image understanding (D5): OpenAI-compatible multimodal chat. Blank
    # key/base/model reuse the AI engine above (Gemini Flash / GPT-4o-mini
    # read images). Env fallbacks: OF_VISION_MODE, OF_VISION_API_KEY,
    # OF_VISION_BASE_URL, OF_VISION_MODEL.
    "vision": ["mode", "api_key", "base_url", "model"],
    # Ask OmniFlow AI (§227): the owner's in-portal assistant. Platform-
    # billed (AI usage line "assistant", kill switch + daily cap apply).
    # Blank key/base/model reuse the AI engine above. daily_limit = owner
    # questions per workspace per day (0 = unlimited). Env fallbacks:
    # OF_ASSISTANT_MODE, OF_ASSISTANT_API_KEY, OF_ASSISTANT_BASE_URL,
    # OF_ASSISTANT_MODEL, OF_ASSISTANT_DAILY_LIMIT (default 100).
    "assistant": ["mode", "api_key", "base_url", "model", "daily_limit"],
    # Model Router (§229, portal_model_router): which model answers which
    # task. fast/smart tiers (provider primary|secondary + model; blank
    # model = that provider's default), routes_json {feature: fast|smart|
    # main}, a secondary OpenAI-compatible provider for failover, and the
    # circuit breaker. Blank = today's behaviour. Env fallbacks:
    # OF_ROUTER_* (MODE, FAILOVER, FAST_PROVIDER, FAST_MODEL, SMART_PROVIDER,
    # SMART_MODEL, ROUTES_JSON, SECONDARY_BASE_URL, SECONDARY_API_KEY,
    # SECONDARY_MODEL, BREAKER_FAILURES, BREAKER_SECONDS).
    "router": ["mode", "failover", "fast_provider", "fast_model",
               "smart_provider", "smart_model", "routes_json",
               "secondary_base_url", "secondary_api_key", "secondary_model",
               "breaker_failures", "breaker_seconds"],
}

AUTONOMY_LEVELS = ("off", "suggest", "auto")
GUARD_MODES = ("off", "standard", "strict")

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
            conn.commit()  # keep the lazy DDL (§223 fix: was rolled back)
        finally:
            conn.close()
        _cache = {str(r["key"]): _open(r["value"]) for r in rows}
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
            conn.commit()  # keep the lazy DDL (§223 fix: was rolled back)
        finally:
            conn.close()
    except Exception:
        return out
    for row in rows:
        out[str(row["key"])[len(prefix):]] = _open(row["value"])
    return out


def put_group(cur, group: str, values: dict) -> None:
    """Upsert one group inside the CALLER's transaction (admin PUT).

    The caller owns auth, whitelist filtering, the audit row and the
    commit; this only writes the key/value pairs.
    """
    prefix = group + "."
    for name, value in values.items():
        if portal_vault is not None \
                and portal_vault.is_secret_setting(prefix + name):
            value = portal_vault.seal(value)
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


def ai_controls() -> dict:
    """Effective platform AI controls: admin panel first, env fallback.

    {kill_switch: bool, autonomy_cap: off|suggest|auto,
     daily_call_cap: int (0 = unlimited),
     guard_mode: off|standard|strict (prompt-injection guard),
     source: panel|env|default}
    Fail-soft: any storage problem yields the permissive defaults. Reads
    go through get_setting (30 s TTL cache) because the LLM gate consults
    this on EVERY call - never an extra round trip per call.
    """
    stored = {}
    try:
        for name in GROUP_KEYS["ai"]:
            stored[name] = str(get_setting("ai." + name, "") or "")
    except Exception:
        stored = {}
    source = "default"
    kill_raw = str(stored.get("kill_switch") or "")
    if kill_raw:
        source = "panel"
    else:
        kill_raw = _env("OF_AI_KILL_SWITCH", "")
        if kill_raw:
            source = "env"
    cap_raw = str(stored.get("autonomy_cap") or "").strip().lower()
    if cap_raw and source == "default":
        source = "panel"
    if not cap_raw:
        cap_raw = _env("OF_AI_AUTONOMY_CAP", "").lower()
        if cap_raw and source == "default":
            source = "env"
    if cap_raw not in AUTONOMY_LEVELS:
        cap_raw = "auto"
    daily_raw = str(stored.get("daily_call_cap") or "").strip()
    if daily_raw and source == "default":
        source = "panel"
    if not daily_raw:
        daily_raw = _env("OF_AI_DAILY_CALL_CAP", "")
        if daily_raw and source == "default":
            source = "env"
    try:
        daily_cap = max(0, int(daily_raw or 0))
    except (TypeError, ValueError):
        daily_cap = 0
    guard_raw = str(stored.get("guard_mode") or "").strip().lower()
    if guard_raw and source == "default":
        source = "panel"
    if not guard_raw:
        guard_raw = _env("OF_AI_GUARD_MODE", "").lower()
        if guard_raw and source == "default":
            source = "env"
    if guard_raw not in GUARD_MODES:
        guard_raw = "standard"
    return {
        "kill_switch": kill_raw.strip().lower() in ("on", "1", "true", "yes"),
        "autonomy_cap": cap_raw,
        "daily_call_cap": daily_cap,
        "guard_mode": guard_raw,
        "source": source,
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


def stt_config() -> dict:
    """Effective speech-to-text config: admin panel first, env fallback.

    portal_media owns the base/model defaults (OpenAI-compatible whisper
    endpoint); this only resolves what the owner saved (or the env).
    """
    stored = {}
    try:
        stored = get_group("stt")
    except Exception:
        stored = {}
    return {
        "api_key": str(stored.get("api_key")
                       or _env("OMNIFLOW_STT_API_KEY", "")),
        "base_url": str(stored.get("base_url")
                        or _env("OMNIFLOW_STT_BASE", "")),
        "model": str(stored.get("model")
                     or _env("OMNIFLOW_STT_MODEL", "")),
    }


EMBED_MODES = ("on", "off")
GEMINI_HOST_HINT = "generativelanguage.googleapis.com"


def _embed_default_model(base_url: str) -> str:
    if GEMINI_HOST_HINT in str(base_url or ""):
        return _env("OF_EMBED_MODEL_GEMINI", "gemini-embedding-001")
    return _env("OF_EMBED_MODEL_DEFAULT", "text-embedding-3-small")


def _embed_default_min_sim(model: str) -> int:
    # Similarity scales differ per model family: Gemini vectors sit higher
    # for unrelated text than OpenAI's. Owner/env can always override.
    if "gemini" in str(model or "").lower():
        return int(_env("OF_KB_EMBED_MIN_SIM_GEMINI", "60") or 60)
    return int(_env("OF_KB_EMBED_MIN_SIM_DEFAULT", "30") or 30)


def _int_or(value, default: int, low: int, high: int) -> int:
    try:
        number = int(str(value).strip())
    except Exception:
        return default
    return max(low, min(high, number))


def embed_config() -> dict:
    """Effective knowledge-embedding config: admin panel first, env next,
    then the AI engine's own base/key. Uses get_setting (30 s TTL cache)
    because retrieval consults it on the reply path. Fail-soft.

    {mode: on|off, active: bool, reason: active|off|no_key|llm_disabled,
     api_key, base_url, model, dimensions (0 = provider default),
     min_similarity (0..1), key_source: embeddings|env|llm|none}
    """
    def setting(name: str) -> str:
        try:
            return str(get_setting("embeddings." + name, "") or "").strip()
        except Exception:
            return ""

    def llm_setting(name: str) -> str:
        try:
            return str(get_setting("llm." + name, "") or "").strip()
        except Exception:
            return ""

    mode = (setting("mode") or _env("OF_KB_EMBED_MODE", "on")).lower()
    if mode not in EMBED_MODES:
        mode = "on"
    key_source = "none"
    api_key = setting("api_key")
    if api_key:
        key_source = "embeddings"
    elif _env("OF_EMBED_API_KEY", ""):
        api_key, key_source = _env("OF_EMBED_API_KEY", ""), "env"
    else:
        api_key = llm_setting("api_key") or _env("OF_LLM_API_KEY", "")
        key_source = "llm" if api_key else "none"
    base_url = (setting("base_url") or _env("OF_EMBED_BASE_URL", "")
                or llm_setting("base_url")
                or _env("OF_LLM_BASE_URL", "https://api.openai.com/v1"))
    base_url = base_url.rstrip("/")
    model = (setting("model") or _env("OF_EMBED_MODEL", "")
             or _embed_default_model(base_url))
    dimensions = _int_or(setting("dimensions")
                         or _env("OF_EMBED_DIMENSIONS", "256"), 256, 0, 4096)
    min_sim = _int_or(setting("min_similarity")
                      or _env("OF_KB_EMBED_MIN_SIM", ""),
                      _embed_default_min_sim(model), 0, 100)
    llm_enabled = _env("OF_LLM_ENABLED", "1").lower() not in (
        "0", "false", "no", "off")
    if mode == "off":
        reason = "off"
    elif not api_key:
        reason = "no_key"
    elif key_source == "llm" and not llm_enabled:
        reason = "llm_disabled"
    else:
        reason = "active"
    return {
        "mode": mode,
        "active": reason == "active",
        "reason": reason,
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "dimensions": dimensions,
        "min_similarity": min_sim / 100.0,
        "key_source": key_source,
    }


# ---------------------------------------------------------------------------
# D5: voice + vision resolution (panel first, env next, AI engine last)
# ---------------------------------------------------------------------------

VISION_MODES = ("on", "off")
STT_MODES = ("on", "off")
VOICE_AI_LOOP_MODES = ("on", "off")
SIGNATURE_MODES = ("enforce", "log", "off")


def _cached(name: str) -> str:
    try:
        return str(get_setting(name, "") or "").strip()
    except Exception:
        return ""


def vision_config() -> dict:
    """Effective image-understanding config (30 s TTL cache via
    get_setting - it is consulted on the ingest path). Fail-soft.

    {mode, active, reason: active|off|no_key|llm_disabled, api_key,
     base_url, model, key_source: vision|env|llm|none}
    """
    mode = (_cached("vision.mode") or _env("OF_VISION_MODE", "on")).lower()
    if mode not in VISION_MODES:
        mode = "on"
    api_key = _cached("vision.api_key")
    key_source = "vision" if api_key else "none"
    if not api_key and _env("OF_VISION_API_KEY", ""):
        api_key, key_source = _env("OF_VISION_API_KEY", ""), "env"
    if not api_key:
        api_key = _cached("llm.api_key") or _env("OF_LLM_API_KEY", "")
        key_source = "llm" if api_key else "none"
    base_url = (_cached("vision.base_url") or _env("OF_VISION_BASE_URL", "")
                or _cached("llm.base_url")
                or _env("OF_LLM_BASE_URL", "https://api.openai.com/v1"))
    model = (_cached("vision.model") or _env("OF_VISION_MODEL", "")
             or _cached("llm.model") or _env("OF_LLM_MODEL", "gpt-4o-mini"))
    llm_enabled = _env("OF_LLM_ENABLED", "1").lower() not in (
        "0", "false", "no", "off")
    if mode == "off":
        reason = "off"
    elif not api_key:
        reason = "no_key"
    elif key_source == "llm" and not llm_enabled:
        reason = "llm_disabled"
    else:
        reason = "active"
    return {"mode": mode, "active": reason == "active", "reason": reason,
            "api_key": api_key, "base_url": base_url.rstrip("/"),
            "model": model, "key_source": key_source}


ASSISTANT_MODES = ("on", "off")


def assistant_config() -> dict:
    """Effective Ask OmniFlow AI config (§227), same shape and fallbacks as
    vision_config() plus ``daily_limit``. Fail-soft.

    {mode, active, reason: active|off|no_key|llm_disabled, api_key,
     base_url, model, key_source: assistant|env|llm|none, daily_limit}
    """
    mode = (_cached("assistant.mode") or _env("OF_ASSISTANT_MODE", "on")).lower()
    if mode not in ASSISTANT_MODES:
        mode = "on"
    api_key = _cached("assistant.api_key")
    key_source = "assistant" if api_key else "none"
    if not api_key and _env("OF_ASSISTANT_API_KEY", ""):
        api_key, key_source = _env("OF_ASSISTANT_API_KEY", ""), "env"
    if not api_key:
        api_key = _cached("llm.api_key") or _env("OF_LLM_API_KEY", "")
        key_source = "llm" if api_key else "none"
    base_url = (_cached("assistant.base_url") or _env("OF_ASSISTANT_BASE_URL", "")
                or _cached("llm.base_url")
                or _env("OF_LLM_BASE_URL", "https://api.openai.com/v1"))
    model = (_cached("assistant.model") or _env("OF_ASSISTANT_MODEL", "")
             or _cached("llm.model") or _env("OF_LLM_MODEL", "gpt-4o-mini"))
    try:
        daily_limit = int(_cached("assistant.daily_limit")
                          or _env("OF_ASSISTANT_DAILY_LIMIT", "100"))
    except (TypeError, ValueError):
        daily_limit = 100
    llm_enabled = _env("OF_LLM_ENABLED", "1").lower() not in (
        "0", "false", "no", "off")
    if mode == "off":
        reason = "off"
    elif not api_key:
        reason = "no_key"
    elif key_source == "llm" and not llm_enabled:
        reason = "llm_disabled"
    else:
        reason = "active"
    return {"mode": mode, "active": reason == "active", "reason": reason,
            "api_key": api_key, "base_url": base_url.rstrip("/"),
            "model": model, "key_source": key_source,
            "daily_limit": max(0, min(100000, daily_limit))}


def stt_mode() -> str:
    """Platform switch for automatic customer voice-note transcription."""
    mode = (_cached("stt.mode") or _env("OF_STT_MODE", "on")).lower()
    return mode if mode in STT_MODES else "on"


def voice_platform() -> dict:
    """Platform voice policy: {ai_loop: on|off, signature_check:
    enforce|log|off, greeting}. Panel first, env fallback."""
    loop = (_cached("voice.ai_loop") or _env("OF_VOICE_AI_LOOP", "on")).lower()
    if loop not in VOICE_AI_LOOP_MODES:
        loop = "on"
    check = (_cached("voice.signature_check")
             or _env("OF_TWILIO_SIGNATURE", "enforce")).lower()
    if check not in SIGNATURE_MODES:
        check = "enforce"
    return {"ai_loop": loop, "signature_check": check,
            "greeting": _cached("voice.greeting")[:200],
            "webhook_base": clean_webhook_base(_cached("voice.webhook_base"))}


def clean_webhook_base(value: str) -> str:
    """https origin (optionally with a path prefix) or "" - never a query,
    fragment, credentials or plain http (Twilio signs the exact URL)."""
    import urllib.parse

    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return ""
    if parts.scheme != "https" or not parts.hostname or parts.query \
            or parts.fragment or parts.username or parts.password:
        return ""
    return text[:300]

