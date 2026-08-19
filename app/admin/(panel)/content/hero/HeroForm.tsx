"use client";

import { useActionState } from "react";
import { updateHeroContent, type ContentActionState } from "./actions";
import type { HeroContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function HeroForm({ content }: { content: HeroContent }) {
  const [state, formAction, pending] = useActionState(
    updateHeroContent,
    initialState
  );

  return (
    <form action={formAction} className="space-y-6">
      {/* Headline card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Headline</h2>
        <p className="mb-5 text-xs text-slate-500">
          The main heading. Line 2 is shown with the gradient color.
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
              rows={3}
              defaultValue={content.description}
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Buttons card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Buttons</h2>
        <p className="mb-5 text-xs text-slate-500">
          Labels only — where they link stays fixed.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="primary_button" className={labelClass}>
              Primary button
            </label>
            <input
              id="primary_button"
              name="primary_button"
              type="text"
              defaultValue={content.primary_button}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="secondary_button" className={labelClass}>
              Secondary button
            </label>
            <input
              id="secondary_button"
              name="secondary_button"
              type="text"
              defaultValue={content.secondary_button}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Channels card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Channels strip</h2>
        <p className="mb-5 text-xs text-slate-500">
          The small label and channel chips under the buttons.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="channels_label" className={labelClass}>
              Label
            </label>
            <input
              id="channels_label"
              name="channels_label"
              type="text"
              defaultValue={content.channels_label}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="integrations" className={labelClass}>
              Channels (comma separated)
            </label>
            <input
              id="integrations"
              name="integrations"
              type="text"
              defaultValue={content.integrations}
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