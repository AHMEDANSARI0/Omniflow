"""Model Router (§229) - which model answers which AI task, with failover.

Two providers:
- primary   = the AI engine (Admin > Integrations > AI engine / OF_LLM_*),
- secondary = an optional second OpenAI-compatible provider (another
  vendor, or a second key on the same one).
Two tiers on top of them:
- fast  = light classification work (intent, sentiment, workflow branch),
- smart = customer-facing writing (brain replies, negotiation, copy, ...).
Each tier picks a provider and a model; every routable feature picks a
tier (fast | smart | main), with sensible defaults. ``main`` is the AI
engine exactly as before.

Failover: when the chosen provider does not answer (transport error,
HTTP error, timeout) the call is retried once on the other provider. A
provider answering with unusable JSON is NOT failed over (that is the
model, not the provider). A small in-process circuit breaker skips a
provider after N consecutive failures for S seconds when the other one
can serve the call.

Zero configuration = today's behaviour: blank tier models resolve to the
AI engine's model on the AI engine, and failover needs a secondary key.
Dedicated routes keep their own settings (assistant, image understanding,
voice notes, knowledge embeddings) and are shown on the admin page.

Standard library only (portal_llm imports this on the hot path); config
is read through platform_settings' 30-second cache with env fallbacks.
Admin API (service key): GET /api/v1/admin/ai/router, POST .../test.
Saving goes through the existing PUT /api/v1/admin/providers (group
``router``), validated by clean_value() below.
"""

import json
import logging
import os
import re
import secrets as _secrets
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

logger = logging.getLogger("omniflow.model-router")

MODES = ("on", "off")
PROVIDERS = ("primary", "secondary")
TIERS = ("fast", "smart", "main")

#: feature -> default tier. Only features that call portal_llm.chat_json.
ROUTABLE: Tuple[Tuple[str, str], ...] = (
    ("brain", "smart"),
    ("voice_call", "smart"),
    ("negotiation", "smart"),
    ("copy", "smart"),
    ("bi_narrative", "smart"),
    ("site_analyzer", "smart"),
    ("ai_quality_label", "smart"),
    ("workflow_gen", "smart"),
    ("rule_conflicts", "smart"),
    ("nl_analytics", "fast"),
    ("ai_report", "fast"),
    ("handoff_brief", "fast"),
    ("workflow", "fast"),
    ("intent", "fast"),
    ("sentiment", "fast"),
    ("other", "main"),
)
DEFAULT_TIERS = dict(ROUTABLE)

TEST_TIMEOUT_SECONDS = float(os.environ.get("OF_ROUTER_TEST_TIMEOUT", "12") or 12)
MAX_MODEL_CHARS = 120
MAX_DAYS = 90
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:/@+\-]{1,120}$")
_URL_RE = re.compile(r"^https?://[^\s?#]+$")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _setting(name: str, env: str, default: str = "") -> str:
    """Admin panel first (cached), env fallback, then default."""
    value = ""
    try:
        import platform_settings

        value = platform_settings._cached("router." + name)
    except Exception:
        value = ""
    return value or _env(env, default)


def _bounded(raw: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(raw or "").strip() or default)
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def parse_routes(raw: Any) -> Dict[str, str]:
    """routes_json -> {feature: tier}; unknown features / tiers dropped."""
    try:
        data = json.loads(raw) if isinstance(raw, str) and raw.strip() else raw
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items()
            if str(k) in DEFAULT_TIERS and str(v) in TIERS}


