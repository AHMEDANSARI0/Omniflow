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
import math
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("omniflow.llm")

_SCOPE = threading.local()


class usage_scope:
    """Tag the LLM calls made inside the block for the AI usage ledger:

        with portal_llm.usage_scope("brain", client_id, cur, agent_id=agent_id):
            payload = portal_llm.chat_json(...)

    ``cur`` (optional) lets the ledger row ride the caller's transaction
    (savepoint-guarded); without it the ledger opens its own short
    connection. ``agent_id`` (optional) attributes the call to an AI
    persona for per-agent cost split. Scopes nest (innermost wins) and
    never raise."""

    def __init__(self, feature: str, client_id: int = 0, cur=None,
                 agent_id: int = 0):
        self.entry = (str(feature or "")[:40], int(client_id or 0), cur,
                      int(agent_id or 0))

    def __enter__(self):
        stack = getattr(_SCOPE, "stack", None)
        if stack is None:
            stack = _SCOPE.stack = []
        stack.append(self.entry)
        return self

    def __exit__(self, *exc):
        stack = getattr(_SCOPE, "stack", None)
        if stack:
            stack.pop()
        return False


def current_scope():
    """(feature, client_id, cur, agent_id) of the innermost usage_scope."""
    stack = getattr(_SCOPE, "stack", None)
    return stack[-1] if stack else ("", 0, None, 0)


def _record_usage(model: str, usage: Any, ok: bool, started: float) -> None:
    """Hand the call to the usage ledger (fail-soft, never raises)."""
    try:
        import portal_ai_usage

        feature, client_id, cur, agent_id = current_scope()
        usage = usage if isinstance(usage, dict) else {}
        portal_ai_usage.record(
            client_id, feature or "other", model,
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            int((time.time() - started) * 1000), ok, cur=cur,
            agent_id=agent_id)
    except Exception:
        pass

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


def _gated() -> bool:
    """Platform AI gate (admin kill switch / per-workspace daily call cap)
    for the call being made in the current usage scope; fail-open."""
    try:
        import portal_ai_usage

        feature, client_id, cur, _agent_id = current_scope()
        reason = portal_ai_usage.gate(feature, client_id, cur)
    except Exception:
        return False
    if reason:
        logger.info("llm call blocked (%s) client=%s feature=%s",
                    reason, client_id, feature)
        return True
    return False


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
    if _gated():
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
    model = str(payload["model"])
    started = time.time()
    last_usage = None
    for _ in range(ATTEMPTS):
        data = _http_post_json(base + "/chat/completions", headers, payload)
        if not data:
            continue
        last_usage = data.get("usage") if isinstance(data, dict) else None
        try:
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except Exception:
            continue
        if isinstance(parsed, dict):
            _record_usage(model, last_usage, True, started)
            return parsed
    _record_usage(model, last_usage, False, started)
    return None


# ---------------------------------------------------------------------------
# Embeddings (D1 knowledge semantic index) - same OpenAI-compatible contract
# ---------------------------------------------------------------------------

EMBED_TIMEOUT_SECONDS = float(
    os.environ.get("OF_EMBED_TIMEOUT_SECONDS", "20") or 20)
EMBED_MAX_INPUTS = max(1, min(256, int(
    os.environ.get("OF_EMBED_BATCH", "32") or 32)))
EMBED_TEXT_CHARS = max(200, int(
    os.environ.get("OF_EMBED_TEXT_CHARS", "2000") or 2000))


def embed_runtime() -> Dict[str, Any]:
    """Effective embedding config (platform_settings.embed_config);
    inactive on any error."""
    try:
        import platform_settings
        return platform_settings.embed_config()
    except Exception:
        return {"active": False, "reason": "no_key", "api_key": "",
                "base_url": BASE_URL, "model": "", "dimensions": 0,
                "min_similarity": 0.3, "mode": "on", "key_source": "none"}


def normalize_vector(values: Any) -> Optional[List[float]]:
    """L2-normalise (needed for Matryoshka-truncated vectors, harmless for
    the rest) so cosine similarity becomes a plain dot product."""
    try:
        vector = [float(v) for v in values]
    except Exception:
        return None
    if not vector:
        return None
    norm = math.sqrt(sum(v * v for v in vector))
    if not norm or math.isnan(norm):
        return None
    return [v / norm for v in vector]


