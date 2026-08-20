"use client";

import { useActionState } from "react";
import {
  updateAiIntelligenceContent,
  type ContentActionState,
} from "./actions";
import type { AiIntelligenceContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function AiIntelligenceForm({
  content,
}: {
  content: AiIntelligenceContent;
}) {
  const [state, formAction, pending] = useActionState(
    updateAiIntelligenceContent,
    initialState
  );

  const pillars = [1, 2, 3].map((i) => ({
    i,
    title: content[`i${i}_title`] as string,
    desc: content[`i${i}_desc`] as string,
    tags: content[`i${i}_tags`] as string,
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

      {/* Pillars */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Intelligence pillars
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          The 3 cards under the engine visual. Separate tags with commas.
        </p>

        <div className="space-y-5">
          {pillars.map((p) => (
            <div
              key={p.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Pillar 0{p.i}
              </p>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`i${p.i}_title`} className={labelClass}>
                      Title
                    </label>
                    <input
                      id={`i${p.i}_title`}
                      name={`i${p.i}_title`}
                      type="text"
                      required
                      defaultValue={p.title}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor={`i${p.i}_tags`} className={labelClass}>
                      Tags (comma separated)
                    </label>
                    <input
                      id={`i${p.i}_tags`}
                      name={`i${p.i}_tags`}
                      type="text"
                      defaultValue={p.tags}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={`i${p.i}_desc`} className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id={`i${p.i}_desc`}
                    name={`i${p.i}_desc`}
                    required
                    rows={2}
                    defaultValue={p.desc}
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
