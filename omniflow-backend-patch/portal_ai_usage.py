"""AI usage + cost ledger (MASTER-UPGRADE platform service).

Every real LLM call the platform makes goes through ``portal_llm.chat_json``;
that function now reports each call here (feature, model, prompt/completion
tokens straight from the provider's ``usage`` block, latency, ok/failed).
Callers tag their calls with ``portal_llm.usage_scope(feature, client_id,
cur)``; a call without a scope is still counted (feature "other",
workspace 0 = platform).

Cost is an ESTIMATE from a price table the platform admin saves
(Admin -> Integrations -> AI engine -> "Model prices (JSON)" =
``{"gpt-4o-mini": {"input": 0.15, "output": 0.60}}`` in USD per million
tokens; ``"default"`` covers unlisted models; env ``OF_AI_PRICES_JSON`` is
the fallback). No prices saved = tokens only, cost shown as "not
configured" - never a made-up number.

Laws: recording is fail-soft (a ledger problem never fails the customer
message); with a caller cursor the row rides that transaction behind a
SAVEPOINT, otherwise one short connection; ``OF_AI_USAGE=0`` switches the
ledger off. Read API is tenant-scoped and open to API keys (read-only).
"""

import json
import logging
import os
import sys
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import PortalAuthUnavailable, authenticate_portal_request

logger = logging.getLogger("omniflow.portal-ai-usage")

bp = Blueprint("portal_ai_usage", __name__, url_prefix="/api/v1/portal")

TABLE = "portal_ai_usage"
ENABLED = os.environ.get(
    "OF_AI_USAGE", "1").strip().lower() not in ("0", "false", "no", "off")
MAX_DAYS = int(os.environ.get("OF_AI_USAGE_MAX_DAYS", "90") or 90)
DEFAULT_DAYS = 7

#: feature key -> owner-facing label (the usage card renders from this).
FEATURES = (
    ("brain", "AI Brain answers & drafts"),
    ("workflow", "Workflow decisions"),
    ("intent", "Intent classification"),
    ("sentiment", "Sentiment"),
    ("negotiation", "Negotiation replies"),
    ("copy", "Broadcast copy"),
    ("bi_narrative", "Business insights narrative"),
    ("kb_embed", "Knowledge semantic index"),
    ("ai_quality_label", "Labelled-set live checks"),
    ("voice_call", "Phone AI assistant"),
    ("voice_note", "Voice note transcription"),
    ("vision", "Image understanding"),
    ("kb_ocr", "Knowledge document reading (OCR)"),
    ("site_analyzer", "Website analysis"),
    ("assistant", "Ask OmniFlow AI (owner assistant)"),
    ("other", "Other"),
)
FEATURE_LABELS = dict(FEATURES)

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_ai_usage (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL DEFAULT 0,
  feature TEXT NOT NULL DEFAULT 'other',
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_ai_usage_client_time
  ON portal_ai_usage (client_id, created_at DESC);
ALTER TABLE portal_ai_usage
  ADD COLUMN IF NOT EXISTS agent_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_portal_ai_usage_agent
  ON portal_ai_usage (client_id, agent_id, created_at DESC);
ALTER TABLE portal_ai_usage
  ADD COLUMN IF NOT EXISTS route TEXT NOT NULL DEFAULT '';
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# write path
# ---------------------------------------------------------------------------

def _insert(cur, client_id: int, feature: str, model: str, prompt_tokens: int,
            completion_tokens: int, latency_ms: int, ok: bool,
            agent_id: int = 0, route: str = "") -> None:
    aid = int(agent_id or 0) or None
    if route:
        # §229 model router: fast | smart | failover | test
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (client_id, feature, model, prompt_tokens, completion_tokens,"
            " latency_ms, ok, agent_id, route)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (int(client_id or 0), str(feature or "other")[:40],
             str(model or "")[:80], max(0, int(prompt_tokens or 0)),
             max(0, int(completion_tokens or 0)), max(0, int(latency_ms or 0)),
             bool(ok), aid, str(route)[:20]),
        )
        return
    cur.execute(
        "INSERT INTO " + portal_db._q(TABLE) +
        " (client_id, feature, model, prompt_tokens, completion_tokens,"
        " latency_ms, ok, agent_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (int(client_id or 0), str(feature or "other")[:40],
         str(model or "")[:80], max(0, int(prompt_tokens or 0)),
         max(0, int(completion_tokens or 0)), max(0, int(latency_ms or 0)),
         bool(ok), aid),
    )


