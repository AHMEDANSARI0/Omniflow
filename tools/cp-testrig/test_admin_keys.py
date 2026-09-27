"""Admin API keys panel (D2): every external key editable in Admin >
Integrations, DB-backed, live without redeploy.

Covers: the platform_settings stt group registry (admin PUT whitelist is
GROUP_KEYS-driven), stt_config DB-first with env fallback,
portal_media._stt_config layering (defaults applied here, None when
unconfigured -> the route answers 409 stt_not_configured), the portal_llm
_runtime panel-overrides-env pin (saving a key goes live instantly), and
the admin Integrations UI carrying the Speech-to-Text inputs (vs the
/tmp/p13 mirror).
"""
import os

import portal_llm
import portal_media
import platform_settings
from test_lib import check, summary

RIG13 = "/tmp/p13/Omniflow/"

# --- registry: the stt group exists; the PUT whitelist + masking are
# driven by GROUP_KEYS / SECRET_HINTS respectively.
check("stt group registered",
      platform_settings.GROUP_KEYS.get("stt")
      == ["api_key", "base_url", "model"], "registry")
check("stt key masked", "api_key" in platform_settings.SECRET_HINTS,
      "registry")

# --- stt_config: DB-first, env fallback, empty is fine
_orig_group = platform_settings.get_group
try:
    platform_settings.get_group = lambda g: {
        "api_key": "sk-db-1", "base_url": "https://db.example.com/v1",
        "model": "db-whisper"}
    cfg = platform_settings.stt_config()
    check("stt db-first", cfg["api_key"] == "sk-db-1"
          and cfg["base_url"] == "https://db.example.com/v1"
          and cfg["model"] == "db-whisper", "stt_config")

    platform_settings.get_group = lambda g: {}
    os.environ["OMNIFLOW_STT_API_KEY"] = "sk-env-1"
    cfg = platform_settings.stt_config()
    check("stt env fallback", cfg["api_key"] == "sk-env-1", "stt_config")
    os.environ.pop("OMNIFLOW_STT_API_KEY")
    cfg = platform_settings.stt_config()
    check("stt unconfigured empty", cfg["api_key"] == "", "stt_config")
finally:
    platform_settings.get_group = _orig_group

# --- portal_media._stt_config: defaults layered here, None unconfigured
try:
    platform_settings.get_group = lambda g: {"api_key": "sk-db-1"}
    got = portal_media._stt_config()
    check("media defaults applied",
          got == (portal_media.STT_BASE_DEFAULT, "sk-db-1",
                  portal_media.STT_MODEL_DEFAULT), "media_layering")

    platform_settings.get_group = lambda g: {
        "api_key": "k", "base_url": "https://x.example/v1/", "model": "m1"}
    got = portal_media._stt_config()
    check("media custom values", got == ("https://x.example/v1", "k", "m1"),
          "media_layering")

    platform_settings.get_group = lambda g: {}
    _saved = {k: v for k, v in os.environ.items()
              if k.startswith("OMNIFLOW_STT")}
    for k in _saved:
        os.environ.pop(k)
    check("media none unconfigured", portal_media._stt_config() is None,
          "media_layering")
    os.environ["OMNIFLOW_STT_API_KEY"] = "env-only"
    got = portal_media._stt_config()
    check("media env-only fallback",
          got == (portal_media.STT_BASE_DEFAULT, "env-only",
                  portal_media.STT_MODEL_DEFAULT), "media_layering")
    os.environ.pop("OMNIFLOW_STT_API_KEY")
finally:
    platform_settings.get_group = _orig_group

# --- the LLM engine already goes live from the panel (no redeploy)
_orig_group = platform_settings.get_group
try:
    platform_settings.get_group = lambda g: (
        {"api_key": "sk-panel", "base_url": "https://panel/v1",
         "model": "panel-model"} if g == "llm" else {})
    rt = portal_llm._runtime()
    check("llm panel overrides env", rt.get("api_key") == "sk-panel"
          and rt.get("model") == "panel-model" and rt.get("enabled"), "llm")
finally:
    platform_settings.get_group = _orig_group

# --- admin Integrations UI carries the Speech-to-Text card
try:
    src = open(RIG13 + "app/admin/(panel)/integrations/"
               "IntegrationsClient.tsx", encoding="utf8").read()
    check("ui stt card", 'id: "stt"' in src and "whisper-1" in src
          and "no redeploy needed" in src, "ui")
    check("ui stt groupkey", '| "stt"' in src, "ui")
except FileNotFoundError:
    check("ui stt card", False, "ui")
    check("ui stt groupkey", False, "ui")

summary("admin_keys")
