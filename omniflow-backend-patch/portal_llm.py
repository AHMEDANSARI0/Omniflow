"""Tiny OpenAI-compatible chat client (standard library only).

The platform stays lightweight: no SDK, no new infrastructure. Point
``OF_LLM_BASE_URL`` at any OpenAI-compatible endpoint (OpenAI, Groq,
OpenRouter, a local Ollama) and put the key in ``OF_LLM_API_KEY``.

Contract: every helper is FAIL-SOFT. Callers receive ``None`` instead of an
exception and must fall back to their non-LLM path, so a missing key, an
outage or a slow provider never blocks a customer message. The default
budget is one attempt with a short timeout — the ingest loop must not stall.
"""

import json
import logging
import os
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger("omniflow.llm")

BASE_URL = os.environ.get(
    "OF_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
API_KEY = os.environ.get("OF_LLM_API_KEY", "")
MODEL = os.environ.get("OF_LLM_MODEL", "gpt-4o-mini")
TIMEOUT_SECONDS = float(os.environ.get("OF_LLM_TIMEOUT_SECONDS", "6") or 6)
ATTEMPTS = max(1, int(os.environ.get("OF_LLM_ATTEMPTS", "1") or 1))
ENABLED = os.environ.get(
    "OF_LLM_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")


def _http_post_json(url: str, headers: Dict[str, str],
                    payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """POST JSON, return the decoded body; None on any transport error."""
    try:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _runtime() -> Dict[str, Any]:
    """Effective config: admin panel first, env fallback (fail-soft)."""
    try:
        import platform_settings
        config = platform_settings.llm_config()
        if config.get("enabled") and config.get("api_key"):
            return config
        if not ENABLED:
            return {"base_url": BASE_URL, "api_key": "", "model": MODEL,
                    "enabled": False}
        if config.get("api_key"):
            return config
    except Exception:
        pass
    return {"base_url": BASE_URL, "api_key": API_KEY, "model": MODEL,
            "enabled": bool(ENABLED and API_KEY)}


def chat_json(system: str, user: str,
              max_tokens: int = 120) -> Optional[Dict[str, Any]]:
    """One JSON-mode chat call; parsed object or None (never raises)."""
    runtime = _runtime()
    if not runtime.get("enabled") or not runtime.get("api_key"):
        return None
    payload = {
        "model": runtime.get("model") or MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": "Bearer " + str(runtime["api_key"]),
        "Content-Type": "application/json",
    }
    base = str(runtime.get("base_url") or BASE_URL).rstrip("/")
    for _ in range(ATTEMPTS):
        data = _http_post_json(base + "/chat/completions", headers, payload)
        if not data:
            continue
        try:
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None