def _post_detail(url: str, headers: Dict[str, str], payload: Dict[str, Any],
                 timeout: float) -> Tuple[Optional[Dict[str, Any]], str]:
    """POST JSON -> (body, "") or (None, short error) - never raises."""
    try:
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers,
            method="POST")
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), ""
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            body = json.loads(error.read().decode("utf-8") or "{}")
            err = body.get("error") if isinstance(body, dict) else None
            if isinstance(err, dict):
                detail = str(err.get("message") or "")
            elif isinstance(body, list) and body and isinstance(body[0], dict):
                detail = str((body[0].get("error") or {}).get("message") or "")
        except Exception:
            detail = ""
        return None, ("HTTP " + str(error.code)
                      + (": " + detail[:160] if detail else ""))
    except Exception as error:
        return None, type(error).__name__ + ": " + str(error)[:120]


def embed_texts(texts: List[str], timeout: Optional[float] = None,
                runtime: Optional[Dict[str, Any]] = None
                ) -> Tuple[Optional[List[List[float]]], str]:
    """Embed up to EMBED_MAX_INPUTS texts in one call.

    Returns (normalised vectors in input order, "") or (None, reason).
    Honours the platform AI gate (kill switch / daily cap) and writes one
    usage-ledger row under the caller's usage_scope. Never raises."""
    items = [str(t or "")[:EMBED_TEXT_CHARS] for t in (texts or [])]
    if not items:
        return [], ""
    if len(items) > EMBED_MAX_INPUTS:
        return None, "too many inputs for one call"
    config = runtime or embed_runtime()
    if not config.get("active") or not config.get("api_key"):
        return None, "embeddings not configured (" + str(
            config.get("reason") or "no_key") + ")"
    if _gated():
        return None, "blocked by the platform AI controls"
    model = str(config.get("model") or "")
    payload: Dict[str, Any] = {"model": model, "input": items}
    dims = int(config.get("dimensions") or 0)
    if dims > 0:
        payload["dimensions"] = dims
    headers = {
        "Authorization": "Bearer " + str(config["api_key"]),
        "Content-Type": "application/json",
    }
    base = str(config.get("base_url") or BASE_URL).rstrip("/")
    started = time.time()
    data, error = _post_detail(base + "/embeddings", headers, payload,
                               float(timeout or EMBED_TIMEOUT_SECONDS))
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(data, dict):
        _record_usage(model, usage, False, started)
        return None, error or "no response"
    rows = data.get("data")
    if not isinstance(rows, list) or len(rows) != len(items):
        _record_usage(model, usage, False, started)
        return None, "unexpected embeddings response"
    try:
        ordered = sorted(rows, key=lambda r: int(r.get("index", 0)))
    except Exception:
        ordered = rows
    vectors: List[List[float]] = []
    for row in ordered:
        vector = normalize_vector((row or {}).get("embedding") or [])
        if vector is None:
            _record_usage(model, usage, False, started)
            return None, "empty embedding in response"
        vectors.append(vector)
    if len({len(v) for v in vectors}) != 1:
        _record_usage(model, usage, False, started)
        return None, "inconsistent embedding sizes"
    _record_usage(model, usage, True, started)
    return vectors, ""


# ---------------------------------------------------------------------------
# D5 media understanding: speech-to-text + image understanding. Same
# contract as chat/embeddings: gated (kill switch / daily cap), one ledger
# row per call under the caller's usage_scope, (result, error), never raises.
# ---------------------------------------------------------------------------

STT_TIMEOUT_SECONDS = float(
    os.environ.get("OF_STT_TIMEOUT_SECONDS", "20") or 20)
VISION_TIMEOUT_SECONDS = float(
    os.environ.get("OF_VISION_TIMEOUT_SECONDS", "15") or 15)
VISION_MAX_TOKENS = max(64, min(1024, int(
    os.environ.get("OF_VISION_MAX_TOKENS", "300") or 300)))


def stt_runtime() -> Optional[Dict[str, str]]:
    """Resolved speech-to-text endpoint (portal_media owns the defaults:
    admin panel -> env -> OpenAI whisper). None when no key is saved."""
    try:
        import portal_media

        resolved = portal_media._stt_config()
    except Exception:
        resolved = None
    if not resolved:
        return None
    base, key, model = resolved
    return {"base_url": base, "api_key": key, "model": model}


