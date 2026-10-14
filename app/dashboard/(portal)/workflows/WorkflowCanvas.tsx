"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowCatalog, WorkflowStepKind } from "../../../../lib/omniflow/portal";
import {
  DECISION_KINDS,
  NODE_H,
  NODE_KINDS,
  NODE_W,
  STEP_LABELS,
  STOP_H,
  STOP_W,
  layoutWorkflow,
  nodeY,
  reachability,
  slotFromY,
  slotIndicatorY,
  stepSummary,
  type EditorStep,
} from "./workflow-model";
import PortalIcon, { type IconName } from "../../components/PortalIcon";

/** §246: inline SVG icons (never emoji) for each step kind. */
const KIND_ICON: Record<WorkflowStepKind, IconName> = {
  condition: "condition",
  branch: "split",
  ai_decision: "sparkles",
  action: "play",
  wait: "clock",
  approval: "approvals",
  handoff: "handoff",
  goal: "flag",
  stop: "stop",
};

const KIND_TONE: Record<WorkflowStepKind, string> = {
  condition: "border-sky-200 bg-sky-50 text-sky-700",
  branch: "border-sky-200 bg-sky-50 text-sky-700",
  ai_decision: "border-violet-200 bg-violet-50 text-violet-700",
  action: "border-brand/25 bg-brand-soft text-brand",
  wait: "border-line-2 bg-soft text-ink-2",
  approval: "border-amber-300/40 bg-amber-50 text-amber-700",
  handoff: "border-amber-300/40 bg-amber-50 text-amber-700",
  goal: "border-emerald-400/30 bg-emerald-400/10 text-ok",
  stop: "border-line-2 bg-soft text-ink-3",
};

const EDGE_STROKE: Record<string, string> = {
  next: "#94a3b8",
  yes: "#059669",
  no: "#d97706",
  skip: "#d97706",
  jump: "#d97706",
};

export type Selection = number | "trigger" | null;

interface DragState {
  type: "move" | "insert";
  from?: number;
  kind?: WorkflowStepKind;
  startY: number;
  active: boolean;
}

