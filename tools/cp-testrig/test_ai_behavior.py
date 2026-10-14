"""AI behavioral evaluation suite (MASTER-UPGRADE build-order 16).

The production-facing ``portal_ai_eval`` contract runner is deterministic and
zero-cost; this rig validates its complete corpus, the admin read-only API,
and the Control Center presentation. Deep DB behavior remains in the focused
brain/agents/workflow/knowledge/channel suites; this file proves the six
contracts are also composed into one deploy-time signal."""
import os
from flask import Flask

import admin_ai
import portal_ai_eval
from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "..", "..", "omniflow-backend-patch")
WEB = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


print("== eval contract runner ==")
full = portal_ai_eval.run_contract_suite()
check("suite identity is stable",
      full["suite"] == "omniflow-ai-behavior"
      and full["version"] == "16.1"
      and full["mode"] == "deterministic_contracts", full)
check("full corpus has every catalog case",
      full["total"] == len(portal_ai_eval.CASE_CATALOG)
      and full["total"] == len(full["cases"]),
      (full["total"], len(portal_ai_eval.CASE_CATALOG), len(full["cases"])))
check("full corpus passes",
      full["status"] == "pass"
      and full["passed"] == full["total"]
      and full["score"] == 100.0
      and full["failed"] == [], full)
check("runner makes zero LLM calls and reads no customer data",
      full["llm_calls"] == 0 and full["customer_data"] is False
      and "use_llm=False" in read(os.path.join(CP, "portal_ai_eval.py")), full)
check("every result has stable case fields",
      all(set(item) >= {"id", "category", "label", "passed", "detail"}
          for item in full["cases"]), full["cases"][:2])
check("case IDs are unique and catalog order is preserved",
      [x["id"] for x in full["cases"]]
      == [x["id"] for x in portal_ai_eval.CASE_CATALOG]
      and len({x["id"] for x in full["cases"]}) == full["total"], "-")
check("six behavior families are represented",
      {x["category"] for x in full["cases"]}
      == {"injection", "grounding", "knowledge", "permissions",
          "workflow", "channels"},
      {x["category"] for x in full["cases"]})

for category in ("injection", "grounding", "knowledge", "permissions",
                 "workflow", "channels"):
    subset = portal_ai_eval.run_contract_suite(
        [x["id"] for x in portal_ai_eval.CASE_CATALOG
         if x["category"] == category])
    check(category + " category passes independently",
          subset["status"] == "pass" and subset["passed"] == subset["total"]
          and subset["total"] > 0, subset)

single = portal_ai_eval.run_contract_suite(["injection.high_blocked"])
check("case filter runs one known contract",
      single["total"] == 1 and single["passed"] == 1
      and single["cases"][0]["id"] == "injection.high_blocked", single)
unknown = portal_ai_eval.run_contract_suite(["does.not.exist"])
check("unknown case fails loudly instead of disappearing",
      unknown["status"] == "fail" and unknown["passed"] == 0
      and unknown["failed"] == ["does.not.exist"]
      and unknown["cases"][0]["detail"] == "case is not registered", unknown)
check("catalog is a JSON-safe metadata copy",
      portal_ai_eval.catalog() == list(portal_ai_eval.CASE_CATALOG)
      and portal_ai_eval.catalog() is not portal_ai_eval.CASE_CATALOG, "-")
metadata = portal_ai_eval.catalog()
metadata[0]["label"] = "mutated"
check("catalog caller cannot mutate the tuple's source dict",
      portal_ai_eval.CASE_CATALOG[0]["label"] != "mutated", "-")

# ---------------------------------------------------------------------------
# Admin endpoint: key guard + read-only JSON contract
# ---------------------------------------------------------------------------
print("== admin API ==")
os.environ["OMNIFLOW_SERVICE_KEY"] = "eval-service-key"
app = Flask("ai-eval-rig")
app.register_blueprint(admin_ai.bp)
client = app.test_client()

r = client.get("/api/v1/admin/ai/eval")
check("eval API rejects missing service key", r.status_code == 403, r.status_code)
r = client.get("/api/v1/admin/ai/eval",
               headers={"X-Omniflow-Key": "wrong"})
check("eval API rejects wrong service key", r.status_code == 403, r.status_code)
r = client.get("/api/v1/admin/ai/eval",
               headers={"X-Omniflow-Key": "eval-service-key"})
body = r.get_json() or {}
check("eval API returns 200 for the service key", r.status_code == 200, body)
check("eval API returns the complete passing suite",
      body.get("status") == "pass"
      and body.get("score") == 100.0
      and body.get("passed") == body.get("total") == len(
          portal_ai_eval.CASE_CATALOG), body)
check("eval API is explicitly zero-cost and non-tenant",
      body.get("llm_calls") == 0 and body.get("customer_data") is False,
      body)
check("eval API cases are inspectable by category",
      {item.get("category") for item in body.get("cases", [])}
      == {"injection", "grounding", "knowledge", "permissions",
          "workflow", "channels"}, body.get("cases"))
check("eval endpoint is registered under the admin AI blueprint",
      "@bp.get(\"/eval\")" in read(os.path.join(CP, "admin_ai.py")), "-")

# ---------------------------------------------------------------------------
# wiring pins: production module + BFF + Control Center
# ---------------------------------------------------------------------------
print("== wiring ==")
EVAL = read(os.path.join(CP, "portal_ai_eval.py"))
ADMIN = read(os.path.join(CP, "admin_ai.py"))
check("production eval module documents all six behavior families",
      all(word in EVAL for word in (
          "injection", "grounding", "knowledge", "permissions", "workflow",
          "channels")), "-")
check("admin route makes no provider call",
      "zero provider calls" in ADMIN
      and "portal_ai_eval.run_contract_suite()" in ADMIN, "-")
check("app registers the admin AI blueprint that carries eval",
      "aux_app.register_blueprint(admin_ai_bp)" in read(
          os.path.join(CP, "app.py")), "-")
BFF = read(WEB + "app/api/omniflow/admin/ai/eval/route.ts")
check("eval BFF has same-origin + admin-session guards",
      "sameOrigin(request)" in BFF and "requireAdminSession" in BFF
      and "getAdminAiEval" in BFF, "-")
ADMIN_CLIENT = read(WEB + "lib/omniflow/admin-control-plane.ts")
check("admin bridge validates the eval payload shape",
      "export interface AdminAiEval" in ADMIN_CLIENT
      and 'adminRequest("api/v1/admin/ai/eval"' in ADMIN_CLIENT
      and '!("cases" in payload)' in ADMIN_CLIENT, "-")
PAGE = read(WEB + "app/admin/(panel)/ai-control/page.tsx")
check("Control Center loads the behavioral eval",
      "/api/omniflow/admin/ai/eval" in PAGE
      and "runBehavioralEval" in PAGE
      and "AI behavioral evaluation" in PAGE, "-")
check("Control Center explains the suite is deterministic and zero-cost",
      "Deterministic only" in PAGE and "no provider calls" in PAGE
      and "customer data" in PAGE, "-")
check("Control Center shows score and every case",
      "behavioralEval.score" in PAGE
      and "behavioralEval.cases.map" in PAGE
      and "All contracts pass" in PAGE, "-")

# No secrets left in the eval source or the suite response fixture.
check("eval module contains no credentials or environment keys",
      all(token not in EVAL for token in (
          "OF_LLM_API_KEY", "OMNIFLOW_SERVICE_KEY", "api_key",
          "access_token")), "-")

os.environ.pop("OMNIFLOW_SERVICE_KEY", None)
summary("ai_behavior")
