"use client";

import { useActionState } from "react";
import { updateBusinessProfile, type ProfileActionState } from "./actions";

export interface BusinessProfile extends Record<string, unknown> {
  business_name: string;
  industry: string;
  phone: string;
  website: string;
  address: string;
  timezone: string;
  business_hours: string;
  default_language: string;
}

const initialState: ProfileActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function ProfileForm({ profile }: { profile: BusinessProfile }) {
  const [state, formAction, pending] = useActionState(
    updateBusinessProfile,
    initialState
  );

  return (
    <form action={formAction} className="space-y-6">
      {/* Company card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Company</h2>
        <p className="mb-5 text-xs text-slate-500">
          Basic information about your business.
        </p>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="business_name" className={labelClass}>
                Business name *
              </label>
              <input
                id="business_name"
                name="business_name"
                type="text"
                required
                defaultValue={profile.business_name}
                placeholder="e.g. Khan Traders"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="industry" className={labelClass}>
                Industry
              </label>
              <input
                id="industry"
                name="industry"
                type="text"
                defaultValue={profile.industry}
                placeholder="e.g. E-commerce"
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="phone" className={labelClass}>
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                type="text"
                defaultValue={profile.phone}
                placeholder="+92 300 1234567"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="website" className={labelClass}>
                Website
              </label>
              <input
                id="website"
                name="website"
                type="text"
                defaultValue={profile.website}
                placeholder="https://yourbusiness.com"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="address" className={labelClass}>
              Address
            </label>
            <textarea
              id="address"
              name="address"
              rows={2}
              defaultValue={profile.address}
              placeholder="Street, city"
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Availability card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Availability</h2>
        <p className="mb-5 text-xs text-slate-500">
          Helps the AI answer questions about your hours correctly.
        </p>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="timezone" className={labelClass}>
                Timezone
              </label>
              <input
                id="timezone"
                name="timezone"
                type="text"
                defaultValue={profile.timezone}
                placeholder="Asia/Karachi"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="default_language" className={labelClass}>
                Preferred language
              </label>
              <select
                id="default_language"
                name="default_language"
                defaultValue={profile.default_language}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="english" className="bg-[#081522]">
                  English
                </option>
                <option value="urdu" className="bg-[#081522]">
                  Urdu
                </option>
                <option value="both" className="bg-[#081522]">
                  Both (English + Urdu)
                </option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="business_hours" className={labelClass}>
              Business hours
            </label>
            <input
              id="business_hours"
              name="business_hours"
              type="text"
              defaultValue={profile.business_hours}
              placeholder="Mon–Sat, 9:00 – 18:00"
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
          {pending ? "Saving…" : "Save profile"}
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