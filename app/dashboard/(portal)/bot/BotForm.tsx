"use client";

import { useState, useActionState } from "react";
import { updateBotSettings, type BotActionState } from "./actions";

export interface BotSettings extends Record<string, unknown> {
  bot_name: string;
  is_active: boolean;
  welcome_message: string;
  instructions: string;
  tone: string;
  fallback_message: string;
}

const initialState: BotActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function BotForm({ settings }: { settings: BotSettings }) {
  const [state, formAction, pending] = useActionState(
    updateBotSettings,
    initialState
  );
  const [active, setActive] = useState(settings.is_active);

  return (
    <form action={formAction} className="space-y-6">
      {/* Status card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Bot status</h2>
            <p className="mt-1 text-xs text-slate-500">
              When paused, your bot stops responding to new messages.
            </p>
          </div>

          {/* Toggle */}
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              name="is_active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="peer sr-only"
            />
            <span className="h-6 w-11 rounded-full bg-white/[0.08] transition-colors duration-300 peer-checked:bg-cyan-400/80" />
            <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-slate-300 transition-transform duration-300 peer-checked:translate-x-5 peer-checked:bg-[#07111f]" />
          </label>
        </div>

        <div
          className={`mt-4 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
            active
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300"
              : "border-amber-400/20 bg-amber-400/[0.05] text-amber-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              active ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          {active ? "Bot is active" : "Bot is paused"}
        </div>
      </div>

      {/* Identity card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Identity</h2>
        <p className="mb-5 text-xs text-slate-500">
          How your assistant introduces itself.
        </p>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bot_name" className={labelClass}>
                Bot name *
              </label>
              <input
                id="bot_name"
                name="bot_name"
                type="text"
                required
                defaultValue={settings.bot_name}
                placeholder="e.g. Sara"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="tone" className={labelClass}>
                Tone
              </label>
              <select
                id="tone"
                name="tone"
                defaultValue={settings.tone}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="friendly" className="bg-[#081522]">
                  Friendly
                </option>
                <option value="professional" className="bg-[#081522]">
                  Professional
                </option>
                <option value="casual" className="bg-[#081522]">
                  Casual
                </option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="welcome_message" className={labelClass}>
              Welcome message *
            </label>
            <textarea
              id="welcome_message"
              name="welcome_message"
              required
              rows={2}
              defaultValue={settings.welcome_message}
              placeholder="Hi! How can I help you today?"
              className={`${inputClass} resize-none`}
            />
          </div>
        </div>
      </div>

      {/* Behavior card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Behavior</h2>
        <p className="mb-5 text-xs text-slate-500">
          Tell the AI about your business and how it should respond. The more
          detail, the better the answers.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="instructions" className={labelClass}>
              Instructions for the AI
            </label>
            <textarea
              id="instructions"
              name="instructions"
              rows={6}
              defaultValue={settings.instructions}
              placeholder={
                "e.g. We sell handmade leather goods. Prices: wallets from Rs. 2500, bags from Rs. 8000. Delivery in 3-5 days across Pakistan. If someone asks for a custom order, collect their requirements and phone number."
              }
              className={`${inputClass} resize-none`}
            />
          </div>

          <div>
            <label htmlFor="fallback_message" className={labelClass}>
              Fallback message (when AI is unsure)
            </label>
            <textarea
              id="fallback_message"
              name="fallback_message"
              rows={2}
              defaultValue={settings.fallback_message}
              className={`${inputClass} resize-none`}
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
          {pending ? "Saving…" : "Save bot settings"}
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