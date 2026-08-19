"use client";

import { useState, useActionState } from "react";
import { updateSeoSettings, type SeoActionState } from "./actions";
import type { SiteSettings } from "../../../../lib/settings";

const initialState: SeoActionState = { success: false, message: "" };

function Counter({ value, max }: { value: number; max: number }) {
  const over = value > max;
  return (
    <span className={`text-[10px] ${over ? "text-amber-400" : "text-slate-600"}`}>
      {value}/{max}
    </span>
  );
}

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass =
  "mb-1.5 flex items-center justify-between text-xs font-medium text-slate-400";

export default function SeoForm({ settings }: { settings: SiteSettings }) {
  const [state, formAction, pending] = useActionState(
    updateSeoSettings,
    initialState
  );

  const [metaTitle, setMetaTitle] = useState(settings.meta_title);
  const [metaDescription, setMetaDescription] = useState(
    settings.meta_description
  );

  return (
    <form action={formAction} className="space-y-6">
      {/* Search engine section */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Search engine listing
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          How the website appears in Google and other search engines.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="meta_title" className={labelClass}>
              <span>Meta title</span>
              <Counter value={metaTitle.length} max={60} />
            </label>
            <input
              id="meta_title"
              name="meta_title"
              type="text"
              required
              value={metaTitle}
              onChange={(e) => setMetaTitle(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="meta_description" className={labelClass}>
              <span>Meta description</span>
              <Counter value={metaDescription.length} max={160} />
            </label>
            <textarea
              id="meta_description"
              name="meta_description"
              required
              rows={3}
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              className={`${inputClass} resize-none`}
            />
          </div>

          <div>
            <label htmlFor="keywords" className={labelClass}>
              <span>Keywords</span>
              <span className="text-[10px] text-slate-600">comma separated</span>
            </label>
            <input
              id="keywords"
              name="keywords"
              type="text"
              defaultValue={settings.keywords}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Social sharing section */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Social sharing (Open Graph)
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          How links look when shared on WhatsApp, LinkedIn, X and Facebook.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="og_title" className={labelClass}>
              <span>Social title</span>
            </label>
            <input
              id="og_title"
              name="og_title"
              type="text"
              defaultValue={settings.og_title}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="og_description" className={labelClass}>
              <span>Social description</span>
            </label>
            <textarea
              id="og_description"
              name="og_description"
              rows={3}
              defaultValue={settings.og_description}
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Site section */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Site</h2>
        <p className="mb-5 text-xs text-slate-500">
          The canonical URL of the website (used in metadata).
        </p>

        <div>
          <label htmlFor="site_url" className={labelClass}>
            <span>Site URL</span>
          </label>
          <input
            id="site_url"
            name="site_url"
            type="url"
            required
            defaultValue={settings.site_url}
            placeholder="https://omniflow.com"
            className={inputClass}
          />
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