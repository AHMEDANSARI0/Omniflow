"""Workflow Builder model contract: runs the web editor model
(app/dashboard/(portal)/workflows/workflow-model.ts) with Node's type
stripping against the Control Plane's OWN templates, normalised
definitions and action catalog. If the editor ever drifts from what
portal_workflows accepts, this suite fails - no browser needed."""
import json
import os
import shutil
import subprocess
import tempfile

import portal_workflows
from test_lib import check, summary

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEST = os.path.join(ROOT, "tools", "web-tests", "workflow_model.test.mjs")
RENDER = os.path.join(ROOT, "tools", "web-tests", "workflow_canvas.render.mjs")
MODEL = os.path.join(ROOT, "app", "dashboard", "(portal)", "workflows",
                     "workflow-model.ts")

print("== fixture ==")
templates = portal_workflows.templates()
normalized = []
for item in templates:
    fields, problem = portal_workflows.normalize_definition(item)
    check("normalises " + item["key"], problem is None and fields is not None,
          problem)
    normalized.append({
        "name": fields["name"], "description": fields["description"],
        "trigger_type": fields["trigger_type"],
        "trigger_config": fields["trigger_config"],
        "stop_on_reply": fields["stop_on_reply"],
        "steps": [{"kind": s["kind"], "label": s["label"],
                   "config": s["config"]} for s in fields["steps"]],
    })
fixture = {
    "templates": templates,
    "normalized": normalized,
    "catalog": {
        "triggers": portal_workflows.trigger_catalog(),
        "actions": portal_workflows.action_catalog(),
        "step_kinds": list(portal_workflows.STEP_KINDS),
        "verticals": portal_workflows.template_verticals(),
        "applied_vertical": "",
        "limits": {"max_workflows": portal_workflows.MAX_WORKFLOWS,
                   "max_steps": portal_workflows.MAX_STEPS,
                   "max_wait_minutes": portal_workflows.MAX_WAIT_MINUTES},
    },
}
check("model + test files present", os.path.exists(MODEL)
      and os.path.exists(TEST), (MODEL, TEST))
src = open(MODEL, encoding="utf8").read()
check("model is erasable TS (no enums/namespaces/React/DOM)",
      "enum " not in src and "namespace " not in src
      and "from \"react\"" not in src and "document." not in src
      and "window." not in src and "import type" in src, "-")

print("== node contract run ==")
node = shutil.which("node")
check("node available for the contract run", bool(node), node)
if node:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     encoding="utf8") as handle:
        json.dump(fixture, handle)
        fixture_path = handle.name
    try:
        proc = subprocess.run(
            [node, "--experimental-strip-types", "--no-warnings", TEST,
             fixture_path],
            capture_output=True, text=True, timeout=60, cwd=ROOT)
    finally:
        os.unlink(fixture_path)
    check("contract script exits 0", proc.returncode == 0,
          (proc.stderr or "")[-600:])
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    parsed = 0
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        parsed += 1
        check("model: " + str(item.get("name")), bool(item.get("ok")),
              item.get("detail"))
    check("contract emitted checks", parsed >= 25, parsed)

    print("== render smoke (SWC + react-dom/server) ==")
    # Only when the website's node_modules are installed (CP-only checkouts
    # skip this half - the model contract above still runs).
    has_deps = (os.path.isdir(os.path.join(ROOT, "node_modules", "react-dom"))
                and os.path.isdir(os.path.join(ROOT, "node_modules", "next")))
    if has_deps:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf8") as handle:
            json.dump(fixture, handle)
            fixture_path = handle.name
        try:
            proc = subprocess.run([node, RENDER, fixture_path],
                                  capture_output=True, text=True, timeout=120,
                                  cwd=ROOT)
        finally:
            os.unlink(fixture_path)
        check("render script exits 0", proc.returncode == 0,
              (proc.stderr or "")[-600:])
        rendered = 0
        for line in proc.stdout.splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            rendered += 1
            check("render: " + str(item.get("name")), bool(item.get("ok")),
                  item.get("detail"))
        check("render emitted checks", rendered >= 10, rendered)
    else:
        print("  SKIP render smoke (node_modules not installed)")

raise SystemExit(1 if summary("workflow_model") else 0)
