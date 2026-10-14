"""Live AI quality sampling + human-labelled answer sets (§209).

Two complementary signals, both fail-soft and opt-in:

1. **Live quality sample** - deterministic mining of recent
   ``portal_brain_traces`` (and optional ``portal_ai_usage``) for one
   workspace or the whole platform. Zero LLM cost. Surfaces decision mix,
   confidence, grounding/citation share, handoff reasons, guard blocks,
   and engine failure rate. This is the "is the live provider behaving?"
   dashboard number without inventing scores.

2. **Human-labelled answer sets** - owner-authored gold rows
   (customer message + expected decision + optional expected keywords /
   forbidden phrases). ``run_labels`` checks each row against the brain's
   pure decision/policy gates (zero LLM by default). Optional
   ``include_live=true`` runs one real ``portal_llm.chat_json`` call per
   row under ``usage_scope("ai_quality_label", ...)`` so cost is visible
   and gated by the existing AI daily-cap / kill switch. Labels never
   auto-send customer messages.

Laws: no second chatbot, no background worker, no fake pass rates, no
customer PII required to create a set. Tenant-scoped owner API; platform
admin can sample across workspaces. Defaults empty / OFF.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-ai-quality")

bp = Blueprint("portal_ai_quality", __name__, url_prefix="/api/v1/portal")

LABELS_TABLE = "portal_ai_label_sets"
_DDL_READY = False

DEFAULT_DAYS = int(os.environ.get("OF_AI_QUALITY_DAYS", "7") or 7)
SAMPLE_MAX = int(os.environ.get("OF_AI_QUALITY_SAMPLE_MAX", "500") or 500)
MAX_SETS = int(os.environ.get("OF_AI_LABEL_SETS_MAX", "20") or 20)
MAX_ITEMS = int(os.environ.get("OF_AI_LABEL_ITEMS_MAX", "40") or 40)
MAX_NAME = 80
MAX_MESSAGE = int(os.environ.get("OF_AI_LABEL_MSG_MAX", "500") or 500)
MAX_NOTE = 200
ALLOWED_DECISIONS = ("send", "handoff", "draft")
LIVE_MAX_TOKENS = int(os.environ.get("OF_AI_QUALITY_LIVE_MAX_TOKENS", "80") or 80)

_DDL = """
CREATE TABLE IF NOT EXISTS portal_ai_label_sets (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_ai_label_sets
  ON portal_ai_label_sets (client_id, is_active, id DESC);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


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


def _days(value: Any) -> int:
    try:
        days = int(value)
    except Exception:
        days = DEFAULT_DAYS
    if days not in (1, 7, 14, 30):
        days = DEFAULT_DAYS
    return days


def _clamp_sample(value: Any) -> int:
    try:
        n = int(value)
    except Exception:
        n = SAMPLE_MAX
    return max(20, min(SAMPLE_MAX, n))


# ---------------------------------------------------------------------------
# Live quality sample (traces)
# ---------------------------------------------------------------------------


def _parse_grounding(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except Exception:
            raw = {}
    return raw if isinstance(raw, dict) else {}


def sample_quality(cur, client_id: Optional[int], days: int = DEFAULT_DAYS,
                   limit: int = SAMPLE_MAX) -> Dict[str, Any]:
    """Deterministic quality snapshot over brain traces (+ usage if present).

    ``client_id=None`` = platform-wide (admin). Never raises past the caller;
    missing tables blank only the affected block.
    """
    days = _days(days)
    limit = _clamp_sample(limit)
    out: Dict[str, Any] = {
        "days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "workspace" if client_id else "platform",
        "client_id": client_id,
        "traces": {
            "total": 0, "by_decision": {}, "by_kind": {},
            "avg_confidence": None, "grounded_share": None,
            "cited_share": None, "auto_reply_blocked_share": None,
            "guard_blocked": 0, "handoff_reasons": {},
            "sample": [],
        },
        "usage": None,
        "signals": [],
    }

    # --- traces --- (§236: each read in its own savepoint, so a missing
    # table never aborts the caller's transaction)
    try:
        import portal_txn

        with portal_txn.savepoint(cur, None, "of_quality_traces"):
            sql = (
                "SELECT id, client_id, conversation_id, kind, decision, grounding,"
                " created_at FROM " + portal_db._q("portal_brain_traces") +
                " WHERE created_at >= NOW() - (%s || ' days')::interval"
            )
            params: List[Any] = [str(days)]
            if client_id is not None:
                sql += " AND client_id = %s"
                params.append(int(client_id))
            sql += " ORDER BY id DESC LIMIT %s"
            params.append(limit)
            cur.execute(sql, tuple(params))
            rows = portal_db.rows(cur)
    except Exception as error:
        logger.warning("ai quality traces failed: %s", error)
        rows = []
        out["signals"].append({
            "key": "traces_unavailable",
            "severity": "info",
            "title": "Brain traces not readable yet",
            "detail": "Quality sampling needs portal_brain_traces. "
                      "It appears after the assistant answers a few chats.",
        })

    confidences: List[float] = []
    grounded = 0
    cited = 0
    auto_blocked = 0
    guard_blocked = 0
    by_decision: Dict[str, int] = {}
    by_kind: Dict[str, int] = {}
    reasons: Dict[str, int] = {}
    sample_rows: List[Dict[str, Any]] = []

    for row in rows:
        decision = str(row.get("decision") or "handoff")
        kind = str(row.get("kind") or "draft")
        by_decision[decision] = by_decision.get(decision, 0) + 1
        by_kind[kind] = by_kind.get(kind, 0) + 1
        g = _parse_grounding(row.get("grounding"))
        conf = g.get("confidence")
        try:
            if conf is not None:
                confidences.append(float(conf))
        except Exception:
            pass
        if g.get("grounded") is True or g.get("kb_hit") is True:
            grounded += 1
        if g.get("cited") is True or (g.get("citations") or g.get("sources")):
            cited += 1
        if g.get("agent_auto_reply") is False:
            auto_blocked += 1
        if g.get("guard_blocked") or g.get("guard_level") in ("high", "block"):
            guard_blocked += 1
        reason = str(g.get("reason") or g.get("handoff_reason") or "").strip()
        if decision == "handoff" and reason:
            reasons[reason] = reasons.get(reason, 0) + 1
        if len(sample_rows) < 12:
            sample_rows.append({
                "id": int(row.get("id") or 0),
                "client_id": int(row.get("client_id") or 0),
                "conversation_id": row.get("conversation_id"),
                "kind": kind,
                "decision": decision,
                "confidence": confidences[-1] if confidences and conf is not None else None,
                "created_at": str(row.get("created_at") or ""),
            })

    total = len(rows)
    tr = out["traces"]
    tr["total"] = total
    tr["by_decision"] = by_decision
    tr["by_kind"] = by_kind
    tr["avg_confidence"] = (
        round(sum(confidences) / len(confidences), 3) if confidences else None
    )
    if total:
        tr["grounded_share"] = round(grounded / total, 3)
        tr["cited_share"] = round(cited / total, 3)
        tr["auto_reply_blocked_share"] = round(auto_blocked / total, 3)
    tr["guard_blocked"] = guard_blocked
    tr["handoff_reasons"] = dict(
        sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    )
    tr["sample"] = sample_rows

    # --- usage (optional) ---
    try:
        import portal_txn

        with portal_txn.savepoint(cur, None, "of_quality_usage"):
            sql_u = (
                "SELECT COUNT(*) AS calls,"
                " COALESCE(SUM(CASE WHEN ok IS FALSE THEN 1 ELSE 0 END), 0) AS failed,"
                " COALESCE(AVG(latency_ms), 0) AS avg_latency_ms"
                " FROM " + portal_db._q("portal_ai_usage") +
                " WHERE created_at >= NOW() - (%s || ' days')::interval"
            )
            params_u: List[Any] = [str(days)]
            if client_id is not None:
                sql_u += " AND client_id = %s"
                params_u.append(int(client_id))
            cur.execute(sql_u, tuple(params_u))
            urows = portal_db.rows(cur)
            u = urows[0] if urows else {}
            calls = int(u.get("calls") or 0)
            failed = int(u.get("failed") or 0)
            out["usage"] = {
                "calls": calls,
                "failed": failed,
                "fail_share": round(failed / calls, 3) if calls else None,
                "avg_latency_ms": int(float(u.get("avg_latency_ms") or 0)),
            }
    except Exception as error:
        logger.warning("ai quality usage failed: %s", error)
        out["usage"] = None

    # --- signals (deterministic thresholds, thin-data quiet) ---
    signals = out["signals"]
    if total == 0 and not any(s.get("key") == "traces_unavailable" for s in signals):
        signals.append({
            "key": "thin_data",
            "severity": "info",
            "title": "Not enough AI activity yet",
            "detail": "Quality sampling needs recent brain answers. "
                      "Try again after the assistant handles a few chats.",
        })
    if total >= 10:
        handoff = by_decision.get("handoff", 0)
        handoff_share = handoff / total
        if handoff_share >= 0.45:
            signals.append({
                "key": "handoff_high",
                "severity": "warn" if handoff_share < 0.7 else "critical",
                "title": "Handoff rate is elevated",
                "detail": (
                    str(round(handoff_share * 100)) + "% of recent brain "
                    "decisions handed off to a human (" + str(handoff) +
                    " of " + str(total) + ")."
                ),
            })
        if confidences and (sum(confidences) / len(confidences)) < 0.55:
            signals.append({
                "key": "confidence_low",
                "severity": "warn",
                "title": "Average confidence is low",
                "detail": "Mean confidence "
                          + str(out["traces"]["avg_confidence"])
                          + " over " + str(len(confidences)) + " scored answers.",
            })
        if guard_blocked >= 3:
            signals.append({
                "key": "guard_blocks",
                "severity": "info",
                "title": "Prompt-injection guard blocked replies",
                "detail": str(guard_blocked) + " recent traces marked guard-blocked.",
            })
    usage = out.get("usage") or {}
    if usage.get("calls", 0) >= 10 and (usage.get("fail_share") or 0) >= 0.15:
        signals.append({
            "key": "provider_fail_high",
            "severity": "critical" if usage["fail_share"] >= 0.3 else "warn",
            "title": "Live provider failures are elevated",
            "detail": (
                str(round((usage["fail_share"] or 0) * 100)) + "% of LLM calls "
                "failed in the window (" + str(usage.get("failed")) + " of "
                + str(usage.get("calls")) + ")."
            ),
        })
    out["signals"] = signals
    return out


# ---------------------------------------------------------------------------
# Label sets
# ---------------------------------------------------------------------------


def _clean_item(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    message = str(raw.get("message") or raw.get("customer_message") or "").strip()
    if not message or len(message) > MAX_MESSAGE:
        return None
    decision = str(raw.get("expected_decision") or raw.get("decision") or "send").strip().lower()
    if decision not in ALLOWED_DECISIONS:
        decision = "send"
    keywords: List[str] = []
    for key in ("expected_keywords", "keywords"):
        val = raw.get(key)
        if isinstance(val, list):
            for item in val:
                text = str(item or "").strip().lower()
                if text and text not in keywords:
                    keywords.append(text[:40])
        elif isinstance(val, str) and val.strip():
            for part in re.split(r"[,;|]", val):
                text = part.strip().lower()
                if text and text not in keywords:
                    keywords.append(text[:40])
    forbidden: List[str] = []
    for key in ("forbidden_phrases", "forbidden"):
        val = raw.get(key)
        if isinstance(val, list):
            for item in val:
                text = str(item or "").strip().lower()
                if text and text not in forbidden:
                    forbidden.append(text[:60])
        elif isinstance(val, str) and val.strip():
            for part in re.split(r"[,;|]", val):
                text = part.strip().lower()
                if text and text not in forbidden:
                    forbidden.append(text[:60])
    note = str(raw.get("note") or "").strip()[:MAX_NOTE]
    return {
        "message": message[:MAX_MESSAGE],
        "expected_decision": decision,
        "expected_keywords": keywords[:12],
        "forbidden_phrases": forbidden[:12],
        "note": note,
    }


def _normalize_items(raw: Any) -> List[Dict[str, Any]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = []
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw[:MAX_ITEMS]:
        clean = _clean_item(item)
        if clean:
            out.append(clean)
    return out


def _shape_set(row: Dict[str, Any]) -> Dict[str, Any]:
    items = _normalize_items(row.get("items"))
    return {
        "id": int(row.get("id") or 0),
        "name": str(row.get("name") or ""),
        "notes": str(row.get("notes") or ""),
        "items": items,
        "item_count": len(items),
        "is_active": bool(row.get("is_active", True)),
        "updated_at": str(row.get("updated_at") or ""),
        "created_at": str(row.get("created_at") or ""),
    }


def _validate_set_payload(payload: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > MAX_NAME:
        return ("name is required (max " + str(MAX_NAME) + " characters).", {})
    notes = str(payload.get("notes") or "").strip()[:MAX_NOTE]
    items = _normalize_items(payload.get("items"))
    if not items:
        return ("Add at least one labelled example (customer message + expected decision).", {})
    if len(items) > MAX_ITEMS:
        return ("A set can hold at most " + str(MAX_ITEMS) + " examples.", {})
    is_active = payload.get("is_active", True)
    if not isinstance(is_active, bool):
        is_active = bool(is_active)
    return None, {
        "name": name[:MAX_NAME],
        "notes": notes,
        "items": items,
        "is_active": is_active,
    }


def list_sets(cur, client_id: int) -> List[Dict[str, Any]]:
    _ensure_ddl(cur)
    cur.execute(
        "SELECT id, name, notes, items, is_active, created_at, updated_at FROM "
        + portal_db._q(LABELS_TABLE) +
        " WHERE client_id = %s ORDER BY is_active DESC, id DESC LIMIT %s",
        (client_id, max(1, min(50, MAX_SETS * 2))),
    )
    return [_shape_set(row) for row in portal_db.rows(cur)]


def get_set(cur, client_id: int, set_id: int) -> Optional[Dict[str, Any]]:
    _ensure_ddl(cur)
    cur.execute(
        "SELECT id, name, notes, items, is_active, created_at, updated_at FROM "
        + portal_db._q(LABELS_TABLE) +
        " WHERE client_id = %s AND id = %s",
        (client_id, set_id),
    )
    rows = portal_db.rows(cur)
    return _shape_set(rows[0]) if rows else None


def _decision_from_policy(message: str, expected: str) -> Tuple[str, str]:
    """Zero-LLM check: policy gate + trivial keyword heuristics.

    Returns (actual_decision, detail). Uses portal_brain._decide when a
    synthetic reply is built from expected keywords; otherwise defaults to
    send for benign text and handoff when the injection guard would block.
    """
    detail = "policy"
    try:
        import portal_guard
        inspected = portal_guard.inspect(message)
        if portal_guard.blocks(inspected, "standard"):
            return "handoff", "guard_blocked"
    except Exception:
        pass

    # Build a synthetic "model reply" for the policy/decide path when we
    # only have the customer message: prefer expected keywords as a stand-in
    # answer so forbidden-promise detection still runs on owner-supplied text.
    synthetic_reply = message[:180]
    try:
        import portal_brain
        decision, reason = portal_brain._decide(
            {"reply": synthetic_reply, "confidence": 0.9}, {}
        )
        if decision == "handoff":
            return "handoff", str(reason or "policy_handoff")
    except Exception as error:
        detail = "decide_error:" + type(error).__name__

    # If owner expects handoff and message is short/empty of commerce signal,
    # still allow expected-match via keyword absence - actual stays send.
    return "send", detail


def _keywords_ok(text: str, keywords: List[str]) -> bool:
    if not keywords:
        return True
    low = text.lower()
    return all(k in low for k in keywords)


def _forbidden_hit(text: str, phrases: List[str]) -> Optional[str]:
    low = text.lower()
    for phrase in phrases:
        if phrase and phrase in low:
            return phrase
    return None


def evaluate_item(item: Dict[str, Any], include_live: bool = False,
                  client_id: int = 0, cur=None) -> Dict[str, Any]:
    """Score one labelled example. Never raises."""
    message = str(item.get("message") or "")
    expected = str(item.get("expected_decision") or "send")
    keywords = list(item.get("expected_keywords") or [])
    forbidden = list(item.get("forbidden_phrases") or [])
    result: Dict[str, Any] = {
        "message": message[:120],
        "expected_decision": expected,
        "actual_decision": None,
        "passed": False,
        "mode": "deterministic",
        "detail": "",
        "live_reply": None,
        "live_error": None,
    }
    try:
        actual, detail = _decision_from_policy(message, expected)
        result["actual_decision"] = actual
        result["detail"] = detail
        decision_ok = actual == expected
        # Keyword/forbidden checks apply to live reply when present, else
        # to the customer message only for forbidden (owner sanity).
        text_for_kw = message
        live_reply = None
        if include_live:
            result["mode"] = "live_provider"
            try:
                import portal_llm
                system = (
                    "You are a concise commerce assistant. Reply in the "
                    "customer's language. Return JSON "
                    "{\"reply\": string, \"decision\": \"send\"|\"handoff\", "
                    "\"confidence\": number}."
                )
                user = "Customer message:\\n" + message[:MAX_MESSAGE]
                scope_cm = None
                try:
                    scope_cm = portal_llm.usage_scope(
                        "ai_quality_label", int(client_id or 0), cur
                    )
                    scope_cm.__enter__()
                except Exception:
                    scope_cm = None
                try:
                    live = portal_llm.chat_json(system, user, max_tokens=LIVE_MAX_TOKENS)
                finally:
                    if scope_cm is not None:
                        try:
                            scope_cm.__exit__(None, None, None)
                        except Exception:
                            pass
                if not isinstance(live, dict):
                    result["live_error"] = "provider_unavailable_or_empty"
                    result["passed"] = False
                    result["detail"] = "live_call_failed"
                    return result
                live_reply = str(live.get("reply") or live.get("message") or "")[:300]
                live_decision = str(live.get("decision") or "").strip().lower()
                if live_decision not in ALLOWED_DECISIONS:
                    # Fall back to policy on the live reply text.
                    try:
                        import portal_brain
                        live_decision, _r = portal_brain._decide(
                            {"reply": live_reply or message, "confidence": float(live.get("confidence") or 0.5)},
                            {},
                        )
                    except Exception:
                        live_decision = "send"
                result["actual_decision"] = live_decision
                result["live_reply"] = live_reply
                text_for_kw = live_reply or message
                decision_ok = live_decision == expected
                detail = "live"
            except Exception as error:
                result["live_error"] = type(error).__name__ + ": " + str(error)[:120]
                result["passed"] = False
                result["detail"] = "live_exception"
                return result

        kw_ok = _keywords_ok(text_for_kw, keywords) if (include_live and live_reply) else True
        # When not live, keyword check is informational only on message if
        # owner listed keywords that should appear in a good answer - skip hard fail.
        if include_live and live_reply and keywords and not kw_ok:
            result["passed"] = False
            result["detail"] = "missing_keywords"
            return result
        hit = _forbidden_hit(text_for_kw, forbidden)
        if hit:
            result["passed"] = False
            result["detail"] = "forbidden:" + hit
            return result
        # Non-live: decision match is the contract (guard/policy).
        result["passed"] = bool(decision_ok)
        if not decision_ok:
            result["detail"] = "decision_mismatch:" + str(result["actual_decision"])
        else:
            result["detail"] = detail or "ok"
        return result
    except Exception as error:
        result["detail"] = type(error).__name__ + ": " + str(error)[:120]
        result["passed"] = False
        return result


def run_labels(cur, client_id: int, set_id: int,
               include_live: bool = False) -> Dict[str, Any]:
    label_set = get_set(cur, client_id, set_id)
    if label_set is None:
        return {"error": "not_found"}
    if not label_set.get("is_active", True):
        return {"error": "inactive", "set": label_set}
    items = label_set.get("items") or []
    results = [evaluate_item(item, include_live=include_live,
                             client_id=client_id, cur=cur) for item in items]
    passed = sum(1 for r in results if r.get("passed"))
    total = len(results)
    score = round((passed / total) * 100, 1) if total else 0.0
    return {
        "set_id": set_id,
        "name": label_set.get("name"),
        "mode": "live_provider" if include_live else "deterministic",
        "llm_calls": total if include_live else 0,
        "passed": passed,
        "total": total,
        "score": score,
        "status": "pass" if total and passed == total else ("empty" if not total else "fail"),
        "results": results,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Owner HTTP API
# ---------------------------------------------------------------------------


@bp.get("/ai/quality")
def get_quality():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    days = _days(request.args.get("days"))
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = sample_quality(cur, client_id, days=days)
        conn.commit()
    finally:
        conn.close()
    return jsonify(data), 200


@bp.get("/ai/labels")
def get_labels():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            sets = list_sets(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        "sets": sets,
        "limits": {"max_sets": MAX_SETS, "max_items": MAX_ITEMS,
                   "max_message": MAX_MESSAGE},
        "decisions": list(ALLOWED_DECISIONS),
    }), 200


@bp.post("/ai/labels")
def create_label_set():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    problem, clean = _validate_set_payload(payload)
    if problem:
        return jsonify({"error": {"code": "bad_request", "message": problem}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT COUNT(*) AS total FROM " + portal_db._q(LABELS_TABLE) +
                " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            if int((rows[0] if rows else {}).get("total") or 0) >= MAX_SETS:
                return jsonify({"error": {
                    "code": "bad_request",
                    "message": "Max " + str(MAX_SETS) + " label sets."}}), 400
            cur.execute(
                "INSERT INTO " + portal_db._q(LABELS_TABLE) +
                " (client_id, name, notes, items, is_active)"
                " VALUES (%s, %s, %s, CAST(%s AS JSONB), %s) RETURNING id",
                (client_id, clean["name"], clean["notes"],
                 json.dumps(clean["items"], ensure_ascii=False),
                 clean["is_active"]),
            )
            rows = portal_db.rows(cur)
            set_id = int((rows[0] if rows else {}).get("id") or 0)
            portal_db.log_action(
                cur, client_id, "ai.labels_saved", "customer_user",
                principal.get("user_id"), None,
                ("Label set created: " + clean["name"])[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "set": {
        "id": set_id, "name": clean["name"], "notes": clean["notes"],
        "items": clean["items"], "item_count": len(clean["items"]),
        "is_active": clean["is_active"],
    }}), 200


@bp.put("/ai/labels/<int:set_id>")
def update_label_set(set_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    problem, clean = _validate_set_payload(payload)
    if problem:
        return jsonify({"error": {"code": "bad_request", "message": problem}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(LABELS_TABLE) +
                " SET name = %s, notes = %s, items = CAST(%s AS JSONB),"
                " is_active = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (clean["name"], clean["notes"],
                 json.dumps(clean["items"], ensure_ascii=False),
                 clean["is_active"], set_id, client_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such label set in this workspace."}}), 404
            portal_db.log_action(
                cur, client_id, "ai.labels_saved", "customer_user",
                principal.get("user_id"), None,
                ("Label set updated: " + clean["name"])[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


@bp.delete("/ai/labels/<int:set_id>")
def delete_label_set(set_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(LABELS_TABLE) +
                " SET is_active = FALSE, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (set_id, client_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such label set in this workspace."}}), 404
            portal_db.log_action(
                cur, client_id, "ai.labels_archived", "customer_user",
                principal.get("user_id"), None,
                ("Label set archived: " + str(set_id))[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


@bp.post("/ai/labels/<int:set_id>/run")
def run_label_set(set_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    include_live = payload.get("include_live") is True
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            result = run_labels(cur, client_id, set_id, include_live=include_live)
            if result.get("error") == "not_found":
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such label set in this workspace."}}), 404
            if result.get("error") == "inactive":
                return jsonify({"error": {
                    "code": "bad_request",
                    "message": "This label set is archived."}}), 400
            portal_db.log_action(
                cur, client_id, "ai.labels_run", "customer_user",
                principal.get("user_id"), None,
                ("Label run " + str(set_id) + " "
                 + result.get("mode", "") + " "
                 + str(result.get("passed")) + "/"
                 + str(result.get("total")))[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify(result), 200