def record(client_id: int, feature: str, model: str, prompt_tokens: int,
           completion_tokens: int, latency_ms: int, ok: bool,
           cur=None, agent_id: int = 0, route: str = "") -> bool:
    """Append one call to the ledger. Never raises; False when skipped.
    ``route`` = what the model router did (blank = the AI engine)."""
    if not ENABLED:
        return False
    feature = feature if feature in FEATURE_LABELS else "other"
    sandbox = sys.modules.get("portal_sandbox")
    if sandbox is not None and sandbox.capture_usage(
            client_id, feature, model, prompt_tokens, completion_tokens,
            latency_ms, ok, agent_id):
        return True  # §230: written after the sandbox rollback (route sandbox)
    if cur is not None:
        try:
            cur.execute("SAVEPOINT of_ai_usage")
            _ensure_ddl(cur)
            _insert(cur, client_id, feature, model, prompt_tokens,
                    completion_tokens, latency_ms, ok, agent_id=agent_id,
                    **({"route": route} if route else {}))
            cur.execute("RELEASE SAVEPOINT of_ai_usage")
            return True
        except Exception as error:
            logger.warning("ai usage record (tx) failed: %s", error)
            try:
                cur.execute("ROLLBACK TO SAVEPOINT of_ai_usage")
            except Exception:
                pass
            return False
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as own:
                _ensure_ddl(own)
                _insert(own, client_id, feature, model, prompt_tokens,
                        completion_tokens, latency_ms, ok, agent_id=agent_id,
                        **({"route": route} if route else {}))
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception as error:
        logger.warning("ai usage record failed: %s", error)
        return False


# ---------------------------------------------------------------------------
# platform gate (admin AI Control Center): kill switch + daily call cap
# ---------------------------------------------------------------------------

GATE_KILL_SWITCH = "kill_switch"
GATE_DAILY_CAP = "daily_cap"
#: reasons -> owner-facing sentence (notification detail)
GATE_MESSAGES = {
    GATE_KILL_SWITCH: "AI answering is paused platform-wide by the OmniFlow"
                      " team. Replies and drafts resume automatically when"
                      " the pause is lifted.",
    GATE_DAILY_CAP: "This workspace reached its daily AI call limit. AI"
                    " answers and drafts pause until the limit resets;"
                    " human replies are unaffected.",
}


def _count_calls_since(cur, client_id: int, hours: int) -> int:
    cur.execute(
        "SELECT COUNT(*) AS calls FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s"
        " AND created_at > NOW() - make_interval(hours => %s)",
        (int(client_id or 0), int(hours)),
    )
    rows = portal_db.rows(cur)
    return int((rows[0] if rows else {}).get("calls") or 0)


def calls_since(client_id: int, hours: int = 24, cur=None) -> Optional[int]:
    """LLM calls this workspace made in the last ``hours`` (None when the
    ledger cannot be read). With a caller cursor the query rides that
    transaction behind a SAVEPOINT; otherwise one short connection."""
    if cur is not None:
        try:
            cur.execute("SAVEPOINT of_ai_gate")
            value = _count_calls_since(cur, client_id, hours)
            cur.execute("RELEASE SAVEPOINT of_ai_gate")
            return value
        except Exception as error:
            logger.warning("ai gate count (tx) failed: %s", error)
            try:
                cur.execute("ROLLBACK TO SAVEPOINT of_ai_gate")
            except Exception:
                pass
            return None
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as own:
                value = _count_calls_since(own, client_id, hours)
            conn.commit()
        finally:
            conn.close()
        return value
    except Exception as error:
        logger.warning("ai gate count failed: %s", error)
        return None


