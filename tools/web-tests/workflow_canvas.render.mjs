// Workflow Builder render smoke: compiles the builder components with the
// SWC bundled in Next (no extra dev dependency), then server-renders them
// with react-dom against the Control Plane fixture that
// tools/cp-testrig/test_workflow_model.py writes. Prints one JSON line per
// check: {"name": ..., "ok": true|false, "detail": ...}.
//
//   node tools/web-tests/workflow_canvas.render.mjs /tmp/fixture.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(path.join(root, "package.json"));
const fixture = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

function emit(name, ok, detail) {
  process.stdout.write(JSON.stringify({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail).slice(0, 300) }) + "\n");
}

// ---------------------------------------------------------------- compile
const swc = require("next/dist/build/swc");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const srcDir = path.join(root, "app", "dashboard", "(portal)", "workflows");
const files = ["workflow-model.ts", "StepInspector.tsx", "WorkflowCanvas.tsx", "WorkflowGenerator.tsx", "WorkflowsClient.tsx"];
// §246: the builder's icons come from the shared portal icon set (lucide-react)
const iconDir = path.join(root, "app", "dashboard", "components");
// compiled files live next to node_modules so `require("react")` resolves
const outDir = fs.mkdtempSync(path.join(root, "node_modules", ".cache-of-render-"));

function compile(name, dir = srcDir) {
  const src = fs.readFileSync(path.join(dir, name), "utf8");
  const tsx = name.endsWith(".tsx");
  const result = swc.transformSync(src, {
    filename: name,
    jsc: {
      parser: { syntax: "typescript", tsx },
      transform: { react: { runtime: "automatic" } },
      target: "es2020",
    },
    module: { type: "commonjs" },
    sourceMaps: false,
  });
  const code = typeof result === "string" ? result : result.code;
  // components import each other by extension-less relative paths
  const out = path.join(outDir, name.replace(/\.tsx?$/, ".cjs"));
  fs.writeFileSync(
    out,
    code
      .replace(/require\("\.\/(workflow-model|StepInspector|WorkflowCanvas|WorkflowGenerator)"\)/g, 'require("./$1.cjs")')
      .replace(/require\("\.\.\/\.\.\/components\/(PortalIcon)"\)/g, 'require("./$1.cjs")')
  );
  return out;
}