def settings() -> Dict[str, Any]:
    """Effective router config (fail-soft, never raises)."""
    mode = _setting("mode", "OF_ROUTER_MODE", "on").lower()
    failover = _setting("failover", "OF_ROUTER_FAILOVER", "on").lower()
    tiers = {}
    for tier in ("fast", "smart"):
        provider = _setting(tier + "_provider",
                            "OF_ROUTER_" + tier.upper() + "_PROVIDER",
                            "primary").lower()
        tiers[tier] = {
            "provider": provider if provider in PROVIDERS else "primary",
            "model": _setting(tier + "_model",
                              "OF_ROUTER_" + tier.upper() + "_MODEL"),
        }
    return {
        "mode": mode if mode in MODES else "on",
        "failover": failover if failover in MODES else "on",
        "tiers": tiers,
        "routes": parse_routes(_setting("routes_json", "OF_ROUTER_ROUTES_JSON")),
        "secondary": {
            "base_url": _setting("secondary_base_url",
                                 "OF_ROUTER_SECONDARY_BASE_URL").rstrip("/"),
            "api_key": _setting("secondary_api_key",
                                "OF_ROUTER_SECONDARY_API_KEY"),
            "model": _setting("secondary_model", "OF_ROUTER_SECONDARY_MODEL"),
        },
        "breaker_failures": _bounded(
            _setting("breaker_failures", "OF_ROUTER_BREAKER_FAILURES"), 3, 1, 20),
        "breaker_seconds": _bounded(
            _setting("breaker_seconds", "OF_ROUTER_BREAKER_SECONDS"), 60, 10, 3600),
    }


def tier_for(feature: str, config: Optional[Dict[str, Any]] = None) -> str:
    config = config if config is not None else settings()
    feature = feature if feature in DEFAULT_TIERS else "other"
    return config["routes"].get(feature) or DEFAULT_TIERS[feature]


# ---------------------------------------------------------------------------
# circuit breaker (per process; serverless instances each keep their own)
# ---------------------------------------------------------------------------

_LOCK = threading.Lock()
_BREAKER: Dict[str, Dict[str, Any]] = {}


def note(provider: str, ok: bool, config: Optional[Dict[str, Any]] = None) -> None:
    """Record one provider outcome; opens the breaker after N failures."""
    if provider not in PROVIDERS:
        return
    try:
        config = config if config is not None else settings()
        with _LOCK:
            state = _BREAKER.setdefault(provider, {
                "failures": 0, "open_until": 0.0, "last_failure_at": 0.0})
            if ok:
                state["failures"] = 0
                state["open_until"] = 0.0
                return
            state["failures"] += 1
            state["last_failure_at"] = time.time()
            if state["failures"] >= config["breaker_failures"]:
                state["open_until"] = time.time() + config["breaker_seconds"]
                logger.warning("model router: %s provider paused for %ss after"
                               " %s failures", provider,
                               config["breaker_seconds"], state["failures"])
    except Exception:
        pass


def is_open(provider: str) -> bool:
    with _LOCK:
        state = _BREAKER.get(provider)
        return bool(state and state["open_until"] > time.time())


def breaker_state() -> Dict[str, Dict[str, Any]]:
    now = time.time()
    out = {}
    with _LOCK:
        for provider in PROVIDERS:
            state = _BREAKER.get(provider) or {}
            until = float(state.get("open_until") or 0.0)
            out[provider] = {
                "failures": int(state.get("failures") or 0),
                "paused": until > now,
                "paused_seconds_left": max(0, int(until - now)),
            }
    return out


def reset_breaker() -> None:
    with _LOCK:
        _BREAKER.clear()


# ---------------------------------------------------------------------------
# planning (portal_llm calls this for every chat_json)
# ---------------------------------------------------------------------------

def _target(provider: str, base_url: str, api_key: str, model: str,
            route: str) -> Dict[str, Any]:
    return {"provider": provider, "base_url": str(base_url or "").rstrip("/"),
            "api_key": str(api_key or ""), "model": str(model or ""),
            "route": route}