export default function WorkflowCanvas({
  steps,
  catalog,
  selected,
  issues,
  triggerTitle,
  triggerSubtitle,
  zoom,
  maxSteps,
  onSelect,
  onReorder,
  onInsert,
  onRemove,
}: {
  steps: EditorStep[];
  catalog: WorkflowCatalog | null;
  selected: Selection;
  issues: Map<number, string[]>;
  triggerTitle: string;
  triggerSubtitle: string;
  zoom: number;
  maxSteps: number;
  onSelect: (selection: Selection) => void;
  onReorder: (from: number, slot: number) => void;
  onInsert: (slot: number, kind: WorkflowStepKind) => void;
  onRemove: (key: number) => void;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [menuSlot, setMenuSlot] = useState<number | null>(null);

  const layout = useMemo(() => layoutWorkflow(steps), [steps]);
  const reachable = useMemo(() => reachability(steps), [steps]);
  const full = steps.length >= maxSteps;

  const canvasY = useCallback(
    (clientY: number): number => {
      const inner = innerRef.current;
      if (!inner) return 0;
      const rect = inner.getBoundingClientRect();
      return (clientY - rect.top) / zoom;
    },
    [zoom]
  );

  // ----- pointer drag (nodes + palette) -----
  function startDrag(event: React.PointerEvent<HTMLElement>, state: Omit<DragState, "startY" | "active">) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ ...state, startY: event.clientY, active: false });
    setMenuSlot(null);
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    if (!drag) return;
    const moved = Math.abs(event.clientY - drag.startY) > 4;
    if (!drag.active && !moved) return;
    if (!drag.active) setDrag({ ...drag, active: true });
    setDropSlot(slotFromY(canvasY(event.clientY), steps.length));
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (!drag) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released
    }
    const slot = dropSlot;
    const wasActive = drag.active;
    const current = drag;
    setDrag(null);
    setDropSlot(null);
    if (!wasActive) {
      // plain click
      if (current.type === "move" && current.from !== undefined) onSelect(steps[current.from].key);
      if (current.type === "insert" && current.kind && !full) {
        const after = typeof selected === "number" ? steps.findIndex((s) => s.key === selected) : -1;
        onInsert(after >= 0 ? after + 1 : steps.length, current.kind);
      }
      return;
    }
    if (slot === null) return;
    if (current.type === "move" && current.from !== undefined) onReorder(current.from, slot);
    if (current.type === "insert" && current.kind && !full) onInsert(slot, current.kind);
  }

  // ----- keyboard -----
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
    if (event.key === "Escape") {
      setMenuSlot(null);
      onSelect(null);
      return;
    }
    const index = typeof selected === "number" ? steps.findIndex((s) => s.key === selected) : -1;
    if ((event.key === "Delete" || event.key === "Backspace") && index >= 0) {
      event.preventDefault();
      onRemove(steps[index].key);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (selected === "trigger" && steps.length) onSelect(steps[0].key);
      else if (index >= 0 && index + 1 < steps.length) onSelect(steps[index + 1].key);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) onSelect("trigger");
      else if (index > 0) onSelect(steps[index - 1].key);
    }
  }

  useEffect(() => {
    if (menuSlot === null) return;
    function close(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-insert-menu]")) setMenuSlot(null);
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuSlot]);

  const scaledWidth = layout.width * zoom;
  const scaledHeight = layout.height * zoom;

  /** Clicking bare canvas (not a node/button) clears the selection. */
  function deselectOnBackground(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onSelect(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ------------------------------------------------------ palette */}
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Node palette">
        <span className="mr-1 text-[11px] text-ink-3">Drag onto the canvas or click to add:</span>
        {NODE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={full}
            title={full ? "Step limit reached" : "Drag to place, click to add after the selected step"}
            className={
              "select-none rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors duration-300 disabled:opacity-40 " +
              KIND_TONE[kind] +
              " cursor-grab active:cursor-grabbing"
            }
            style={{ touchAction: "none" }}
            onPointerDown={(event) => startDrag(event, { type: "insert", kind })}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={() => {
              setDrag(null);
              setDropSlot(null);
            }}
          >
            <span className="mr-1" aria-hidden="true">
              <PortalIcon name={KIND_ICON[kind]} />
            </span>
            {STEP_LABELS[kind]}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------- canvas */}
      <div
        className="relative overflow-auto rounded-xl2 border border-line bg-[linear-gradient(to_right,rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.12)_1px,transparent_1px)] bg-[size:24px_24px] outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        style={{ minHeight: 420, maxHeight: "70vh" }}
        tabIndex={0}
        role="application"
        aria-label="Workflow canvas"
        onKeyDown={onKeyDown}
        onMouseDown={deselectOnBackground}
      >
        <div
          style={{ width: scaledWidth, height: scaledHeight, position: "relative" }}
          onMouseDown={deselectOnBackground}
        >
          <div
            ref={innerRef}
            onMouseDown={deselectOnBackground}
            style={{
              width: layout.width,
              height: layout.height,
              transform: "scale(" + zoom + ")",
              transformOrigin: "0 0",
              position: "absolute",
              left: 0,
              top: 0,
            }}
          >
            {/* edges */}
            <svg
              width={layout.width}
              height={layout.height}
              className="pointer-events-none absolute left-0 top-0"
              aria-hidden="true"
            >
              <defs>
                {Object.entries(EDGE_STROKE).map(([kind, color]) => (
                  <marker
                    key={kind}
                    id={"wf-arrow-" + kind}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                  </marker>
                ))}
              </defs>
              {layout.edges.map((edge) => (
                <g key={edge.id}>
                  <path
                    d={edge.path}
                    fill="none"
                    stroke={EDGE_STROKE[edge.kind]}
                    strokeWidth={1.5}
                    strokeDasharray={edge.dashed ? "4 4" : undefined}
                    markerEnd={"url(#wf-arrow-" + edge.kind + ")"}
                  />
                  {edge.label ? (
                    <text
                      x={edge.labelX}
                      y={edge.labelY}
                      fontSize={10}
                      fontWeight={600}
                      fill={EDGE_STROKE[edge.kind]}
                      stroke="#ffffff"
                      strokeWidth={3}
                      paintOrder="stroke"
                      textAnchor={edge.kind === "yes" && edge.label.includes("\u2192") ? "end" : "start"}
                    >
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {layout.stops.map((stop) => (
                <g key={stop.id}>
                  <rect
                    x={stop.x}
                    y={stop.y}
                    width={STOP_W}
                    height={STOP_H}
                    rx={12}
                    fill="#f8fafc"
                    stroke="#cbd5e1"
                  />
                  <text
                    x={stop.x + STOP_W / 2}
                    y={stop.y + STOP_H / 2 + 3.5}
                    fontSize={10}
                    fontWeight={600}
                    fill="#64748b"
                    textAnchor="middle"
                  >
                    Stop
                  </text>
                </g>
              ))}
            </svg>

            {/* trigger node */}
            <button
              type="button"
              className={
                "absolute flex items-center gap-3 rounded-xl border px-3 text-left transition-[box-shadow,border-color] duration-200 " +
                (selected === "trigger"
                  ? "border-brand bg-brand-soft shadow-card ring-2 ring-brand/30"
                  : "border-brand/40 bg-brand-soft/60 hover:border-brand")
              }
              style={{ left: layout.nodes[0].x, top: layout.nodes[0].y, width: NODE_W, height: NODE_H }}
              onClick={() => onSelect("trigger")}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-white text-sm text-brand" aria-hidden="true">
                <PortalIcon name="automation" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-brand">Trigger</span>
                <span className="block truncate text-sm font-semibold text-ink">{triggerTitle}</span>
                {triggerSubtitle ? <span className="block truncate text-[11px] text-ink-3">{triggerSubtitle}</span> : null}
              </span>
            </button>

            {/* step nodes */}
            {steps.map((step, index) => {
              const node = layout.nodes[index + 1];
              const isSelected = selected === step.key;
              const stepIssues = issues.get(step.key) ?? [];
              const dragging = drag?.active && drag.type === "move" && drag.from === index;
              const dead = !reachable[index];
              return (
                <div
                  key={step.key}
                  className={
                    "absolute flex items-stretch rounded-xl border bg-white text-left transition-[transform,box-shadow,border-color,opacity] duration-200 " +
                    (isSelected ? "border-brand shadow-card ring-2 ring-brand/30" : "border-line hover:border-line-2") +
                    (dragging ? " opacity-60 shadow-lg" : "") +
                    (dead ? " opacity-70" : "")
                  }
                  style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                  data-step-key={step.key}
                >
                  <button
                    type="button"
                    aria-label={"Move step " + (index + 1)}
                    title="Drag to reorder"
                    className="flex w-7 shrink-0 cursor-grab select-none items-center justify-center rounded-l-xl border-r border-line bg-soft text-ink-3 hover:text-ink active:cursor-grabbing"
                    style={{ touchAction: "none" }}
                    onPointerDown={(event) => startDrag(event, { type: "move", from: index })}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={() => {
                      setDrag(null);
                      setDropSlot(null);
                    }}
                  >
                    <PortalIcon name="grip" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
                    onClick={() => onSelect(step.key)}
                  >
                    <span
                      className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-sm " + KIND_TONE[step.kind]}
                      aria-hidden="true"
                    >
                      <PortalIcon name={KIND_ICON[step.kind]} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-ink">
                          {step.label.trim() || STEP_LABELS[step.kind]}
                        </span>
                        <span className="shrink-0 text-[10px] text-ink-3">{STEP_LABELS[step.kind]}</span>
                      </span>
                      <span className="block truncate text-[11px] text-ink-3">{stepSummary(step, catalog)}</span>
                      {DECISION_KINDS.includes(step.kind) && step.elseMode === "continue" ? (
                        <span className="block text-[10px] text-amber-700">no: continues to the next step</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="rounded-md border border-line bg-soft px-1.5 text-[10px] font-semibold text-ink-2">
                        {index + 1}
                      </span>
                      {stepIssues.length ? (
                        <span
                          className="h-2 w-2 rounded-full bg-amber-500"
                          title={stepIssues.join(" ")}
                          aria-label={"Needs attention: " + stepIssues.join(" ")}
                        />
                      ) : null}
                    </span>
                  </button>
                  {dead ? (
                    <span className="absolute -bottom-4 left-8 text-[10px] text-amber-700">Not reachable from the trigger</span>
                  ) : null}
                </div>
              );
            })}

            {/* insert buttons on each connector */}
            {!full
              ? Array.from({ length: steps.length + 1 }, (_, slot) => slot).map((slot) => (
                  <div
                    key={"ins-" + slot}
                    className="absolute"
                    style={{ left: layout.nodes[0].x + NODE_W / 2 - 10, top: slotIndicatorY(slot) - 10 }}
                    data-insert-menu
                  >
                    <button
                      type="button"
                      aria-label={"Insert a step at position " + (slot + 1)}
                      className={
                        "flex h-5 w-5 items-center justify-center rounded-full border bg-white text-xs leading-none transition-colors duration-200 " +
                        (menuSlot === slot
                          ? "border-brand text-brand"
                          : "border-line-2 text-ink-3 hover:border-brand hover:text-brand")
                      }
                      onClick={() => setMenuSlot(menuSlot === slot ? null : slot)}
                    >
                      +
                    </button>
                    {menuSlot === slot ? (
                      <div className="absolute left-7 top-0 z-10 w-44 rounded-xl border border-line bg-white p-1.5 shadow-card">
                        {NODE_KINDS.map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-ink-2 hover:bg-line/60 hover:text-ink"
                            onClick={() => {
                              setMenuSlot(null);
                              onInsert(slot, kind);
                            }}
                          >
                            <span className="w-4 text-center" aria-hidden="true">
                              <PortalIcon name={KIND_ICON[kind]} />
                            </span>
                            {STEP_LABELS[kind]}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              : null}

            {/* drop indicator */}
            {drag?.active && dropSlot !== null ? (
              <div
                className="pointer-events-none absolute h-0.5 rounded bg-brand"
                style={{ left: layout.nodes[0].x - 8, top: slotIndicatorY(dropSlot) - 1, width: NODE_W + 16 }}
              />
            ) : null}

            {/* empty state */}
            {steps.length === 0 ? (
              <div
                className="pointer-events-none absolute flex items-center justify-center rounded-xl border border-dashed border-line-2 text-center text-[11px] text-ink-3"
                style={{ left: layout.nodes[0].x, top: nodeY(1), width: NODE_W, height: NODE_H }}
              >
                Drop a step here, or click one in the palette
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