def gate(feature: str, client_id: int, cur=None) -> Optional[str]:
    """Platform gate every LLM call passes before the provider is called.

    Returns None when the call may proceed, else the blocking reason
    (``kill_switch`` | ``daily_cap``). Fail-open: a storage problem never
    blocks a call. When a workspace hits its daily cap the owner gets ONE
    in-app notification per day (dedupe key ``aicap:<client>:<day>``).
    """
    try:
        import platform_settings

        controls = platform_settings.ai_controls()
    except Exception:
        return None
    if controls.get("kill_switch"):
        return GATE_KILL_SWITCH
    cap = int(controls.get("daily_call_cap") or 0)
    client_id = int(client_id or 0)
    if cap <= 0 or client_id <= 0:
        return None
    used = calls_since(client_id, 24, cur=cur)
    if used is None or used < cap:
        return None
    try:
        import datetime as _dt

        import portal_notify

        day = _dt.datetime.utcnow().strftime("%Y%m%d")
        portal_notify.notify(
            client_id, "system", "Daily AI call limit reached",
            GATE_MESSAGES[GATE_DAILY_CAP] + " (" + str(used) + "/" + str(cap)
            + " calls in the last 24 hours.)", severity="high",
            dedupe_key="aicap:" + str(client_id) + ":" + day)
    except Exception:
        pass
    return GATE_DAILY_CAP


# ---------------------------------------------------------------------------
# prices + cost
# ---------------------------------------------------------------------------

def prices() -> Dict[str, Dict[str, float]]:
    """{model: {"input": usd_per_1M, "output": usd_per_1M}} from the admin
    panel (llm.prices_json) or OF_AI_PRICES_JSON; {} when not configured."""
    raw = ""
    try:
        import platform_settings

        raw = str(platform_settings.get_setting("llm.prices_json", "") or "")
    except Exception:
        raw = ""
    if not raw.strip():
        raw = os.environ.get("OF_AI_PRICES_JSON", "")
    return parse_prices(raw)


def parse_prices(raw: Any) -> Dict[str, Dict[str, float]]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Dict[str, float]] = {}
    for model, value in data.items():
        if not isinstance(value, dict):
            continue
        try:
            entry = {"input": float(value.get("input") or 0),
                     "output": float(value.get("output") or 0)}
        except Exception:
            continue
        if entry["input"] < 0 or entry["output"] < 0:
            continue
        out[str(model).strip().lower()] = entry
    return out


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int,
                  table: Dict[str, Dict[str, float]]) -> Optional[float]:
    """USD for one call, or None when the model is not priced."""
    if not table:
        return None
    price = table.get(str(model or "").strip().lower()) or table.get("default")
    if not price:
        return None
    return round((max(0, int(prompt_tokens or 0)) * price["input"]
                  + max(0, int(completion_tokens or 0)) * price["output"])
                 / 1000000.0, 6)


# ---------------------------------------------------------------------------
# read path
# ---------------------------------------------------------------------------

def _days(value: Any) -> int:
    try:
        days = int(value or DEFAULT_DAYS)
    except Exception:
        days = DEFAULT_DAYS
    return max(1, min(MAX_DAYS, days))


