"use client";

import { useActionState } from "react";
import { updateFeaturesContent, type ContentActionState } from "./actions";
import type { FeaturesContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

export default function FeaturesForm({ content }: { content: FeaturesContent }) {
  const [state, formAction, pending] = useActionState(
    updateFeaturesContent,
    initialState
  );

  const cards = [1, 2, 3, 4, 5, 6].map((i) => ({
    i,
    title: content[`f${i}_title`] as string,
    desc: content[`f${i}_desc`] as string,
  }));

  return (
    <form action={formAction} className="space-y-6">
      {/* Section heading card */}
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">Section heading</h2>
        <p className="mb-5 text-xs text-ink-3">
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

      {/* Feature cards */}
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">Feature cards</h2>
        <p className="mb-5 text-xs text-ink-3">
          The 6 capability cards. Icons and layout stay fixed — only text is
          editable.
        </p>

        <div className="space-y-5">
          {cards.map((card) => (
            <div
              key={card.i}
              className="rounded-xl border border-line bg-soft p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Feature 0{card.i}
              </p>
              <div className="space-y-3">
                <div>
                  <label htmlFor={`f${card.i}_title`} className={labelClass}>
                    Title
                  </label>
                  <input
                    id={`f${card.i}_title`}
                    name={`f${card.i}_title`}
                    type="text"
                    required
                    defaultValue={card.title}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`f${card.i}_desc`} className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id={`f${card.i}_desc`}
                    name={`f${card.i}_desc`}
                    required
                    rows={2}
                    defaultValue={card.desc}
                    className={`${inputClass} resize-none`}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Capability strip */}
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">
          Capability strip
        </h2>
        <p className="mb-5 text-xs text-ink-3">
          The small items under the grid. Separate each with a “|” character.
        </p>

        <textarea
          id="capabilities"
          name="capabilities"
          rows={2}
          defaultValue={content.capabilities}
          className={`${inputClass} resize-none`}
        />
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
              state.success ? "text-ok" : "text-danger"
            }`}
          >
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}