def plan(feature: str, primary: Dict[str, Any],
         config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordered targets for one call: [chosen] or [chosen, failover].

    ``primary`` = the AI engine runtime (base_url, api_key, model).
    ``route`` on a target is "" when it is exactly the AI engine (the
    ledger then looks like before), else fast | smart | failover.
    """
    main = _target("primary", primary.get("base_url"), primary.get("api_key"),
                   primary.get("model"), "")
    config = config if config is not None else settings()
    if config["mode"] != "on":
        return [main]
    secondary = config["secondary"]
    has_secondary = bool(secondary["api_key"])
    secondary_base = secondary["base_url"] or main["base_url"]
    tier = tier_for(feature, config)
    first = main
    if tier in ("fast", "smart"):
        chosen = config["tiers"][tier]
        if chosen["provider"] == "secondary" and has_secondary:
            first = _target("secondary", secondary_base, secondary["api_key"],
                            chosen["model"] or secondary["model"]
                            or main["model"], tier)
        elif chosen["model"] and chosen["model"] != main["model"]:
            first = _target("primary", main["base_url"], main["api_key"],
                            chosen["model"], tier)
    targets = [first]
    if config["failover"] == "on" and has_secondary:
        if first["provider"] == "primary":
            second = _target("secondary", secondary_base, secondary["api_key"],
                             secondary["model"] or first["model"], "failover")
        else:
            second = dict(main, route="failover")
        if is_open(first["provider"]) and not is_open(second["provider"]):
            return [second]
        targets.append(second)
    return targets


def failover_for(model: str, config: Optional[Dict[str, Any]] = None
                 ) -> Optional[Dict[str, Any]]:
    """The secondary provider as a failover target for a dedicated route
    (the owner assistant), or None when failover is off / not set up."""
    try:
        config = config if config is not None else settings()
    except Exception:
        return None
    secondary = config["secondary"]
    if config["mode"] != "on" or config["failover"] != "on" \
            or not secondary["api_key"]:
        return None
    base = secondary["base_url"]
    if not base:
        try:
            import platform_settings

            base = platform_settings.llm_config().get("base_url") or ""
        except Exception:
            base = ""
    if not base:
        return None
    return _target("secondary", base, secondary["api_key"],
                   secondary["model"] or model, "failover")


# ---------------------------------------------------------------------------
# admin validation (called by admin_providers for group "router")
# ---------------------------------------------------------------------------

def clean_value(name: str, text: str) -> Tuple[str, Optional[str]]:
    """Normalise one router setting; (value, None) or (value, error)."""
    text = str(text or "").strip()
    full = "router." + name
    if not text:
        return "", None
    if name in ("mode", "failover"):
        text = text.lower()
        if text not in MODES:
            return text, full + " must be on or off."
    elif name in ("fast_provider", "smart_provider"):
        text = text.lower()
        if text not in PROVIDERS:
            return text, full + " must be primary or secondary."
    elif name in ("fast_model", "smart_model", "secondary_model"):
        if not _MODEL_RE.match(text):
            return text, (full + " must be a model name without spaces ("
                          + str(MAX_MODEL_CHARS) + " characters max).")
    elif name == "secondary_base_url":
        text = text.rstrip("/")
        if len(text) > 300 or not _URL_RE.match(text):
            return text, (full + " must be an http(s) address such as"
                          " https://api.groq.com/openai/v1 (no query).")
    elif name == "secondary_api_key":
        if len(text) > 400 or any(ch.isspace() for ch in text):
            return text, full + " looks wrong (no spaces, 400 characters max)."
    elif name == "routes_json":
        try:
            data = json.loads(text)
        except Exception:
            return text, full + " must be a JSON object."
        if not isinstance(data, dict):
            return text, full + " must be a JSON object."
        for key, value in data.items():
            if key not in DEFAULT_TIERS:
                return text, full + ": unknown task \"" + str(key)[:40] + "\"."
            if value not in TIERS:
                return text, (full + ": \"" + str(key) + "\" must be fast,"
                              " smart or main.")
        text = json.dumps({k: data[k] for k in sorted(data)
                           if data[k] != DEFAULT_TIERS[k]},
                          separators=(",", ":"))
        if text == "{}":
            text = ""
    elif name == "breaker_failures":
        if not text.isdigit() or not 1 <= int(text) <= 20:
            return text, full + " must be a whole number between 1 and 20."
    elif name == "breaker_seconds":
        if not text.isdigit() or not 10 <= int(text) <= 3600:
            return text, full + " must be a whole number between 10 and 3600."
    return text, None


# ---------------------------------------------------------------------------
# admin API
# ---------------------------------------------------------------------------

bp = Blueprint("admin_model_router", __name__, url_prefix="/api/v1/admin/ai")


def _authorized() -> bool:
    key = request.headers.get("X-Omniflow-Key", "")
    if not key:
        return False
    accepted = [os.environ.get("OMNIFLOW_SERVICE_KEY"),
                os.environ.get("OMNIFLOW_ADMIN_API_KEY")]
    return any(k for k in accepted if k and _secrets.compare_digest(key, k))


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not _authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403


def _mask(value: str) -> str:
    value = str(value or "")
    if not value:
        return ""
    return "\u2022\u2022\u2022\u2022" + value[-4:] if len(value) > 4 \
        else "\u2022\u2022\u2022\u2022"


def _labels() -> Dict[str, str]:
    try:
        import portal_ai_usage

        return dict(portal_ai_usage.FEATURE_LABELS)
    except Exception:
        return {}


def _primary() -> Dict[str, Any]:
    try:
        import platform_settings

        return platform_settings.llm_config()
    except Exception:
        return {"base_url": "", "api_key": "", "model": "", "enabled": False}


def _dedicated() -> List[Dict[str, Any]]:
    """Routes with their own settings group (read-only on the page)."""
    labels = _labels()
    out = []
    try:
        import platform_settings
    except Exception:
        return out
    for feature, reader in (("assistant", "assistant_config"),
                            ("vision", "vision_config")):
        try:
            cfg = getattr(platform_settings, reader)()
            out.append({"feature": feature, "label": labels.get(feature, feature),
                        "model": str(cfg.get("model") or ""),
                        "key_source": str(cfg.get("key_source") or "none"),
                        "active": bool(cfg.get("active")),
                        "reason": str(cfg.get("reason") or ""),
                        "failover": feature == "assistant"})
        except Exception:
            continue
    try:
        import portal_llm

        stt = portal_llm.stt_runtime()
        out.append({"feature": "voice_note", "label": labels.get("voice_note", "voice_note"),
                    "model": str((stt or {}).get("model") or ""),
                    "key_source": "stt" if stt else "none", "active": bool(stt),
                    "reason": "active" if stt else "no_key", "failover": False})
        embed = portal_llm.embed_runtime()
        out.append({"feature": "kb_embed", "label": labels.get("kb_embed", "kb_embed"),
                    "model": str(embed.get("model") or ""),
                    "key_source": str(embed.get("key_source") or "none"),
                    "active": bool(embed.get("active")),
                    "reason": str(embed.get("reason") or ""), "failover": False})
    except Exception:
        pass
    return out


def _usage(days: int) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    try:
        import portal_ai_usage
        import portal_db

        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                portal_ai_usage._ensure_ddl(cur)
                cur.execute(
                    "SELECT feature, model, COALESCE(route, '') AS route, ok,"
                    " COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS pt,"
                    " COALESCE(SUM(completion_tokens), 0) AS ct,"
                    " COALESCE(SUM(latency_ms), 0) AS ms"
                    " FROM " + portal_db._q(portal_ai_usage.TABLE) +
                    " WHERE created_at >= NOW() - (%s * INTERVAL '1 day')"
                    " GROUP BY feature, model, COALESCE(route, ''), ok",
                    (int(days),))
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
        return rows or [], None
    except Exception as error:
        logger.warning("model router usage read failed: %s", error)
        return [], "Usage is temporarily unavailable."


def overview(days: int) -> Dict[str, Any]:
    config = settings()
    primary = _primary()
    labels = _labels()
    try:
        import platform_settings

        stored = platform_settings.get_group("router")
    except Exception:
        stored = {}
    try:
        import portal_ai_usage

        prices = portal_ai_usage.prices()
        estimate = portal_ai_usage.estimate_cost
    except Exception:
        prices, estimate = {}, None
    rows, usage_error = _usage(days)

    per_feature: Dict[str, Dict[str, Any]] = {}
    per_model: Dict[str, Dict[str, Any]] = {}
    totals = {"calls": 0, "failed": 0, "failovers": 0, "routed": 0,
              "tokens": 0, "cost_usd": 0.0 if prices else None}
    for row in rows:
        calls = int(row.get("calls") or 0)
        pt, ct = int(row.get("pt") or 0), int(row.get("ct") or 0)
        failed = 0 if row.get("ok") else calls
        route = str(row.get("route") or "")
        cost = estimate(str(row.get("model") or ""), pt, ct, prices) \
            if estimate and prices else None
        bucket = per_feature.setdefault(str(row.get("feature") or "other"), {
            "calls": 0, "failed": 0, "failovers": 0, "tokens": 0, "cost_usd": None})
        model = per_model.setdefault(str(row.get("model") or "-"), {
            "model": str(row.get("model") or "-"), "calls": 0, "failed": 0,
            "tokens": 0, "latency_ms_total": 0, "cost_usd": None})
        for target in (bucket, model):
            target["calls"] += calls
            target["failed"] += failed
            target["tokens"] += pt + ct
            if cost is not None:
                target["cost_usd"] = round((target["cost_usd"] or 0.0) + cost, 6)
        model["latency_ms_total"] += int(row.get("ms") or 0)
        if route == "failover":
            bucket["failovers"] += calls
            totals["failovers"] += calls
        if route in ("fast", "smart", "failover"):
            totals["routed"] += calls
        totals["calls"] += calls
        totals["failed"] += failed
        totals["tokens"] += pt + ct
        if cost is not None:
            totals["cost_usd"] = round((totals["cost_usd"] or 0.0) + cost, 6)

    secondary = config["secondary"]
    has_secondary = bool(secondary["api_key"])
    main_model = str(primary.get("model") or "")

    def effective(tier: str) -> Dict[str, Any]:
        if tier == "main" or config["mode"] != "on":
            return {"provider": "primary", "model": main_model}
        chosen = config["tiers"][tier]
        if chosen["provider"] == "secondary" and has_secondary:
            return {"provider": "secondary",
                    "model": chosen["model"] or secondary["model"] or main_model}
        return {"provider": "primary", "model": chosen["model"] or main_model}

    routes = []
    for feature, default_tier in ROUTABLE:
        tier = tier_for(feature, config)
        used = per_feature.get(feature, {})
        routes.append(dict(
            {"feature": feature, "label": labels.get(feature, feature),
             "tier": tier, "default_tier": default_tier},
            **effective(tier),
            calls=int(used.get("calls") or 0), failed=int(used.get("failed") or 0),
            failovers=int(used.get("failovers") or 0),
            tokens=int(used.get("tokens") or 0), cost_usd=used.get("cost_usd")))

    warnings = []
    if not primary.get("api_key"):
        warnings.append("The AI engine has no API key - AI features stay off"
                        " until it is set in Integrations.")
    elif not primary.get("enabled"):
        warnings.append("OF_LLM_ENABLED switches the AI engine off on the"
                        " Control Plane.")
    for tier in ("fast", "smart"):
        if config["tiers"][tier]["provider"] == "secondary" and not has_secondary:
            warnings.append(tier.capitalize() + " tasks are set to the secondary"
                            " provider, but it has no API key - they use the"
                            " AI engine.")
    if config["mode"] == "off":
        warnings.append("Routing is off - every task uses the AI engine model.")
    elif config["failover"] == "on" and not has_secondary:
        warnings.append("Failover is on, but there is no secondary provider"
                        " yet - add one to keep AI running during an outage.")
    if prices:
        unpriced = sorted({r["model"] for r in routes
                           if r["model"] and r["model"].lower() not in prices
                           and "default" not in prices})
        if unpriced:
            warnings.append("No price saved for " + ", ".join(unpriced[:5])
                            + " - their cost is not counted.")

    models = sorted(per_model.values(), key=lambda m: -m["calls"])
    for item in models:
        item["avg_latency_ms"] = int(item.pop("latency_ms_total")
                                     / item["calls"]) if item["calls"] else 0
    return {
        "mode": config["mode"],
        "failover": config["failover"],
        "settings": {
            "mode": str(stored.get("mode") or ""),
            "failover": str(stored.get("failover") or ""),
            "fast_provider": str(stored.get("fast_provider") or ""),
            "fast_model": str(stored.get("fast_model") or ""),
            "smart_provider": str(stored.get("smart_provider") or ""),
            "smart_model": str(stored.get("smart_model") or ""),
            "routes": parse_routes(stored.get("routes_json") or ""),
            "secondary_base_url": str(stored.get("secondary_base_url") or ""),
            "secondary_api_key": _mask(str(stored.get("secondary_api_key") or "")),
            "secondary_model": str(stored.get("secondary_model") or ""),
            "breaker_failures": str(stored.get("breaker_failures") or ""),
            "breaker_seconds": str(stored.get("breaker_seconds") or ""),
        },
        "primary": {"configured": bool(primary.get("api_key")),
                    "enabled": bool(primary.get("enabled")),
                    "base_url": str(primary.get("base_url") or ""),
                    "model": main_model},
        "secondary": {"configured": has_secondary,
                      "base_url": secondary["base_url"]
                      or str(primary.get("base_url") or ""),
                      "model": secondary["model"],
                      "from_env": has_secondary
                      and not stored.get("secondary_api_key")},
        "tiers": {tier: effective(tier) for tier in TIERS},
        "routes": routes,
        "dedicated": _dedicated(),
        "breaker": {"failures": config["breaker_failures"],
                    "seconds": config["breaker_seconds"],
                    "state": breaker_state()},
        "usage": dict(totals, days=days, models=models[:20], error=usage_error),
        "prices_configured": bool(prices),
        "warnings": warnings,
    }


@bp.get("/router")
def get_router():
    try:
        days = int(request.args.get("days") or 7)
    except (TypeError, ValueError):
        days = 7
    return jsonify(overview(max(1, min(MAX_DAYS, days)))), 200


def _test_target(name: str) -> Tuple[Optional[Dict[str, Any]], str]:
    primary = _primary()
    main = _target("primary", primary.get("base_url"), primary.get("api_key"),
                   primary.get("model"), "")
    config = settings()
    if name == "primary":
        return (main if main["api_key"] else None), \
            "The AI engine has no API key yet."
    if name == "secondary":
        secondary = config["secondary"]
        if not secondary["api_key"]:
            return None, "Add the secondary provider's API key first."
        return _target("secondary", secondary["base_url"] or main["base_url"],
                       secondary["api_key"],
                       secondary["model"] or main["model"], "test"), ""
    feature = {"fast": "intent", "smart": "brain"}[name]
    forced = dict(config, mode="on", failover="off",
                  routes={feature: name})
    target = plan(feature, main, forced)[0]
    if not target["api_key"]:
        return None, "The AI engine has no API key yet."
    return target, ""


@bp.post("/router/test")
def post_test():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("target") or "").strip().lower()
    if name not in ("primary", "secondary", "fast", "smart"):
        return jsonify({"error": {"code": "bad_request", "message":
                                  "target must be primary, secondary, fast or smart."}}), 400
    target, why = _test_target(name)
    if target is None:
        return jsonify({"error": {"code": "not_configured", "message": why}}), 409
    import portal_llm

    body = {"model": target["model"], "temperature": 0, "max_tokens": 16,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content":
                          "Health check. Reply with the JSON object {\"ok\": true}."},
                         {"role": "user", "content": "ping"}]}
    started = time.time()
    data, error = portal_llm._post_detail(
        target["base_url"] + "/chat/completions",
        {"Authorization": "Bearer " + target["api_key"],
         "Content-Type": "application/json"}, body, TEST_TIMEOUT_SECONDS)
    latency = int((time.time() - started) * 1000)
    ok = False
    if isinstance(data, dict):
        try:
            ok = isinstance(json.loads(data["choices"][0]["message"]["content"]), dict)
        except Exception:
            ok = False
        if not ok:
            error = error or "The model answered, but not with JSON."
    usage = data.get("usage") if isinstance(data, dict) else None
    try:
        import portal_ai_usage

        usage = usage if isinstance(usage, dict) else {}
        portal_ai_usage.record(0, "other", target["model"],
                               int(usage.get("prompt_tokens") or 0),
                               int(usage.get("completion_tokens") or 0),
                               latency, ok, route="test")
    except Exception:
        pass
    return jsonify({"ok": ok, "target": name, "provider": target["provider"],
                    "model": target["model"], "latency_ms": latency,
                    "error": "" if ok else (error or "No answer.")[:200]}), 200
