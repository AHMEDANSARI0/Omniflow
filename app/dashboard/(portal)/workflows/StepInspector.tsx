"use client";

import type { WorkflowCatalog, WorkflowStepKind } from "../../../../lib/omniflow/portal";
import {
  ARG_LABELS,
  AUTO_ARGS,
  CONDITION_FIELDS,
  CONDITION_OPS,
  NODE_KINDS,
  PIPELINE_STAGES,
  STEP_HINTS,
  STEP_LABELS,
  type EditorState,
  type EditorStep,
  type ElseMode,
} from "./workflow-model";

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const smallInput =
  "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40";
const ghostBtn =
  "rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-line-2 hover:text-ink disabled:opacity-50";
const dangerBtn =
  "rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-700 transition-colors duration-300 hover:bg-rose-50 disabled:opacity-50";

function RiskChip({ risk }: { risk: string }) {
  const styles: Record<string, string> = {
    low: "text-ink-3 border-line-2",
    medium: "text-amber-700 border-amber-300/40",
    high: "text-rose-700 border-rose-200",
  };
  return (
    <span
      className={
        "rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide " +
        (styles[risk] || styles.low)
      }
    >
      {risk}
    </span>
  );
}

function stepOptionLabel(step: EditorStep, index: number): string {
  return index + 1 + ". " + (step.label.trim() || STEP_LABELS[step.kind]);
}

// ---------------------------------------------------------------------------
// Jump controls (targets are step keys, so reordering never breaks them)
// ---------------------------------------------------------------------------

function JumpSelect({
  label,
  mode,
  target,
  self,
  steps,
  allowRelative,
  onChange,
}: {
  label: string;
  mode: ElseMode;
  target: number | null;
  self: EditorStep;
  steps: EditorStep[];
  allowRelative: boolean;
  onChange: (mode: ElseMode, target: number | null) => void;
}) {
  const value = mode === "goto" && target !== null ? "key:" + target : mode;
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-ink-2">{label}</span>
      <select
        className={smallInput + " mt-1"}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next.startsWith("key:")) onChange("goto", Number.parseInt(next.slice(4), 10));
          else onChange(next as ElseMode, null);
        }}
      >
        {allowRelative ? (
          <>
            <option value="stop">stop the run</option>
            <option value="skip">skip the next step</option>
            <option value="continue">continue to the next step</option>
          </>
        ) : (
          <option value="stop">continue to the next step</option>
        )}
        {steps.map((step, index) =>
          step.key === self.key ? null : (
            <option key={step.key} value={"key:" + step.key}>
              jump to {stepOptionLabel(step, index)}
            </option>
          )
        )}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Step inspector
// ---------------------------------------------------------------------------

