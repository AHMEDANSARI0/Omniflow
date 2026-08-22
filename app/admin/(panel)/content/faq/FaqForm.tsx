"use client";

import { useActionState } from "react";
import { updateFaqContent, type ContentActionState } from "./actions";
import type { FaqContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function FaqForm({ content }: { content: FaqContent }) {
  const [state, formAction, pending] = useActionState(
    updateFaqContent,
    initialState
  );

  const items = [1, 2, 3, 4, 5, 6].map((i) => ({
    i,
    q: content[`q${i}`] as string,
    a: content[`a${i}`] as string,
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
              rows={2}
              defaultValue={content.description}
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Q&A blocks */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Questions & answers
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          Up to 6 items. Leave a question empty to hide it on the website.
        </p>

        <div className="space-y-5">
          {items.map((item) => (
            <div
              key={item.i}
              className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Question 0{item.i}
              </p>
              <div className="space-y-3">
                <div>
                  <label htmlFor={`q${item.i}`} className={labelClass}>
                    Question
                  </label>
                  <input
                    id={`q${item.i}`}
                    name={`q${item.i}`}
                    type="text"
                    required={item.i === 1}
                    defaultValue={item.q}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`a${item.i}`} className={labelClass}>
                    Answer
                  </label>
                  <textarea
                    id={`a${item.i}`}
                    name={`a${item.i}`}
                    required={item.i === 1}
                    rows={3}
                    defaultValue={item.a}
                    className={`${inputClass} resize-none`}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Contact card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Contact strip</h2>
        <p className="mb-5 text-xs text-slate-500">
          Shown under the FAQ. Set your real support email here.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="contact_text" className={labelClass}>
              Text
            </label>
            <input
              id="contact_text"
              name="contact_text"
              type="text"
              defaultValue={content.contact_text}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="contact_email" className={labelClass}>
              Contact email
            </label>
            <input
              id="contact_email"
              name="contact_email"
              type="email"
              defaultValue={content.contact_email}
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