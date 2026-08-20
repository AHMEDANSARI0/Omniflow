"use client";

import { useActionState } from "react";
import {
  updateProblemSolutionContent,
  type ContentActionState,
} from "./actions";
import type { ProblemSolutionContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function ProblemSolutionForm({
  content,
}: {
  content: ProblemSolutionContent;
}) {
  const [state, formAction, pending] = useActionState(
    updateProblemSolutionContent,
    initialState
  );

  const metrics = [1, 2, 3, 4].map((i) => ({
    i,
    value: content[`m${i}_value`] as string,
    label: content[`m${i}_label`] as string,
  }));

  return (
    <form action={formAction} className="space-y-6">
      {/* Section heading card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Section heading</h2>
        <p className="mb-5 text-xs text-slate-500">
          Line 2 is shown with the gradient color.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="badge" className={labelClass}>
              Badge text
            </label>
            <input
              id="badge"
              name="badge"
              type="text"
              defaultValue={content.badge}
              className={inputClass}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="heading_line1" className={labelClass}>
                Heading — line 1
              </label>
              <input
                id="heading_line1"
                name="heading_line1"
                type="text"
                required
                defaultValue={content.heading_line1}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="heading_line2" className={labelClass}>
                Heading — line 2 (gradient)
              </label>
              <input
                id="heading_line2"
                name="heading_line2"
                type="text"
                defaultValue={content.heading_line2}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label htmlFor="description" className={labelClass}>
              Description
            </label>
            <textarea
              id="description"
              name="description"
              required
              rows={2}
              defaultValue={content.description}
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Comparison cards */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Comparison cards
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          Separate list items with a “|” character.
        </p>

        <div className="space-y-5">
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
              Problem card (Without OmniFlow)
            </p>
            <div className="space-y-3">
              <div>
                <label htmlFor="problem_title" className={labelClass}>
                  Card title
                </label>
                <input
                  id="problem_title"
                  name="problem_title"
                  type="text"
                  required
                  defaultValue={content.problem_title}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="problems" className={labelClass}>
                  Problem items (separate with “|”)
                </label>
                <textarea
                  id="problems"
                  name="problems"
                  required
                  rows={2}
                  defaultValue={content.problems}
                  className={`${inputClass} resize-none`}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
              Solution card (With OmniFlow)
            </p>
            <div className="space-y-3">
              <div>
                <label htmlFor="solution_title" className={labelClass}>
                  Card title
                </label>
                <input
                  id="solution_title"
                  name="solution_title"
                  type="text"
                  required
                  defaultValue={content.solution_title}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="solutions" className={labelClass}>
                  Solution items (separate with “|”)
                </label>
                <textarea
                  id="solutions"
                  name="solutions"
                  required
                  rows={2}
                  defaultValue={content.solutions}
                  className={`${inputClass} resize-none`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Metrics strip</h2>
        <p className="mb-5 text-xs text-slate-500">
          The 4 stats under the comparison (value + label each).
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {metrics.map((m) => (
            <div
              key={m.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Metric 0{m.i}
              </p>
              <div className="space-y-3">
                <div>
                  <label htmlFor={`m${m.i}_value`} className={labelClass}>
                    Value
                  </label>
                  <input
                    id={`m${m.i}_value`}
                    name={`m${m.i}_value`}
                    type="text"
                    required
                    defaultValue={m.value}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`m${m.i}_label`} className={labelClass}>
                    Label
                  </label>
                  <input
                    id={`m${m.i}_label`}
                    name={`m${m.i}_label`}
                    type="text"
                    required
                    defaultValue={m.label}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-cyan-400 px-6 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>

        {state.message && (
          <p
            className={`text-xs ${
              state.success ? "text-emerald-300" : "text-red-300"
            }`}
          >
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}