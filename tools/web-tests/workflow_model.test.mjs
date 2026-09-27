// Contract test for the Workflow Builder model (workflow-model.ts).
// Driven by tools/cp-testrig/test_workflow_model.py, which dumps the
// Control Plane's own templates + normalised definitions + action
// catalog to a JSON file and runs:
//   node --experimental-strip-types tools/web-tests/workflow_model.test.mjs <json>
// Prints one JSON line per check: {"name": ..., "ok": ..., "detail": ...}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(here, "..", "..", "app", "dashboard", "(portal)", "workflows", "workflow-model.ts");
const model = await import(modelPath);

const fixture = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const catalog = {
  triggers: fixture.catalog.triggers,
  actions: fixture.catalog.actions,
  stepKinds: fixture.catalog.step_kinds,
  templates: [],
  verticals: [],
  appliedVertical: "",
  limits: {
    maxWorkflows: fixture.catalog.limits.max_workflows,
    maxSteps: fixture.catalog.limits.max_steps,
    maxWaitMinutes: fixture.catalog.limits.max_wait_minutes,
  },
};

function emit(name, ok, detail) {
  process.stdout.write(JSON.stringify({ name, ok: Boolean(ok), detail: detail === undefined ? "" : detail }) + "\n");
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function camelTemplate(raw) {
  return {
    key: raw.key,
    name: raw.name,
    description: raw.description,
    triggerType: raw.trigger_type,
    triggerConfig: raw.trigger_config || {},
    stopOnReply: raw.stop_on_reply === true,
    vertical: raw.vertical || "general",
    steps: raw.steps.map((s) => ({ kind: s.kind, label: s.label || "", config: s.config || {} })),
  };
}

// ---- 1. every CP template round-trips through the editor unchanged ----
let roundTrips = 0;
let cleanIssues = 0;
let fullyReachable = 0;
const mismatches = [];
for (let i = 0; i < fixture.templates.length; i++) {
  const raw = fixture.templates[i];
  const normalized = fixture.normalized[i];
  const state = model.editorFromTemplate(camelTemplate(raw));
  const payload = model.editorPayload(state);
  const stepsMatch =
    payload.steps.length === normalized.steps.length &&
    payload.steps.every(
      (s, j) =>
        s.kind === normalized.steps[j].kind &&
        s.label === normalized.steps[j].label &&
        deepEqual(s.config, normalized.steps[j].config)
    );
  const triggerMatch =
    payload.trigger_type === normalized.trigger_type &&
    deepEqual(payload.trigger_config, normalized.trigger_config) &&
    payload.stop_on_reply === normalized.stop_on_reply &&
    payload.name === normalized.name &&
    payload.description === normalized.description;
  if (stepsMatch && triggerMatch) roundTrips++;
  else mismatches.push(raw.key + ": " + JSON.stringify(payload.steps).slice(0, 160));
  if (model.allIssues(state.steps, catalog).size === 0) cleanIssues++;
  if (model.reachability(state.steps).every(Boolean)) fullyReachable++;
}
emit("all " + fixture.templates.length + " CP templates round-trip editor -> payload byte-for-byte",
  roundTrips === fixture.templates.length, mismatches.join(" | "));
emit("templates raise zero builder issues against the live action catalog",
  cleanIssues === fixture.templates.length, cleanIssues);
emit("every template step is reachable from the trigger",
  fullyReachable === fixture.templates.length, fullyReachable);

// ---- 2. key-based jumps survive reorder / delete ----
const delivery = fixture.templates.find((t) => t.key === "ecom_delivery_question");
const dState = model.editorFromTemplate(camelTemplate(delivery));
const branch = dState.steps[1];
emit("goto else resolves to a step KEY (not a position)",
  branch.elseMode === "goto" && branch.elseTarget === dState.steps[4].key, branch.elseTarget);
const moved = model.moveToSlot(dState.steps, 4, 2); // step 5 -> position 3
const movedPayload = model.editorPayload({ ...dState, steps: moved });
emit("reordering remaps the numeric else target (5 -> 3)",
  movedPayload.steps[1].config.else === 3 && moved[2].key === dState.steps[4].key,
  movedPayload.steps[1].config.else);
emit("moveToSlot is a no-op for the same slot",
  model.moveToSlot(dState.steps, 4, 4) === dState.steps && model.moveToSlot(dState.steps, 4, 5) === dState.steps, "-");
const removed = model.removeStep(dState.steps, dState.steps[4].key);
emit("deleting a jump target falls back to stop",
  removed.length === 6 && removed[1].elseMode === "stop" && removed[1].elseTarget === null, removed[1].elseMode);

// ---- 3. insert / duplicate / kind change ----
const inserted = model.insertStep(dState.steps, 1, "wait");
emit("insertStep places the new node at the slot and returns its key",
  inserted.steps.length === 8 && inserted.steps[1].kind === "wait" && inserted.steps[1].key === inserted.key, inserted.steps.length);
const dup = model.duplicateStep(dState.steps, dState.steps[4].key);
emit("duplicateStep copies config with a fresh key",
  dup.steps.length === 8 && dup.steps[5].kind === "action" && dup.steps[5].args.body === dState.steps[4].args.body
  && dup.steps[5].key !== dState.steps[4].key, dup.steps[5].key);
const asCondition = model.changeKind({ ...branch, thenTarget: dState.steps[3].key }, "condition");
emit("changing branch -> condition drops the yes-jump",
  asCondition.kind === "condition" && asCondition.thenTarget === null, asCondition.thenTarget);

// ---- 4. branch then/else round trip ----
const twoWay = model.stepsFromDefinition([
  { kind: "branch", label: "Split", config: { rules: { any: [{ field: "keyword", op: "contains", value: "urgent" }] }, else: "skip", then: 3 } },
  { kind: "action", label: "A", config: { action: "add_conversation_tag", args: { tag: "x" } } },
  { kind: "goal", label: "G", config: { name: "done" } },
]);
const twoWayPayload = model.editorPayload({ ...model.blankEditor(), name: "t", steps: twoWay });
emit("branch keeps then + else (any group) through the editor",
  deepEqual(twoWayPayload.steps[0].config, { rules: { any: [{ field: "keyword", op: "contains", value: "urgent" }] }, else: "skip", then: 3 }),
  JSON.stringify(twoWayPayload.steps[0].config));
const reach = model.reachability(twoWay);
emit("reachability follows then/skip edges (middle step is dead: yes jumps to 3, no skips to 3)",
  reach[0] && !reach[1] && reach[2], reach.join(","));

// ---- 5. issues mirror the CP rules ----
const blankAction = model.blankStep("action");
const blankAi = model.blankStep("ai_decision");
const badWait = { ...model.blankStep("wait"), waitAmount: "0" };
const longWait = { ...model.blankStep("wait"), waitAmount: "200", waitUnit: "hours" };
const blankGoal = model.blankStep("goal");
const badJson = { ...model.blankStep("action"), args: { body: "hi" }, argsJson: "{nope" };
const okStop = model.blankStep("stop");
emit("issues: message action without body",
  model.stepIssues(blankAction, [blankAction], catalog).join(" ") === "Missing: body.", model.stepIssues(blankAction, [blankAction], catalog));
emit("issues: empty AI question", model.stepIssues(blankAi, [blankAi], catalog).length === 1, "-");
emit("issues: wait out of range (0 and 200h)",
  model.stepIssues(badWait, [badWait], catalog).length === 1 && model.stepIssues(longWait, [longWait], catalog).length === 1, "-");
emit("issues: unnamed goal", model.stepIssues(blankGoal, [blankGoal], catalog).length === 1, "-");
emit("issues: invalid advanced JSON", model.stepIssues(badJson, [badJson], catalog).some((i) => i.includes("JSON")), "-");
emit("issues: stop never complains", model.stepIssues(okStop, [okStop], catalog).length === 0, "-");
emit("issues: unknown action flagged when the catalog is known",
  model.stepIssues({ ...blankAction, action: "launch_rockets" }, [blankAction], catalog).some((i) => i === "Unknown action."), "-");

// ---- 6. layout geometry ----
const layout = model.layoutWorkflow(dState.steps);
emit("layout: trigger + one node per step, y strictly increasing",
  layout.nodes.length === 8 && layout.nodes.every((n, i) => i === 0 || n.y > layout.nodes[i - 1].y), layout.nodes.length);
emit("layout: goto renders a jump edge labelled with the target number",
  layout.edges.some((e) => e.kind === "jump" && e.label === "no \u2192 5"), layout.edges.filter((e) => e.kind === "jump").map((e) => e.label));
emit("layout: ai decision else=stop renders a stop pill", layout.stops.length === 1, layout.stops.length);
emit("layout: yes edge labelled after decision nodes",
  layout.edges.filter((e) => e.kind === "yes").length === 2, layout.edges.filter((e) => e.kind === "yes").length);
emit("layout: goal followed by more steps draws a dashed edge",
  layout.edges.some((e) => e.id === "e-next-" + dState.steps[3].key && e.dashed), "-");
emit("layout: size covers all rows", layout.height > layout.nodes[7].y + model.NODE_H && layout.width > model.PAD_X + model.NODE_W, layout.height);
emit("slotFromY: above first step -> 0, past last -> n, just under first centre -> 1",
  model.slotFromY(0, 7) === 0 && model.slotFromY(1e6, 7) === 7 && model.slotFromY(model.nodeY(1) + model.NODE_H / 2 + 1, 7) === 1,
  [model.slotFromY(0, 7), model.slotFromY(1e6, 7)]);
emit("slot indicator sits between rows",
  model.slotIndicatorY(0) > model.nodeY(0) + model.NODE_H && model.slotIndicatorY(0) < model.nodeY(1), model.slotIndicatorY(0));
const empty = model.layoutWorkflow([]);
emit("layout: empty workflow = trigger only, no edges", empty.nodes.length === 1 && empty.edges.length === 0, "-");

// ---- 7. summaries ----
const waitDays = { ...model.blankStep("wait"), waitAmount: "72", waitUnit: "hours" };
const waitHours = { ...model.blankStep("wait"), waitAmount: "120", waitUnit: "minutes" };
emit("summary: waits read as days / hours",
  model.stepSummary(waitDays, catalog) === "3 days" && model.stepSummary(waitHours, catalog) === "2 hours",
  [model.stepSummary(waitDays, catalog), model.stepSummary(waitHours, catalog)]);
emit("summary: action shows catalog description + text",
  model.stepSummary(dState.steps[4], catalog).startsWith("Queue") || model.stepSummary(dState.steps[4], catalog).includes("\u00b7"),
  model.stepSummary(dState.steps[4], catalog));

// ---- 8. editorFromWorkflow (API shape) ----
const wf = {
  id: 5, name: "W", description: "", status: "draft", triggerType: "stage_changed",
  triggerConfig: { stage: "won" }, stopOnReply: true, version: 2, stepCount: 2, updatedAt: null,
  runs: { total: 0, live: 0, goals: 0, failed: 0, lastRunAt: null },
  steps: [
    { stepNo: 1, kind: "wait", label: "W", config: { minutes: 90 } },
    { stepNo: 2, kind: "handoff", label: "H", config: { user_id: 4, note: "n" } },
  ],
};
const wfState = model.editorFromWorkflow(wf);
const wfPayload = model.editorPayload(wfState);
emit("editorFromWorkflow keeps id/trigger/stop_on_reply and odd minutes",
  wfState.id === 5 && wfPayload.trigger_config.stage === "won" && wfPayload.stop_on_reply === true
  && deepEqual(wfPayload.steps[0].config, { minutes: 90 }) && deepEqual(wfPayload.steps[1].config, { user_id: 4, note: "n" }),
  JSON.stringify(wfPayload));
