"use client";

import { useActionState } from "react";
import { updateWhyOmniFlowContent, type ContentActionState } from "./actions";
import type { WhyOmniFlowContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function WhyOmniFlowForm({
  content,
}: {
  content: WhyOmniFlowContent;
}) {
  const [state, formAction, pending] = useActionState(
    updateWhyOmniFlowContent,
    initialState
  );

  const benefits = [1, 2, 3, 4].map((i) => ({
    i,
    title: content[`b${i}_title`] as string,
    desc: content[`b${i}_desc`] as string,
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

      {/* Benefit rows */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Benefit rows</h2>
        <p className="mb-5 text-xs text-slate-500">
          The 4 numbered benefits on the left side of the section.
        </p>

        <div className="space-y-5">
          {benefits.map((b) => (
            <div
              key={b.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Benefit 0{b.i}
              </p>
              <div className="space-y-3">
                <div>
                  <label htmlFor={`b${b.i}_title`} className={labelClass}>
                    Title
                  </label>
                  <input
                    id={`b${b.i}_title`}
                    name={`b${b.i}_title`}
                    type="text"
                    required
                    defaultValue={b.title}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`b${b.i}_desc`} className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id={`b${b.i}_desc`}
                    name={`b${b.i}_desc`}
                    required
                    rows={2}
                    defaultValue={b.desc}
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