def vision_runtime() -> Dict[str, Any]:
    try:
        import platform_settings

        return platform_settings.vision_config()
    except Exception:
        return {"active": False, "reason": "no_key", "api_key": ""}


def transcribe_audio(data: bytes, mime: str, filename: str = "voice-note",
                     language: str = "", timeout: Optional[float] = None,
                     runtime: Optional[Dict[str, str]] = None
                     ) -> Tuple[Optional[str], str]:
    """Speech-to-text via the OpenAI-compatible /audio/transcriptions
    endpoint (Whisper, Groq, ...). Returns (text, "") or (None, reason)."""
    if not data:
        return None, "empty audio"
    config = runtime or stt_runtime()
    if not config or not config.get("api_key"):
        return None, "speech-to-text not configured"
    if _gated():
        return None, "blocked by the platform AI controls"
    try:
        import portal_media

        fields = {"model": str(config.get("model") or "")}
        if language:
            fields["language"] = str(language)[:8]
        body, boundary = portal_media._multipart_body(
            fields, "file", str(filename or "voice-note")[:80],
            str(mime or "audio/ogg")[:80], data)
    except Exception as error:
        return None, "could not build the upload: " + str(error)[:80]
    model = str(config.get("model") or "")
    started = time.time()
    try:
        request = urllib.request.Request(
            str(config["base_url"]).rstrip("/") + "/audio/transcriptions",
            data=body, method="POST")
        request.add_header("Content-Type",
                           "multipart/form-data; boundary=" + boundary)
        request.add_header("Authorization", "Bearer " + str(config["api_key"]))
        with urllib.request.urlopen(
                request, timeout=float(timeout or STT_TIMEOUT_SECONDS)) as resp:
            parsed = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        _record_usage(model, None, False, started)
        return None, "HTTP " + str(error.code)
    except Exception as error:
        _record_usage(model, None, False, started)
        return None, type(error).__name__ + ": " + str(error)[:100]
    text = str((parsed or {}).get("text") or "").strip() \
        if isinstance(parsed, dict) else ""
    _record_usage(model, None, bool(text), started)
    if not text:
        return None, "no speech recognised"
    return text, ""


def describe_image(data: bytes, mime: str, system: str, prompt: str,
                   timeout: Optional[float] = None,
                   runtime: Optional[Dict[str, Any]] = None,
                   max_tokens: int = 0
                   ) -> Tuple[Optional[Dict[str, Any]], str]:
    """One JSON-mode multimodal chat call with an inline image (data URI,
    the OpenAI-compatible shape Gemini and OpenAI both accept).
    Returns (parsed object, "") or (None, reason)."""
    if not data:
        return None, "empty image"
    config = runtime or vision_runtime()
    if not config.get("active") or not config.get("api_key"):
        return None, "image understanding not configured (" + str(
            config.get("reason") or "no_key") + ")"
    if _gated():
        return None, "blocked by the platform AI controls"
    import base64 as _b64

    data_uri = ("data:" + (str(mime or "image/jpeg")[:40]) + ";base64,"
                + _b64.b64encode(data).decode("ascii"))
    model = str(config.get("model") or MODEL)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ]},
        ],
        "temperature": 0,
        "max_tokens": int(max_tokens or VISION_MAX_TOKENS),
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": "Bearer " + str(config["api_key"]),
               "Content-Type": "application/json"}
    base = str(config.get("base_url") or BASE_URL).rstrip("/")
    started = time.time()
    body, error = _post_detail(base + "/chat/completions", headers, payload,
                               float(timeout or VISION_TIMEOUT_SECONDS))
    usage = body.get("usage") if isinstance(body, dict) else None
    if not isinstance(body, dict):
        _record_usage(model, usage, False, started)
        return None, error or "no response"
    try:
        content = body["choices"][0]["message"]["content"]
        parsed = json.loads(content)
    except Exception:
        _record_usage(model, usage, False, started)
        return None, "unexpected vision response"
    if not isinstance(parsed, dict):
        _record_usage(model, usage, False, started)
        return None, "unexpected vision response"
    _record_usage(model, usage, True, started)
    return parsed, ""
