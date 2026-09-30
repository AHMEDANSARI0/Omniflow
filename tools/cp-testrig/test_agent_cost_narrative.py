"""§210 Per-agent cost split + BI narrative summaries (optional LLM)."""
import json
import os
import sys
from unittest import mock

_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)

import portal_ai_usage as usage
import portal_bi as bi
import portal_llm as llm
from test_lib import check, install_db_stub, summary

print("== usage_scope agent_id ==")

with llm.usage_scope("brain", 7, None, agent_id=42):
    feat, cid, cur, aid = llm.current_scope()
check("scope 4-tuple feature", feat == "brain", feat)
check("scope client", cid == 7, cid)
check("scope agent", aid == 42, aid)

with llm.usage_scope("brain", 1):
    feat, cid, cur, aid = llm.current_scope()
check("default agent 0", aid == 0, aid)

print("== DDL agent_id ==")
check("DDL ALTER agent_id", "ADD COLUMN IF NOT EXISTS agent_id" in usage._DDL, "-")
check("bi_narrative feature", "bi_narrative" in usage.FEATURE_LABELS, usage.FEATURE_LABELS)
check("ai_quality_label feature", "ai_quality_label" in usage.FEATURE_LABELS, "-")

print("== record with agent_id ==")
usage._DDL_READY = True
conn = install_db_stub(usage, [[]])  # ensure_ddl path may not run if already ready
# _insert via record with own conn - need script for ensure + insert
# record opens own connection when cur=None - install on module
conn = install_db_stub(usage, [
    [],  # ensure ddl execute may be multi - _ensure_ddl runs full _DDL one execute
    1,   # insert
])
# Actually _ensure_ddl is one execute of whole DDL string
ok = usage.record(1, "brain", "gpt-x", 10, 5, 100, True, agent_id=9)
check("record ok", ok is True, ok)
ins = [e for e in conn.cur.executed if "INSERT" in e[0]]
check("insert has agent_id col", ins and "agent_id" in ins[0][0], ins[0][0] if ins else "-")
check("insert agent param 9", ins and 9 in ins[0][1], ins[0][1] if ins else "-")

print("== usage_report by_agent ==")
# groups query, daily query, agent names query
conn = install_db_stub(usage, [
    [
        {"feature": "brain", "model": "m", "ok": True, "agent_id": 3,
         "calls": 4, "prompt_tokens": 100, "completion_tokens": 50,
         "avg_latency_ms": 80},
        {"feature": "brain", "model": "m", "ok": True, "agent_id": None,
         "calls": 6, "prompt_tokens": 200, "completion_tokens": 100,
         "avg_latency_ms": 90},
        {"feature": "workflow", "model": "m", "ok": False, "agent_id": 3,
         "calls": 1, "prompt_tokens": 10, "completion_tokens": 0,
         "avg_latency_ms": 40},
    ],
    [{"day": "2026-09-28", "calls": 11, "tokens": 460}],
    [{"id": 3, "name": "Sales Aunty"}],
])
# mock prices empty so cost null is fine
with mock.patch.object(usage, "prices", return_value={}):
    report = usage.usage_report(conn.cur, 1, 7)
check("by_agent present", isinstance(report.get("by_agent"), list), report)
check("two agent buckets", len(report["by_agent"]) == 2, report["by_agent"])
named = [a for a in report["by_agent"] if a.get("agent_id") == 3]
check("named agent", named and named[0]["name"] == "Sales Aunty", named)
check("agent calls 5", named and named[0]["calls"] == 5, named)  # 4+1
unattr = [a for a in report["by_agent"] if a.get("agent_id") is None]
check("unattributed", unattr and unattr[0]["name"] == "Unattributed", unattr)
check("share sums ~1",
      abs(sum(a["share"] for a in report["by_agent"]) - 1.0) < 0.01,
      report["by_agent"])

print("== narrative deterministic ==")

