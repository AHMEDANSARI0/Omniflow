"use client";

import { useActionState } from "react";
import { updateUseCasesContent, type ContentActionState } from "./actions";
import type { UseCasesContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function UseCasesForm({ content }: { content: UseCasesContent }) {
  const [state, formAction, pending] = useActionState(
    updateUseCasesContent,
    initialState
  );

  const cases = [1, 2, 3, 4, 5].map((i) => ({
    i,
    label: content[`u${i}_label`] as string,
    headline: content[`u${i}_headline`] as string,
    desc: content[`u${i}_desc`] as string,
    automations: content[`u${i}_automations`] as string,
    status: content[`u${i}_status`] as string,
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

      {/* Use case blocks */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Use cases</h2>
        <p className="mb-5 text-xs text-slate-500">
          The 5 business tabs. Separate automations with a “|” character. Demo
          chats stay fixed.
        </p>

        <div className="space-y-5">
          {cases.map((c) => (
            <div
              key={c.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Use case {c.i}
              </p>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`u${c.i}_label`} className={labelClass}>
                      Tab label
                    </label>
                    <input
                      id={`u${c.i}_label`}
                      name={`u${c.i}_label`}
                      type="text"
                      required
                      defaultValue={c.label}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor={`u${c.i}_status`} className={labelClass}>
                      Outcome status chip
                    </label>
                    <input
                      id={`u${c.i}_status`}
                      name={`u${c.i}_status`}
                      type="text"
                      defaultValue={c.status}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={`u${c.i}_headline`} className={labelClass}>
                    Headline
                  </label>
                  <input
                    id={`u${c.i}_headline`}
                    name={`u${c.i}_headline`}
                    type="text"
                    required
                    defaultValue={c.headline}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`u${c.i}_desc`} className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id={`u${c.i}_desc`}
                    name={`u${c.i}_desc`}
                    required
                    rows={2}
                    defaultValue={c.desc}
                    className={`${inputClass} resize-none`}
                  />
                </div>
                <div>
                  <label htmlFor={`u${c.i}_automations`} className={labelClass}>
                    Automations (separate with “|”)
                  </label>
                  <textarea
                    id={`u${c.i}_automations`}
                    name={`u${c.i}_automations`}
                    rows={2}
                    defaultValue={c.automations}
                    className={`${inputClass} resize-none`}
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