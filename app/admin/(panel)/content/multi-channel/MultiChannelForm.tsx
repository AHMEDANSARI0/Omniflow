"use client";

import { useActionState } from "react";
import {
  updateMultiChannelContent,
  type ContentActionState,
} from "./actions";
import type { MultiChannelContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function MultiChannelForm({
  content,
}: {
  content: MultiChannelContent;
}) {
  const [state, formAction, pending] = useActionState(
    updateMultiChannelContent,
    initialState
  );

  const channels = [1, 2, 3, 4].map((i) => ({
    i,
    name: content[`c${i}_name`] as string,
    short: content[`c${i}_short`] as string,
    desc: content[`c${i}_desc`] as string,
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

      {/* Channels */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Channel cards</h2>
        <p className="mb-5 text-xs text-slate-500">
          The 4 channels around the AI engine. Short code shows in the icon
          box (2–3 letters).
        </p>

        <div className="space-y-5">
          {channels.map((c) => (
            <div
              key={c.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Channel 0{c.i}
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor={`c${c.i}_name`} className={labelClass}>
                    Name
                  </label>
                  <input
                    id={`c${c.i}_name`}
                    name={`c${c.i}_name`}
                    type="text"
                    required
                    defaultValue={c.name}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`c${c.i}_short`} className={labelClass}>
                    Short code
                  </label>
                  <input
                    id={`c${c.i}_short`}
                    name={`c${c.i}_short`}
                    type="text"
                    required
                    maxLength={3}
                    defaultValue={c.short}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`c${c.i}_desc`} className={labelClass}>
                    Description
                  </label>
                  <input
                    id={`c${c.i}_desc`}
                    name={`c${c.i}_desc`}
                    type="text"
                    defaultValue={c.desc}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Workflow strip */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Workflow strip</h2>
        <p className="mb-5 text-xs text-slate-500">
          The bar under the visual. Separate actions with commas.
        </p>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="workflow_title" className={labelClass}>
                Title
              </label>
              <input
                id="workflow_title"
                name="workflow_title"
                type="text"
                defaultValue={content.workflow_title}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="workflow_subtitle" className={labelClass}>
                Subtitle
              </label>
              <input
                id="workflow_subtitle"
                name="workflow_subtitle"
                type="text"
                defaultValue={content.workflow_subtitle}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label htmlFor="actions" className={labelClass}>
              Action chips (comma separated)
            </label>
            <input
              id="actions"
              name="actions"
              type="text"
              defaultValue={content.actions}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="bottom_note" className={labelClass}>
              Bottom note
            </label>
            <input
              id="bottom_note"
              name="bottom_note"
              type="text"
              defaultValue={content.bottom_note}
              className={inputClass}
            />
          </div>
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
