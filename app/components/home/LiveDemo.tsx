"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { DEMO_TIMING, type DemoScenario } from "../../../lib/marketing/live-demo";
import type { CopyValue } from "../../../lib/marketing/copy";
import useInView from "../hooks/useInView";
import useReducedMotion from "../hooks/useReducedMotion";
import Reveal from "../Reveal";
import Section, { SectionHead } from "../ui/Section";
import Icon from "../ui/Icon";
import StatusIndicator from "../ui/StatusIndicator";

type StepState = "idle" | "running" | "done";

function StepRow({ label, state }: { label: string; state: StepState }) {
  return (
    <li className="of-step flex items-center gap-2.5 py-1.5 text-[13.5px] font-medium text-ink" data-state={state}>
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-300 ${
          state === "done"
            ? "border-transparent bg-success text-white"
            : state === "running"
              ? "border-brand/30 bg-brand-soft text-brand"
              : "border-line bg-white text-transparent"
        }`}
      >
        {state === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <Check className="h-3 w-3" aria-hidden />
        )}
      </span>
      <span>
        {label}
        <span className="sr-only">
          {state === "done" ? " (done)" : state === "running" ? " (in progress)" : " (pending)"}
        </span>
      </span>
    </li>
  );
}

/**
 * Live demo (§216): one realistic OmniFlow run per scenario. Plays once
 * when the section scrolls into view (setTimeout chain, no animation
 * library), can be replayed, and shows the finished run directly for
 * reduced-motion users and in server HTML.
 */
export default function LiveDemo({
  scenarios,
  copy,
}: {
  scenarios: readonly DemoScenario[];
  copy: CopyValue<"home_sections">["liveDemo"];
}) {
  const [active, setActive] = useState(0);
  const [runId, setRunId] = useState(0);
  const scenario = scenarios[active] ?? scenarios[0];
  const steps = [...scenario.understanding, ...scenario.workflow];
  const finalPhase = steps.length + 3;
  const [phase, setPhase] = useState(finalPhase);
  const { ref, inView } = useInView<HTMLDivElement>("0px 0px -20% 0px");
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      setPhase(finalPhase);
      return;
    }
    setPhase(0);
    if (!inView) return;
    const timers: number[] = [];
    for (let next = 1; next <= finalPhase; next += 1) {
      timers.push(
        window.setTimeout(
          () => setPhase(next),
          DEMO_TIMING.startDelayMs + (next - 1) * DEMO_TIMING.stepMs
        )
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [inView, reduced, active, runId, finalPhase]);

  const stateFor = (index: number): StepState =>
    phase > index + 2 ? "done" : phase === index + 2 ? "running" : "idle";
  const understandingCount = scenario.understanding.length;
  const replyShown = phase >= steps.length + 2;
  const finished = phase >= finalPhase;

  return (
    <Section id={copy.id} tone="tint" labelledBy="demo-title">
      <Reveal>
        <SectionHead
          id="demo-title"
          eyebrow={copy.eyebrow}
          title={copy.title}
          copy={copy.copy}
        />
      </Reveal>

      <div role="group" aria-label="Choose a scenario" className="mt-10 flex flex-wrap justify-center gap-2">
        {scenarios.map((item, index) => {
          const selected = index === active;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setActive(index);
                setRunId((value) => value + 1);
              }}
              className={`inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[13.5px] font-semibold transition-all duration-200 ${
                selected
                  ? "border-brand/30 bg-white text-brand-2 shadow-card"
                  : "border-line bg-white/70 text-ink-2 hover:bg-white hover:text-ink"
              }`}
            >
              <Icon name={item.icon} className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </div>

      <div ref={ref} className="mx-auto mt-8 grid max-w-5xl gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        {/* conversation */}
        <div className="flex flex-col overflow-hidden rounded-xl3 border border-line bg-white shadow-card-hover">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <div className="flex items-center gap-3">
              <span aria-hidden className="of-gradient inline-flex h-9 w-9 items-center justify-center rounded-full text-white">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <p className="text-[14px] font-semibold text-ink">{copy.agentName}</p>
                <p className="text-[12px] text-ink-3">
                  {scenario.channel} · {scenario.customer.name}
                </p>
              </div>
            </div>
            <StatusIndicator label={copy.liveLabel} tone="success" pulse size="xs" />
          </div>

          <div className="flex min-h-[260px] flex-1 flex-col gap-3 bg-soft/50 p-5" aria-live="off">
            <div className="of-bubble max-w-[85%]" data-shown={phase >= 1 ? "true" : "false"}>
              <p className="rounded-2xl rounded-tl-sm border border-line bg-white px-4 py-2.5 text-[14px] leading-snug text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                {scenario.customer.message}
              </p>
              <p className="mt-1 text-[11px] text-ink-3">{scenario.customer.name}</p>
            </div>

            {phase >= 2 && !replyShown ? (
              <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-ink-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <Loader2 className="h-3 w-3 animate-spin text-brand motion-reduce:animate-none" aria-hidden />
                {copy.workingLabel}
              </p>
            ) : null}

            <div className="of-bubble ml-auto max-w-[88%]" data-shown={replyShown ? "true" : "false"}>
              <p className="rounded-2xl rounded-tr-sm bg-brand px-4 py-2.5 text-[14px] leading-snug text-white shadow-cta">
                {scenario.reply}
              </p>
              <p className="mt-1 text-right text-[11px] text-ink-3">{copy.agentName}</p>
            </div>
          </div>
        </div>

        {/* process */}
        <div className="flex flex-col rounded-xl3 border border-line bg-white p-5 shadow-card sm:p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-3">
            {copy.understandingLabel}
          </p>
          <ul className="mt-2">
            {scenario.understanding.map((label, index) => (
              <StepRow key={label} label={label} state={stateFor(index)} />
            ))}
          </ul>

          <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-3">
            {copy.workflowLabel}
          </p>
          <ul className="mt-2">
            {scenario.workflow.map((label, index) => (
              <StepRow key={label} label={label} state={stateFor(understandingCount + index)} />
            ))}
          </ul>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <div className="of-bubble" data-shown={finished ? "true" : "false"}>
              <StatusIndicator label={scenario.outcome} tone="success" />
            </div>
            <button
              type="button"
              onClick={() => setRunId((value) => value + 1)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-white px-3 text-[13px] font-semibold text-ink transition-colors hover:border-brand/40 hover:text-brand"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {copy.replay}
            </button>
          </div>
          <p className="sr-only" aria-live="polite">
            {finished ? scenario.outcome : ""}
          </p>
        </div>
      </div>
    </Section>
  );
}