let model, inspector, Canvas, Generator, Client;
try {
  const PortalIcon = require(compile("PortalIcon.tsx", iconDir)).default;
  const icon = renderToStaticMarkup(React.createElement(PortalIcon, { name: "split" }));
  emit("portal icons render as SVG (lucide)", icon.startsWith("<svg") && icon.includes('aria-hidden="true"') && icon.includes("lucide"), icon.slice(0, 120));
  const compiled = Object.fromEntries(files.map((name) => [name, compile(name)]));
  model = require(compiled["workflow-model.ts"]);
  inspector = require(compiled["StepInspector.tsx"]);
  Canvas = require(compiled["WorkflowCanvas.tsx"]).default;
  Generator = require(compiled["WorkflowGenerator.tsx"]).default;
  Client = require(compiled["WorkflowsClient.tsx"]).default;
  emit("builder components compile with Next's SWC and load in Node", true);
} catch (error) {
  emit("builder components compile with Next's SWC and load in Node", false, error && error.stack);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------- fixture
const catalog = {
  triggers: fixture.catalog.triggers,
  actions: fixture.catalog.actions,
  stepKinds: fixture.catalog.step_kinds,
  templates: fixture.templates.map((t) => ({
    key: t.key, name: t.name, description: t.description, vertical: t.vertical || "general",
    triggerType: t.trigger_type, triggerConfig: t.trigger_config || {}, stopOnReply: !!t.stop_on_reply,
    steps: t.steps,
  })),
  verticals: fixture.catalog.verticals || [{ key: "general", label: "General" }],
  appliedVertical: fixture.catalog.applied_vertical || "",
  limits: {
    maxWorkflows: fixture.catalog.limits.max_workflows,
    maxSteps: fixture.catalog.limits.max_steps,
    maxWaitMinutes: fixture.catalog.limits.max_wait_minutes,
  },
};

function render(element) {
  return renderToStaticMarkup(element);
}
function count(html, needle) {
  return html.split(needle).length - 1;
}

function canvasProps(steps, extra) {
  return {
    steps,
    catalog,
    selected: "trigger",
    issues: model.allIssues(steps, catalog),
    triggerTitle: "Message received",
    triggerSubtitle: "keyword refund",
    zoom: 1,
    maxSteps: catalog.limits.maxSteps,
    onSelect() {}, onReorder() {}, onInsert() {}, onRemove() {},
    ...extra,
  };
}

// ---------------------------------------------- 1. every template renders
let rendered = 0;
const failures = [];
for (const template of catalog.templates) {
  try {
    const state = model.editorFromTemplate(template);
    const html = render(React.createElement(Canvas, canvasProps(state.steps)));
    const nodes = count(html, "data-step-key=");
    const ok = nodes === state.steps.length && html.includes("<svg") && html.includes("Trigger")
      && count(html, "<path d=") >= state.steps.length; // one connector per step at least
    if (!ok) failures.push(template.key + ":" + nodes + "/" + state.steps.length);
    else rendered++;
  } catch (error) {
    failures.push(template.key + ":" + (error && error.message));
  }
}
emit("canvas renders all " + catalog.templates.length + " CP templates (node per step, SVG edges, trigger node)",
  rendered === catalog.templates.length, failures.join(" | "));

// -------------------------------------- 2. branch / else-stop / dead steps
const branchTemplate = catalog.templates.find((t) => t.steps.some((s) => s.kind === "condition" && s.config.else === "stop"));
if (branchTemplate) {
  const html = render(React.createElement(Canvas, canvasProps(model.editorFromTemplate(branchTemplate).steps)));
  emit("else=stop draws the Stop pill on the right rail (" + branchTemplate.key + ")",
    html.includes(">Stop</text>") && html.includes("wf-arrow-no"), branchTemplate.key);
} else {
  emit("fixture has an else=stop template", false, "none");
}

const dead = model.stepsFromDefinition([
  { kind: "branch", label: "", config: { rules: { all: [{ field: "keyword", op: "contains", value: "x" }] }, then: 3, else: "skip" } },
  { kind: "action", label: "Never runs", config: { action: "queue_whatsapp_message", args: { body: "hi" } } },
  { kind: "goal", label: "", config: { name: "done" } },
]);
const deadHtml = render(React.createElement(Canvas, canvasProps(dead)));
emit("unreachable step is flagged on the canvas", deadHtml.includes("Not reachable from the trigger") && count(deadHtml, "Not reachable") === 1, count(deadHtml, "Not reachable"));
emit("branch draws a labelled yes edge and a no/skip edge", deadHtml.includes("wf-arrow-yes") && /no \(skip\)/.test(deadHtml), "-");

// ------------------------------------------------- 3. issues + selection
const broken = model.stepsFromDefinition([
  { kind: "action", label: "", config: { action: "queue_whatsapp_message", args: {} } },
]);
const brokenHtml = render(React.createElement(Canvas, canvasProps(broken, { selected: broken[0].key })));
emit("issue dot + selection ring render", brokenHtml.includes("Needs attention: Missing: body.") && brokenHtml.includes("ring-brand/30"), "-");

const emptyHtml = render(React.createElement(Canvas, canvasProps([])));
emit("empty canvas shows the drop placeholder and one insert slot",
  emptyHtml.includes("Drop a step here") && count(emptyHtml, "Insert a step at position") === 1, count(emptyHtml, "Insert a step at position"));

const fullSteps = model.stepsFromDefinition(Array.from({ length: catalog.limits.maxSteps }, () => ({ kind: "stop", label: "", config: {} })));
const fullHtml = render(React.createElement(Canvas, canvasProps(fullSteps)));
emit("at the step limit the palette is disabled and insert buttons disappear",
  !fullHtml.includes("Insert a step at position") && count(fullHtml, "disabled=\"\"") >= model.NODE_KINDS.length, count(fullHtml, "disabled=\"\""));

// ------------------------------------------------------- 4. inspectors
let inspected = 0;
const inspectFailures = [];
for (const kind of model.NODE_KINDS) {
  try {
    const step = model.blankStep(kind);
    const steps = [step, model.blankStep("goal")];
    const html = render(React.createElement(inspector.StepInspector, {
      step, index: 0, steps, catalog, issues: model.stepIssues(step, steps, catalog),
      onChange() {}, onKindChange() {}, onRemove() {}, onDuplicate() {}, onMove() {},
    }));
    const expectations = {
      condition: ["Add rule", "When the rules do not match"],
      branch: ["When the rules match (yes)", "When they do not match (no)"],
      ai_decision: ["Yes/no question", "If the AI is unavailable"],
      action: ["Advanced arguments", catalog.actions[0].description],
      wait: ["minutes", "max 7 days"],
      approval: ["What the owner is approving"],
      handoff: ["Teammate user id"],
      goal: ["Goal name"],
      stop: ["Delete step"],
    };
    const missing = expectations[kind].filter((needle) => !html.includes(needle));
    if (missing.length || !html.includes("jump to 2. ") && kind !== "action" && kind !== "wait" && kind !== "approval" && kind !== "handoff" && kind !== "goal" && kind !== "stop") {
      inspectFailures.push(kind + ":" + missing.join(","));
    } else inspected++;
  } catch (error) {
    inspectFailures.push(kind + ":" + (error && error.message));
  }
}
emit("step inspector renders every node kind with its form (" + model.NODE_KINDS.length + ")",
  inspected === model.NODE_KINDS.length, inspectFailures.join(" | "));

const highAction = catalog.actions.find((a) => a.risk === "high");
if (highAction) {
  const step = { ...model.blankStep("action"), action: highAction.action };
  const html = render(React.createElement(inspector.StepInspector, {
    step, index: 0, steps: [step], catalog, issues: [], onChange() {}, onKindChange() {}, onRemove() {}, onDuplicate() {}, onMove() {},
  }));
  emit("high-risk action shows the approval-gate notice", html.includes("High-risk: the run pauses until you approve it"), highAction.action);
}

const trig = render(React.createElement(inspector.TriggerInspector, {
  editor: { ...model.blankEditor(), triggerType: "message_received", keyword: "refund" }, catalog, onChange() {},
}));
emit("trigger inspector lists CP triggers + keyword/once/stop-on-reply controls",
  count(trig, "<option") >= catalog.triggers.length && trig.includes("Keyword (optional") && trig.includes("Only once per conversation") && trig.includes("Stop waiting runs"), count(trig, "<option"));

// ------------------------------------------------------ 5. client page
const workflows = [
  { id: 1, name: "Refund triage", description: "d", status: "active", triggerType: "message_received", triggerConfig: { keyword: "refund" }, stopOnReply: false, version: 3, stepCount: 4, steps: [], runs: { total: 5, live: 1, goals: 2, failed: 0, lastRunAt: null }, updatedAt: null },
  { id: 2, name: "Draft flow", description: "", status: "draft", triggerType: "manual", triggerConfig: {}, stopOnReply: true, version: 1, stepCount: 0, steps: [], runs: { total: 0, live: 0, goals: 0, failed: 0, lastRunAt: null }, updatedAt: null },
];
const page = render(React.createElement(Client, { initialWorkflows: workflows }));
emit("workflows page renders the list with builder/activate/pause actions",
  page.includes("Refund triage") && page.includes("Open in builder") && page.includes(">Pause<") && page.includes(">Activate<") && page.includes("Start from template") && page.includes("1 active of 2 workflows"), "-");
emit("empty list renders the onboarding hint",
  render(React.createElement(Client, { initialWorkflows: [] })).includes("No workflows yet"), "-");
emit("workflows page offers Describe it (AI generator)", page.includes("Describe it"), "-");

// ------------------------------------------------- 6. AI generator panel
const noop = () => {};
const describe = render(React.createElement(Generator, { catalog, current: null, canCreate: true, onOpen: noop, onClose: noop }));
emit("generator: describe mode renders the prompt box and Build button",
  describe.includes("Describe a workflow") && describe.includes("What should the workflow do?")
  && describe.includes("Build workflow") && !describe.includes("not available"), "-");
const change = render(React.createElement(Generator, {
  catalog, canCreate: true, onOpen: noop, onClose: noop,
  current: { payload: { name: "Refund triage", description: "", trigger_type: "manual", trigger_config: {}, stop_on_reply: false, steps: [] }, name: "Refund triage", active: true },
}));
emit("generator: change mode names the workflow and asks what should change",
  change.includes("Refund triage") && change.includes("with AI") && change.includes("What should change?")
  && change.includes("Apply change"), "-");

fs.rmSync(outDir, { recursive: true, force: true });