export function StepInspector({
  step,
  index,
  steps,
  catalog,
  issues,
  onChange,
  onKindChange,
  onRemove,
  onDuplicate,
  onMove,
}: {
  step: EditorStep;
  index: number;
  steps: EditorStep[];
  catalog: WorkflowCatalog | null;
  issues: string[];
  onChange: (patch: Partial<EditorStep>) => void;
  onKindChange: (kind: WorkflowStepKind) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const spec = catalog?.actions.find((a) => a.action === step.action);
  const requiredArgs = (spec?.required ?? []).filter((arg) => !AUTO_ARGS.includes(arg));

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
            Step {index + 1}
          </p>
          <h3 className="text-sm font-semibold text-ink">{STEP_LABELS[step.kind]}</h3>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={ghostBtn} disabled={index === 0} onClick={() => onMove(-1)}>
            Up
          </button>
          <button
            type="button"
            className={ghostBtn}
            disabled={index === steps.length - 1}
            onClick={() => onMove(1)}
          >
            Down
          </button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-ink-3">{STEP_HINTS[step.kind]}</p>

      {issues.length ? (
        <ul className="mt-3 space-y-1 rounded-xl border border-amber-300/40 bg-amber-50 px-3 py-2">
          {issues.map((issue) => (
            <li key={issue} className="text-[11px] text-amber-800">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-3">
        <label className="block">
          <span className="text-[11px] font-medium text-ink-2">Type</span>
          <select
            className={smallInput + " mt-1"}
            value={step.kind}
            onChange={(event) => onKindChange(event.target.value as WorkflowStepKind)}
          >
            {NODE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {STEP_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-medium text-ink-2">Label (shown on the canvas)</span>
          <input
            className={smallInput + " mt-1"}
            value={step.label}
            maxLength={60}
            placeholder={STEP_LABELS[step.kind]}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>
      </div>

      {/* ---------------------------------------------------- condition */}
      {step.kind === "condition" || step.kind === "branch" ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2 text-xs text-ink-2">
            Match
            <select
              className={smallInput + " w-auto"}
              value={step.group}
              onChange={(event) => onChange({ group: event.target.value as "all" | "any" })}
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            of these rules
          </div>
          {step.conditions.map((condition, cIndex) => (
            <div key={cIndex} className="rounded-xl border border-line bg-white shadow-card p-2">
              <div className="grid grid-cols-2 gap-2">
                <select
                  className={smallInput}
                  value={condition.field}
                  onChange={(event) =>
                    onChange({
                      conditions: step.conditions.map((c, i) =>
                        i === cIndex ? { ...c, field: event.target.value } : c
                      ),
                    })
                  }
                >
                  {CONDITION_FIELDS.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
                <select
                  className={smallInput}
                  value={condition.op}
                  onChange={(event) =>
                    onChange({
                      conditions: step.conditions.map((c, i) =>
                        i === cIndex ? { ...c, op: event.target.value } : c
                      ),
                    })
                  }
                >
                  {CONDITION_OPS.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className={smallInput}
                  value={condition.value}
                  placeholder={condition.op === "in_hours" ? "(no value needed)" : "value"}
                  disabled={condition.op === "in_hours"}
                  onChange={(event) =>
                    onChange({
                      conditions: step.conditions.map((c, i) =>
                        i === cIndex ? { ...c, value: event.target.value } : c
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={step.conditions.length === 1}
                  onClick={() =>
                    onChange({ conditions: step.conditions.filter((_, i) => i !== cIndex) })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className={ghostBtn}
            disabled={step.conditions.length >= 10}
            onClick={() =>
              onChange({
                conditions: [...step.conditions, { field: "keyword", op: "contains", value: "" }],
              })
            }
          >
            Add rule
          </button>
          <div className="grid gap-2 pt-1">
            {step.kind === "branch" ? (
              <JumpSelect
                label="When the rules match (yes)"
                mode={step.thenTarget !== null ? "goto" : "stop"}
                target={step.thenTarget}
                self={step}
                steps={steps}
                allowRelative={false}
                onChange={(mode, target) => onChange({ thenTarget: mode === "goto" ? target : null })}
              />
            ) : null}
            <JumpSelect
              label={step.kind === "branch" ? "When they do not match (no)" : "When the rules do not match"}
              mode={step.elseMode}
              target={step.elseTarget}
              self={step}
              steps={steps}
              allowRelative
              onChange={(mode, target) => onChange({ elseMode: mode, elseTarget: target })}
            />
          </div>
        </div>
      ) : null}

      {/* -------------------------------------------------- ai decision */}
      {step.kind === "ai_decision" ? (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">Yes/no question about the message</span>
            <textarea
              className={inputClass + " mt-1"}
              rows={3}
              maxLength={300}
              value={step.question}
              placeholder="Is the customer asking for a refund on a paid order?"
              onChange={(event) => onChange({ question: event.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">If the AI is unavailable, assume</span>
            <select
              className={smallInput + " mt-1"}
              value={step.fallback}
              onChange={(event) => onChange({ fallback: event.target.value as "yes" | "no" })}
            >
              <option value="no">no</option>
              <option value="yes">yes</option>
            </select>
          </label>
          <JumpSelect
            label="When the answer is no"
            mode={step.elseMode}
            target={step.elseTarget}
            self={step}
            steps={steps}
            allowRelative
            onChange={(mode, target) => onChange({ elseMode: mode, elseTarget: target })}
          />
          <p className="text-[11px] text-ink-3">
            The customer text is passed to the AI as untrusted data - it can never change these
            rules.
          </p>
        </div>
      ) : null}

      {/* ------------------------------------------------------- action */}
      {step.kind === "action" ? (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">Action</span>
            <div className="mt-1 flex items-center gap-2">
              <select
                className={smallInput}
                value={step.action}
                onChange={(event) => onChange({ action: event.target.value, args: {} })}
              >
                {(catalog?.actions ?? []).map((action) => (
                  <option key={action.action} value={action.action}>
                    {action.description}
                  </option>
                ))}
              </select>
              {spec ? <RiskChip risk={spec.risk} /> : null}
            </div>
            {spec?.risk === "high" ? (
              <p className="mt-1 text-[11px] text-ink-3">
                High-risk: the run pauses until you approve it (WhatsApp 1/0 or the Approvals inbox).
              </p>
            ) : null}
          </label>
          {requiredArgs.map((arg) =>
            arg === "body" || arg === "content" ? (
              <label key={arg} className="block">
                <span className="text-[11px] font-medium text-ink-2">
                  {ARG_LABELS[arg] ?? arg}
                  <span className="text-ink-3"> · placeholders {"{first_name} {name} {text} {stage}"}</span>
                </span>
                <textarea
                  className={inputClass + " mt-1"}
                  rows={3}
                  maxLength={1000}
                  value={step.args[arg] ?? ""}
                  onChange={(event) => onChange({ args: { ...step.args, [arg]: event.target.value } })}
                />
              </label>
            ) : arg === "stage" ? (
              <label key={arg} className="block">
                <span className="text-[11px] font-medium text-ink-2">{ARG_LABELS[arg]}</span>
                <select
                  className={smallInput + " mt-1"}
                  value={step.args[arg] ?? ""}
                  onChange={(event) => onChange({ args: { ...step.args, [arg]: event.target.value } })}
                >
                  <option value="">Pick a stage</option>
                  {PIPELINE_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={arg} className="block">
                <span className="text-[11px] font-medium text-ink-2">{ARG_LABELS[arg] ?? arg}</span>
                <input
                  className={smallInput + " mt-1"}
                  value={step.args[arg] ?? ""}
                  onChange={(event) => onChange({ args: { ...step.args, [arg]: event.target.value } })}
                />
              </label>
            )
          )}
          <details>
            <summary className="cursor-pointer text-[11px] text-ink-3">Advanced arguments (JSON)</summary>
            <textarea
              className={inputClass + " mt-1 font-mono text-xs"}
              rows={2}
              value={step.argsJson}
              placeholder='{"discount": 0}'
              onChange={(event) => onChange({ argsJson: event.target.value })}
            />
          </details>
          <p className="text-[11px] text-ink-3">
            Contact and conversation are filled in from the run automatically.
          </p>
        </div>
      ) : null}

      {/* --------------------------------------------------------- wait */}
      {step.kind === "wait" ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-ink-2">
          Wait
          <input
            className={smallInput + " w-24"}
            inputMode="decimal"
            value={step.waitAmount}
            onChange={(event) => onChange({ waitAmount: event.target.value })}
          />
          <select
            className={smallInput + " w-auto"}
            value={step.waitUnit}
            onChange={(event) => onChange({ waitUnit: event.target.value as "minutes" | "hours" })}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
          <span className="text-ink-3">(max 7 days)</span>
        </div>
      ) : null}

      {/* ----------------------------------------------------- approval */}
      {step.kind === "approval" ? (
        <label className="mt-4 block">
          <span className="text-[11px] font-medium text-ink-2">What the owner is approving</span>
          <input
            className={inputClass + " mt-1"}
            maxLength={200}
            value={step.summary}
            placeholder="Send {first_name} a 10% discount"
            onChange={(event) => onChange({ summary: event.target.value })}
          />
        </label>
      ) : null}

      {/* ------------------------------------------------------ handoff */}
      {step.kind === "handoff" ? (
        <div className="mt-4 grid gap-3">
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">Teammate user id (blank = first teammate)</span>
            <input
              className={smallInput + " mt-1"}
              inputMode="numeric"
              value={step.userId}
              onChange={(event) => onChange({ userId: event.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">Note for the team (optional)</span>
            <input
              className={smallInput + " mt-1"}
              maxLength={160}
              value={step.note}
              onChange={(event) => onChange({ note: event.target.value })}
            />
          </label>
        </div>
      ) : null}

      {/* --------------------------------------------------------- goal */}
      {step.kind === "goal" ? (
        <label className="mt-4 block">
          <span className="text-[11px] font-medium text-ink-2">Goal name (reported on the cards)</span>
          <input
            className={inputClass + " mt-1"}
            maxLength={80}
            value={step.goalName}
            placeholder="review_requested"
            onChange={(event) => onChange({ goalName: event.target.value })}
          />
        </label>
      ) : null}

      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
        <button type="button" className={ghostBtn} onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className={dangerBtn} onClick={onRemove}>
          Delete step
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger inspector
// ---------------------------------------------------------------------------

export function TriggerInspector({
  editor,
  catalog,
  onChange,
}: {
  editor: EditorState;
  catalog: WorkflowCatalog | null;
  onChange: (patch: Partial<EditorState>) => void;
}) {
  const triggers = catalog?.triggers ?? [];
  const current = triggers.find((t) => t.trigger === editor.triggerType);
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">Start</p>
      <h3 className="text-sm font-semibold text-ink">Trigger</h3>
      <p className="mt-1 text-[11px] text-ink-3">
        The event that starts a run. Each run belongs to one customer conversation.
      </p>
      <div className="mt-3 grid gap-3">
        <label className="block">
          <span className="text-[11px] font-medium text-ink-2">When</span>
          <select
            className={smallInput + " mt-1"}
            value={editor.triggerType}
            onChange={(event) => onChange({ triggerType: event.target.value })}
          >
            {(triggers.length
              ? triggers
              : [{ trigger: editor.triggerType, label: editor.triggerType, source: "", options: [], description: "" }]
            ).map((trigger) => (
              <option key={trigger.trigger} value={trigger.trigger}>
                {trigger.label}
              </option>
            ))}
          </select>
        </label>
        {current?.description ? <p className="text-[11px] text-ink-3">{current.description}</p> : null}
        {editor.triggerType === "message_received" ? (
          <>
            <label className="block">
              <span className="text-[11px] font-medium text-ink-2">Keyword (optional, whole word)</span>
              <input
                className={smallInput + " mt-1"}
                value={editor.keyword}
                maxLength={32}
                placeholder="refund"
                onChange={(event) => onChange({ keyword: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={editor.oncePerConversation}
                onChange={(event) => onChange({ oncePerConversation: event.target.checked })}
              />
              Only once per conversation
            </label>
          </>
        ) : null}
        {editor.triggerType === "stage_changed" ? (
          <label className="block">
            <span className="text-[11px] font-medium text-ink-2">Stage (optional)</span>
            <select
              className={smallInput + " mt-1"}
              value={editor.stage}
              onChange={(event) => onChange({ stage: event.target.value })}
            >
              <option value="">Any stage</option>
              {PIPELINE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={editor.stopOnReply}
            onChange={(event) => onChange({ stopOnReply: event.target.checked })}
          />
          <span>
            Stop waiting runs when the customer replies
            <span className="block text-[11px] text-ink-3">stop_on_reply - good for reminders and nudges.</span>
          </span>
        </label>
      </div>
    </div>
  );
}