def usage_report(cur, client_id: int, days: int = DEFAULT_DAYS) -> Dict[str, Any]:
    """Totals + per-feature / per-model / per-day rollups for the window."""
    days = _days(days)
    cur.execute(
        "SELECT feature, model, ok, agent_id, COUNT(*) AS calls,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens,"
        " COALESCE(AVG(latency_ms), 0) AS avg_latency_ms"
        " FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY feature, model, ok, agent_id",
        (client_id, days),
    )
    groups = portal_db.rows(cur)
    cur.execute(
        "SELECT DATE(created_at) AS day, COUNT(*) AS calls,"
        " COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens"
        " FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY DATE(created_at) ORDER BY day",
        (client_id, days),
    )
    daily = portal_db.rows(cur)
    table = prices()
    totals = {"calls": 0, "failed": 0, "prompt_tokens": 0,
              "completion_tokens": 0, "latency_weighted": 0.0,
              "cost_usd": 0.0, "unpriced_calls": 0}
    by_feature: Dict[str, Dict[str, Any]] = {}
    by_model: Dict[str, Dict[str, Any]] = {}
    by_agent: Dict[int, Dict[str, Any]] = {}
    for row in groups:
        calls = int(row.get("calls") or 0)
        p_tok = int(row.get("prompt_tokens") or 0)
        c_tok = int(row.get("completion_tokens") or 0)
        ok = bool(row.get("ok"))
        model = str(row.get("model") or "")
        feature = str(row.get("feature") or "other")
        try:
            agent_id = int(row.get("agent_id") or 0)
        except Exception:
            agent_id = 0
        cost = estimate_cost(model, p_tok, c_tok, table)
        totals["calls"] += calls
        totals["failed"] += 0 if ok else calls
        totals["prompt_tokens"] += p_tok
        totals["completion_tokens"] += c_tok
        totals["latency_weighted"] += float(row.get("avg_latency_ms") or 0) * calls
        if cost is None:
            totals["unpriced_calls"] += calls
        else:
            totals["cost_usd"] += cost
        for bucket, key in ((by_feature, feature), (by_model, model or "(unknown)")):
            entry = bucket.setdefault(key, {"calls": 0, "failed": 0, "tokens": 0,
                                            "cost_usd": 0.0, "priced": True})
            entry["calls"] += calls
            entry["failed"] += 0 if ok else calls
            entry["tokens"] += p_tok + c_tok
            if cost is None:
                entry["priced"] = False
            else:
                entry["cost_usd"] += cost
        # agent_id 0 / NULL = unattributed (default brain, no persona)
        akey = agent_id if agent_id > 0 else 0
        aentry = by_agent.setdefault(akey, {"calls": 0, "failed": 0, "tokens": 0,
                                            "cost_usd": 0.0, "priced": True})
        aentry["calls"] += calls
        aentry["failed"] += 0 if ok else calls
        aentry["tokens"] += p_tok + c_tok
        if cost is None:
            aentry["priced"] = False
        else:
            aentry["cost_usd"] += cost
    priced = bool(table) and totals["unpriced_calls"] == 0
    calls = totals["calls"]
    agent_names: Dict[int, str] = {}
    try:
        ids = [aid for aid in by_agent.keys() if aid > 0]
        if ids:
            cur.execute(
                "SELECT id, name FROM " + portal_db._q("portal_agents") +
                " WHERE client_id = %s AND id = ANY(%s)",
                (client_id, ids),
            )
            for row in portal_db.rows(cur):
                agent_names[int(row.get("id") or 0)] = str(row.get("name") or "")
    except Exception as error:
        logger.warning("ai usage agent names failed: %s", error)
    by_agent_list = []
    for aid, v in sorted(by_agent.items(), key=lambda i: -i[1]["calls"]):
        by_agent_list.append({
            "agent_id": aid if aid > 0 else None,
            "name": (agent_names.get(aid) if aid > 0 else None) or (
                "Unattributed" if aid == 0 else ("Agent #" + str(aid))),
            "calls": v["calls"],
            "failed": v["failed"],
            "tokens": v["tokens"],
            "cost_usd": round(v["cost_usd"], 4) if v["priced"] and table else None,
            "share": round(v["calls"] / calls, 3) if calls else 0.0,
        })
    return {
        "days": days,
        "totals": {
            "calls": calls,
            "failed": totals["failed"],
            "prompt_tokens": totals["prompt_tokens"],
            "completion_tokens": totals["completion_tokens"],
            "tokens": totals["prompt_tokens"] + totals["completion_tokens"],
            "avg_latency_ms": (int(totals["latency_weighted"] / calls)
                               if calls else 0),
            "cost_usd": round(totals["cost_usd"], 4) if priced else None,
            "priced": priced,
            "unpriced_calls": totals["unpriced_calls"],
        },
        "by_feature": [
            {"feature": key, "label": FEATURE_LABELS.get(key, key),
             "calls": v["calls"], "failed": v["failed"], "tokens": v["tokens"],
             "cost_usd": round(v["cost_usd"], 4) if v["priced"] and table else None}
            for key, v in sorted(by_feature.items(), key=lambda i: -i[1]["calls"])
        ],
        "by_model": [
            {"model": key, "calls": v["calls"], "failed": v["failed"],
             "tokens": v["tokens"],
             "cost_usd": round(v["cost_usd"], 4) if v["priced"] and table else None}
            for key, v in sorted(by_model.items(), key=lambda i: -i[1]["calls"])
        ],
        "by_day": [
            {"day": (row.get("day").isoformat() if hasattr(row.get("day"), "isoformat")
                     else str(row.get("day"))),
             "calls": int(row.get("calls") or 0),
             "tokens": int(row.get("tokens") or 0)}
            for row in daily
        ],
        "prices_configured": bool(table),
        "features": [{"key": k, "label": l} for k, l in FEATURES],
        "by_agent": by_agent_list,
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


@bp.get("/ai/usage")
def get_usage():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    days = _days(request.args.get("days"))
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            report = usage_report(cur, client_id, days)
        conn.commit()
    finally:
        conn.close()
    return jsonify(report), 200
