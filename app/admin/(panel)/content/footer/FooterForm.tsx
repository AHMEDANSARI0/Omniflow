"use client";

import { useActionState } from "react";
import { updateFooterContent, type ContentActionState } from "./actions";
import type { FooterContent } from "../../../../../lib/content-defaults";

const initialState: ContentActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function FooterForm({ content }: { content: FooterContent }) {
  const [state, formAction, pending] = useActionState(
    updateFooterContent,
    initialState
  );

  return (
    <form action={formAction} className="space-y-6">
      {/* Brand card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Brand text</h2>
        <p className="mb-5 text-xs text-slate-500">
          The description under the logo and the small status pill.
        </p>

        <div className="space-y-4">
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
          <div>
            <label htmlFor="status_label" className={labelClass}>
              Status label
            </label>
            <input
              id="status_label"
              name="status_label"
              type="text"
              defaultValue={content.status_label}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Social links card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Social links</h2>
        <p className="mb-5 text-xs text-slate-500">
          Full URLs (https://…). Use “#” as a placeholder, or leave empty to
          hide a link.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="linkedin_url" className={labelClass}>
              LinkedIn URL
            </label>
            <input
              id="linkedin_url"
              name="linkedin_url"
              type="text"
              defaultValue={content.linkedin_url}
              placeholder="https://linkedin.com/company/omniflow"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="x_url" className={labelClass}>
              X (Twitter) URL
            </label>
            <input
              id="x_url"
              name="x_url"
              type="text"
              defaultValue={content.x_url}
              placeholder="https://x.com/omniflow"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="instagram_url" className={labelClass}>
              Instagram URL
            </label>
            <input
              id="instagram_url"
              name="instagram_url"
              type="text"
              defaultValue={content.instagram_url}
              placeholder="https://instagram.com/omniflow"
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