base = bi._narrative_deterministic(
    {"topics": {"messages": 40, "topics": [{"label": "Delivery", "count": 12}]}},
    {"decisions": 20, "handoff_share": 0.25, "avg_confidence": 0.8},
    {"contacts": 15},
    [
        {"severity": "critical", "title": "Knowledge gaps growing",
         "action": {"label": "Open knowledge"}},
        {"severity": "warn", "title": "Handoffs rising"},
    ],
    7,
)
check("mode deterministic", base["mode"] == "deterministic", base)
check("no llm", base["llm_used"] is False, base)
check("headline critical", "critical" in base["headline"].lower(), base["headline"])
check("paragraphs non-empty", len(base["paragraphs"]) >= 2, base["paragraphs"])
check("bullets have FIX", any("FIX" in b for b in base["bullets"]), base["bullets"])
check("mentions delivery", any("Delivery" in p for p in base["paragraphs"]), base["paragraphs"])

quiet = bi._narrative_deterministic({}, {}, {}, [], 7)
check("quiet steady-ish or snapshot", "snapshot" in quiet["headline"].lower()
      or "steady" in quiet["headline"].lower()
      or "enough" in " ".join(quiet["paragraphs"]).lower(), quiet)

print("== narrative LLM polish fail-soft ==")
bi.NARRATIVE_LLM = True
with mock.patch.dict(sys.modules):
    import types
    fake = types.ModuleType("portal_llm")
    class Scope:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    fake.usage_scope = lambda *a, **k: Scope()
    fake.chat_json = lambda *a, **k: None  # fail
    sys.modules["portal_llm"] = fake
    polished = bi._narrative_llm_polish(base, 1)
check("polish fail keeps base", polished["mode"] == "deterministic", polished)

with mock.patch.dict(sys.modules):
    import types
    fake = types.ModuleType("portal_llm")
    class Scope:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    fake.usage_scope = lambda *a, **k: Scope()
    fake.chat_json = lambda *a, **k: {
        "headline": "Polished headline",
        "paragraphs": ["One clear paragraph."],
        "bullets": ["Point A"],
    }
    sys.modules["portal_llm"] = fake
    polished = bi._narrative_llm_polish(base, 1)
check("polish applies", polished["mode"] == "llm_polish" and polished["llm_used"] is True,
      polished)
check("polish headline", polished["headline"] == "Polished headline", polished)
bi.NARRATIVE_LLM = False

# build_narrative respects flag
out = bi.build_narrative({}, {}, {}, [], 7, use_llm=False)
check("force off", out["llm_used"] is False, out)

print("== report includes narrative ==")
# report calls insights, ai_quality, funnel, detect - heavy. Unit-test by
# patching internals.
with mock.patch.object(bi, "thresholds_for", return_value=dict(bi.THRESHOLDS)):
    with mock.patch.object(bi, "insights", return_value={"topics": {"messages": 0, "topics": []}, "timezone_offset_hours": 5}):
        with mock.patch.object(bi, "ai_quality", return_value={}):
            with mock.patch.object(bi, "_guarded", return_value={}):
                with mock.patch.object(bi, "detect_problems", return_value=[]):
                    conn = install_db_stub(bi, [])  # unused if all mocked
                    data = bi.report(conn.cur, 1, 7, narrative_llm=False)
check("report has narrative", isinstance(data.get("narrative"), dict), data)
check("report narrative mode", data["narrative"]["mode"] == "deterministic",
      data["narrative"])

print("== brain wires agent_id ==")
brain = open(os.path.join(_CP, "portal_brain.py"), encoding="utf8").read()
check("brain scope agent_id", "agent_id=_agent_id" in brain, "-")

print("== UI + types ==")
ops = open(os.path.join(_ROOT, "app", "dashboard", "(portal)", "bot",
                        "AiOpsCard.tsx"), encoding="utf8").read()
check("AiOps by agent persona", "By agent persona" in ops, "-")
check("AiOps by_agent map", "usage.by_agent" in ops, "-")

ins = open(os.path.join(_ROOT, "app", "dashboard", "(portal)", "insights",
                        "InsightsClient.tsx"), encoding="utf8").read()
check("insights snapshot", "report.narrative" in ins, "-")
check("insights headline", "narrative.headline" in ins, "-")

pts = open(os.path.join(_ROOT, "lib", "omniflow", "portal.ts"), encoding="utf8").read()
check("BiReport narrative type", "narrative?:" in pts, "-")
check("AiUsage by_agent type", "by_agent?:" in pts, "-")

summary("agent_cost_narrative")
