"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  WorkflowCatalog,
  WorkflowGenResult,
  WorkflowGenStatus,
  WorkflowTemplate,
} from "../../../../lib/omniflow/portal";
import { STEP_LABELS, editorFromTemplate, stepSummary, type WorkflowPayload } from "./workflow-model";
import PortalIcon from "../../components/PortalIcon";

/** The builder's workflow when the owner asks the AI to change it. */
export interface GeneratorTarget {
  payload: WorkflowPayload;
  name: string;
  active: boolean;
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand/[0.12] disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-line-2 hover:text-ink disabled:opacity-50";

const LEVEL_STYLE: Record<string, string> = {
  info: "border-line bg-soft text-ink-2",
  warn: "border-warn/30 bg-warn-soft text-amber-700",
  high: "border-danger/30 bg-danger-soft text-danger",
};

function payloadFromTemplate(template: WorkflowTemplate): WorkflowPayload {
  return {
    name: template.name,
    description: template.description,
    trigger_type: template.triggerType,
    trigger_config: template.triggerConfig,
    stop_on_reply: template.stopOnReply,
    steps: template.steps,
  };
}

function NoteList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-ink">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-2">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function WorkflowGenerator({
  catalog,
  current,
  canCreate,
  onOpen,
  onClose,
}: {
  catalog: WorkflowCatalog | null;
  current: GeneratorTarget | null;
  canCreate: boolean;
  onOpen: (template: WorkflowTemplate) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<WorkflowGenStatus | null>(null);
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkflowGenResult | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/omniflow/portal/workflows/generate", { cache: "no-store" })
      .then(async (response) => {
        if (!alive) return;
        if (response.ok) setStatus((await response.json()) as WorkflowGenStatus);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const maxDescription = status?.limits.maxDescription ?? 1000;
  const maxInstruction = status?.limits.maxInstruction ?? 500;
  const blocked = status !== null && !status.ready;
  const changing = current !== null || result !== null;
  const preview = useMemo(() => (result ? editorFromTemplate(result.workflow) : null), [result]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    // the latest draft first, so a second change builds on the first one
    const target = result ? payloadFromTemplate(result.workflow) : current?.payload ?? null;
    if (target ? !instruction.trim() : !description.trim()) {
      setError(target ? "Say what should change." : "Describe the workflow you want.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          instruction: target ? instruction.trim() : "",
          current: target,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (WorkflowGenResult & { error?: { message?: string } })
        | null;
      if (response.ok && body?.workflow) {
        setResult(body);
        setInstruction("");
      } else {
        setError(body?.error?.message ?? "The generator could not be reached. Try again.");
      }
    } catch {
      setError("Network problem. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const triggerLabel = (type: string) =>
    catalog?.triggers.find((t) => t.trigger === type)?.label ?? type.replace(/_/g, " ");

  return (
    <section className="mb-6 rounded-xl2 border border-brand/25 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">
            <PortalIcon name="sparkles" className="mr-1.5 inline-block h-4 w-4 align-[-3px] text-brand" />
            {current ? "Change \u201c" + (current.name || "this workflow") + "\u201d with AI" : "Describe a workflow"}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-ink-2">
            {current
              ? "Say what should change. The AI rewrites the workflow and you review it in the builder."
              : "Write what should happen, in English, Roman Urdu or Urdu. The AI builds the trigger and steps from the blocks your workspace already has."}
          </p>
        </div>
        <button type="button" className={ghostBtn} onClick={onClose}>
          Close
        </button>
      </div>

      {blocked ? (
        <p className="mt-4 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-amber-700">
          {status?.reason || "The workflow generator is not available right now."}
        </p>
      ) : null}

      <form onSubmit={submit} className="mt-4 space-y-3">
        {!current ? (
          <label className="block">
            <span className="text-xs font-medium text-ink-2">What should the workflow do?</span>
            <textarea
              className={inputClass + " mt-1 min-h-[96px]"}
              value={description}
              maxLength={maxDescription}
              disabled={result !== null}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When a customer asks for a refund, check with AI that it is a real refund request, ask me for approval and tag the chat."
            />
            <span className="mt-1 block text-[11px] text-ink-3">
              {description.length}/{maxDescription}
            </span>
          </label>
        ) : null}
        {changing ? (
          <label className="block">
            <span className="text-xs font-medium text-ink-2">What should change?</span>
            <input
              className={inputClass + " mt-1"}
              value={instruction}
              maxLength={maxInstruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Wait two days instead of one, and tag the chat as follow-up."
            />
          </label>
        ) : null}
        {error ? (
          <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className={primaryBtn}
            disabled={busy || blocked || (!current && !result && !canCreate)}
          >
            {busy ? "Building..." : changing ? "Apply change" : "Build workflow"}
          </button>
          {result && !current ? (
            <button
              type="button"
              className={ghostBtn}
              disabled={busy}
              onClick={() => {
                setResult(null);
                setError(null);
              }}
            >
              Start over
            </button>
          ) : null}
          <span className="text-[11px] text-ink-3">
            {busy
              ? "This can take up to a minute."
              : !current && !result && !canCreate
                ? "You have the maximum number of workflows. Archive one first."
                : "Uses your AI engine (counts toward AI usage)."}
          </span>
        </div>
      </form>

      {result && preview ? (
        <div className="mt-5 grid gap-4 border-t border-line pt-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <p className="text-sm font-semibold text-ink">{result.workflow.name}</p>
            {result.workflow.description ? (
              <p className="mt-0.5 text-xs text-ink-2">{result.workflow.description}</p>
            ) : null}
            <p className="mt-3 text-xs text-ink-2">
              <span className="font-medium text-ink">Trigger: </span>
              {triggerLabel(result.workflow.triggerType)}
              {typeof result.workflow.triggerConfig.keyword === "string"
                ? " \u00b7 keyword \u201c" + result.workflow.triggerConfig.keyword + "\u201d"
                : ""}
              {typeof result.workflow.triggerConfig.stage === "string"
                ? " \u00b7 stage " + result.workflow.triggerConfig.stage
                : ""}
              {result.workflow.stopOnReply ? " \u00b7 stops on reply" : ""}
            </p>
            <ol className="mt-2 space-y-1.5">
              {preview.steps.map((step, index) => (
                <li key={step.key} className="rounded-lg border border-line bg-soft px-3 py-2 text-xs">
                  <span className="font-medium text-ink">
                    {index + 1}. {step.label || STEP_LABELS[step.kind]}
                  </span>
                  <span className="text-ink-3"> ({STEP_LABELS[step.kind]})</span>
                  <span className="mt-0.5 block text-ink-2">{stepSummary(step, catalog)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="space-y-3">
            {result.review.length ? (
              <ul className="space-y-1.5">
                {result.review.map((item, index) => (
                  <li key={index} className={"rounded-lg border px-3 py-2 text-xs " + (LEVEL_STYLE[item.level] ?? LEVEL_STYLE.info)}>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : null}
            <NoteList title="Check before activating" items={result.questions} />
            <NoteList title="What the AI assumed" items={result.assumptions} />
            <NoteList title="Not possible yet (left out)" items={result.unsupported} />
          </div>
          <div className="lg:col-span-2">
            {current?.active ? (
              <p className="mb-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-amber-700">
                This workflow is active. Saving it in the builder puts the change live right away.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primaryBtn} onClick={() => onOpen(result.workflow)}>
                Open in builder
              </button>
              <span className="text-[11px] text-ink-3">
                Nothing is saved yet. Check every step in the builder, then save. New workflows start as
                drafts and never run until you activate them.
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
