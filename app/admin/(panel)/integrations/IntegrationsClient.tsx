"use client";

import { useCallback, useEffect, useState } from "react";
import VoiceNumbersPanel from "./VoiceNumbersPanel";

type GroupKey =
  | "email"
  | "llm"
  | "flags"
  | "voice"
  | "video"
  | "payments"
  | "whatsapp_e2e"
  | "stt"
  | "embeddings"
  | "vision";

type Field = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

type GroupDef = {
  id: GroupKey;
  title: string;
  description: string;
  fields?: Field[];
  toggles?: { key: string; label: string; hint: string }[];
  note?: string;
  actions?: ("test" | "weekly")[];
};

const GROUPS: GroupDef[] = [
  {
    id: "email",
    title: "Email (SMTP / Brevo)",
    description:
      "Password-reset codes and the weekly report are parked on these keys.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        placeholder: "smtp",
        hint: "smtp or brevo",
      },
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp-relay.brevo.com" },
      { key: "smtp_port", label: "SMTP port", placeholder: "587" },
      { key: "smtp_user", label: "SMTP user" },
      { key: "smtp_password", label: "SMTP password", secret: true },
      {
        key: "smtp_from",
        label: "From address",
        placeholder: "OmniFlow <no-reply@yourdomain.com>",
      },
      { key: "brevo_api_key", label: "Brevo API key", secret: true },
      {
        key: "reports_to",
        label: "Reports to",
        placeholder: "owner@yourdomain.com",
        hint: "Where the weekly report lands",
      },
    ],
    actions: ["test", "weekly"],
  },
  {
    id: "llm",
    title: "AI engine",
    description:
      "Any OpenAI-compatible endpoint. Powers drafts, intents and the AI switches below.",
    fields: [
      { key: "base_url", label: "Base URL", placeholder: "https://api.openai.com/v1" },
      { key: "api_key", label: "API key", secret: true },
      { key: "model", label: "Model", placeholder: "gpt-4o-mini" },
      {
        key: "prices_json",
        label: "Model prices (JSON, USD per 1M tokens)",
        placeholder: '{"gpt-4o-mini": {"input": 0.15, "output": 0.6}, "default": {"input": 1, "output": 2}}',
        hint: "Used by the AI operations card to estimate spend. Leave blank to show tokens only.",
      },
    ],
  },
  {
    id: "stt",
    title: "Speech-to-Text (voice notes)",
    description:
      "Transcribes customer voice notes (Telegram and any bridge that forwards audio) before the assistant reads them, and powers the media library transcribe button. Works with any OpenAI-compatible endpoint (OpenAI Whisper, Groq). Saving takes effect immediately - no redeploy needed.",
    fields: [
      {
        key: "mode",
        label: "Customer voice notes",
        placeholder: "on",
        hint: "on or off. Off stops automatic transcription of customer voice notes (the media library button keeps working).",
      },
      { key: "api_key", label: "API key", secret: true },
      { key: "base_url", label: "Base URL", placeholder: "https://api.openai.com/v1" },
      { key: "model", label: "Model", placeholder: "whisper-1" },
    ],
    note:
      "Workspaces can switch this off for themselves under Settings > Voice and images. Every transcription goes through the AI kill switch and daily cap and is billed to the Voice note transcription line in AI usage.",
  },
  {
    id: "vision",
    title: "Image understanding (customer photos)",
    description:
      "Describes pictures customers send (product photos, payment screenshots, damage) so the assistant can answer them. Uses any OpenAI-compatible model that reads images. Leave the key, base URL and model blank to reuse the AI engine above (Gemini Flash and GPT-4o-mini both read images).",
    fields: [
      {
        key: "mode",
        label: "Mode",
        placeholder: "on",
        hint: "on or off.",
      },
      {
        key: "api_key",
        label: "API key",
        secret: true,
        hint: "Blank = reuse the AI engine key.",
      },
      {
        key: "base_url",
        label: "Base URL",
        placeholder: "https://api.openai.com/v1",
        hint: "Set this together with a separate key. Blank = the AI engine base URL.",
      },
      {
        key: "model",
        label: "Model",
        placeholder: "gpt-4o-mini",
        hint: "Blank = the AI engine model.",
      },
    ],
    note:
      "Text inside images is treated as customer data, never as instructions. Every call goes through the AI kill switch and daily cap and is billed to the Image understanding line in AI usage.",
  },
  {
    id: "embeddings",
    title: "Knowledge semantic search (embeddings)",
    description:
      "Lets the assistant find knowledge by meaning, not only by exact words. Works with any OpenAI-compatible /embeddings endpoint. Leave the key and base URL blank to reuse the AI engine above. Saving takes effect immediately - no redeploy needed.",
    fields: [
      {
        key: "mode",
        label: "Mode",
        placeholder: "on",
        hint: "on or off. Off keeps keyword-only retrieval.",
      },
      {
        key: "api_key",
        label: "API key",
        secret: true,
        hint: "Blank = reuse the AI engine key.",
      },
      {
        key: "base_url",
        label: "Base URL",
        placeholder: "https://api.openai.com/v1",
        hint: "Blank = reuse the AI engine base URL.",
      },
      {
        key: "model",
        label: "Model",
        placeholder: "text-embedding-3-small",
        hint: "Blank = gemini-embedding-001 on Gemini, text-embedding-3-small elsewhere.",
      },
      {
        key: "dimensions",
        label: "Dimensions",
        placeholder: "256",
        hint: "0 = provider default. Changing model or dimensions rebuilds the index automatically.",
      },
      {
        key: "min_similarity",
        label: "Minimum similarity (%)",
        placeholder: "30",
        hint: "Blank = 60 for Gemini models, 30 for others. Raise it if unrelated sections show up.",
      },
    ],
    note:
      "Workspaces see index progress under Knowledge base. Every embedding call goes through the AI kill switch and daily cap, and is billed to the Knowledge semantic index line in AI usage.",
  },
  {
    id: "flags",
    title: "AI switches",
    description:
      "Flip these once the AI key above is saved — true sentiment powers the Assist card's sentiment (an 'AI' tag marks LLM results), and KB auto-draft ships a saveable knowledge-base entry with every draft.",
    toggles: [
      {
        key: "true_sentiment",
        label: "True sentiment (LLM)",
        hint: "The sentiment endpoint classifies with the AI engine instead of the word list.",
      },
      {
        key: "kb_autodraft",
        label: "KB auto-draft",
        hint: "Answer drafts also ship a saveable knowledge-base entry.",
      },
      {
        key: "phone_verification",
        label: "Phone verification (Ph9)",
        hint: "The switch the phone-verification feature will read when it ships.",
      },
    ],
  },
  {
    id: "voice",
    title: "Voice channel",
    description: "Twilio credentials for the voice channel (keys ready before launch).",
    fields: [
      { key: "provider", label: "Provider", placeholder: "twilio" },
      { key: "account_sid", label: "Account SID" },
      { key: "auth_token", label: "Auth token", secret: true },
      { key: "from_number", label: "From number", placeholder: "+92300..." },
      {
        key: "greeting",
        label: "Voicemail greeting",
        placeholder: "Thanks for calling. Please leave your message after the tone.",
        hint: "Played to callers when no workspace assistant answers. 200 characters max.",
      },
      {
        key: "ai_loop",
        label: "Phone assistant",
        placeholder: "on",
        hint: "on or off. Off sends every call to voicemail (platform-wide pause).",
      },
      {
        key: "signature_check",
        label: "Twilio signature check",
        placeholder: "enforce",
        hint: "enforce, log or off. Enforce rejects webhook calls not signed with the auth token above.",
      },
    ],
    note:
      "The conversation Call button dials through Twilio with these keys. For inbound calls, point each Twilio number's Voice webhook to /api/v1/public/voice/incoming on the Control Plane and its status callback to /api/v1/public/voice/webhook, then assign the number to a workspace below.",
  },
  {
    id: "video",
    title: "Video channel",
    description: "Meeting-link provider for the video channel.",
    fields: [
      { key: "provider", label: "Provider", placeholder: "whereby / daily / zoom" },
      { key: "api_key", label: "Whereby / Daily API key", secret: true },
      { key: "zoom_account_id", label: "Zoom account id" },
      { key: "zoom_client_id", label: "Zoom client id" },
      { key: "zoom_client_secret", label: "Zoom client secret", secret: true },
    ],
    note:
      "Whereby/Daily need the API key; Zoom needs the three OAuth fields. The conversation Video invite button uses these.",
  },
  {
    id: "payments",
    title: "Payments channel",
    description:
      "Platform payment-processor keys. (Per-workspace JazzCash/Easypaisa live in the portal settings.)",
    fields: [
      { key: "provider", label: "Provider", placeholder: "stripe" },
      { key: "publishable_key", label: "Publishable key" },
      { key: "secret_key", label: "Secret key", secret: true },
      { key: "webhook_secret", label: "Webhook secret", secret: true },
    ],
    note:
      "Legacy gateway key — workspaces pay through Pakistan gateways (JazzCash / Easypaisa) with their own keys in Settings > Payments. This platform key stays unused unless the legacy Stripe path is re-enabled in code.",
  },
  {
    id: "whatsapp_e2e",
    title: "WhatsApp E2E test",
    description:
      "The live number the laptop end-to-end run should message. Save it here so the runbook picks it up.",
    fields: [
      { key: "live_number", label: "Live test number", placeholder: "+92300..." },
    ],
  },
];

type Values = Record<string, Record<string, string>>;
type Configured = Record<string, boolean>;

function fieldInputType(field: Field, value: string): string {
  if (field.secret && !value.startsWith("\u2022")) return "password";
  return "text";
}

export default function IntegrationsClient() {
  const [values, setValues] = useState<Values>({});
  const [configured, setConfigured] = useState<Configured>({});
  const [loading, setLoading] = useState(true);
  const [busyGroup, setBusyGroup] = useState<string>("");
  const [notice, setNotice] = useState<{ group: string; text: string; ok: boolean } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.groups) {
        const next: Values = {};
        const nextConfigured: Configured = {};
        for (const def of GROUPS) {
          const group = payload.groups[def.id] || {};
          const row: Record<string, string> = {};
          for (const field of def.fields || []) {
            row[field.key] = String(group[field.key] ?? "");
          }
          next[def.id] = row;
          nextConfigured[def.id] = Boolean(group.configured);
        }
        setValues(next);
        setConfigured(nextConfigured);
      }
    } catch {
      // keep whatever is on screen
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update(group: GroupKey, key: string, value: string) {
    setValues((prev) => ({
      ...prev,
      [group]: { ...(prev[group] || {}), [key]: value },
    }));
  }

  async function save(def: GroupDef) {
    setBusyGroup(def.id);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: def.id, values: values[def.id] || {} }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.ok) {
        const kept = Array.isArray(payload.kept_blank) ? payload.kept_blank : [];
        setNotice({
          group: def.id,
          ok: true,
          text:
            "Saved." +
            (kept.length ? " Left " + kept.join(", ") + " unchanged (blank)." : ""),
        });
        await load();
      } else {
        setNotice({
          group: def.id,
          ok: false,
          text: payload && payload.error ? payload.error.message : "Could not save — try again.",
        });
      }
    } catch {
      setNotice({ group: def.id, ok: false, text: "Could not save — try again." });
    } finally {
      setBusyGroup("");
    }
  }

  async function action(def: GroupDef, kind: "test" | "weekly") {
    setBusyGroup(def.id + ":" + kind);
    setNotice(null);
    try {
      const to = (values[def.id] || {}).reports_to || "";
      const response = await fetch(
        kind === "test"
          ? "/api/omniflow/admin/providers/email-test"
          : "/api/omniflow/admin/providers/weekly-report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.ok) {
        setNotice({
          group: def.id,
          ok: true,
          text:
            kind === "test"
              ? "Test email sent — check the inbox."
              : "Weekly report sent" +
                (payload.clients ? " for " + payload.clients + " workspace(s)." : "."),
        });
      } else {
        setNotice({
          group: def.id,
          ok: false,
          text: payload && payload.error ? payload.error.message : "Could not send — try again.",
        });
      }
    } catch {
      setNotice({ group: def.id, ok: false, text: "Could not send — try again." });
    } finally {
      setBusyGroup("");
    }
  }

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="rounded-2xl border border-line bg-white shadow-card p-6 text-sm text-ink-3">
          Loading integration settings…
        </div>
      ) : null}
      {GROUPS.map((def) => {
        const groupValues = values[def.id] || {};
        const isOn = configured[def.id];
        return (
          <div
            key={def.id}
            className="rounded-2xl border border-line bg-white shadow-card p-6"
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">{def.title}</h2>
              <span
                className={
                  "rounded-md border px-2 py-0.5 text-[10px] " +
                  (isOn
                    ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                    : "border-line bg-soft text-ink-3")
                }
              >
                {isOn ? "Saved" : "Not set"}
              </span>
            </div>
            <p className="mb-5 text-xs text-ink-3">{def.description}</p>

            {(def.fields || []).length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {(def.fields || []).map((field) => (
                  <label key={field.key} className="block">
                    <span className="mb-1 block text-[11px] font-medium text-ink-2">
                      {field.label}
                    </span>
                    <input
                      type={fieldInputType(field, groupValues[field.key] || "")}
                      value={groupValues[field.key] || ""}
                      onChange={(event) =>
                        update(def.id, field.key, event.target.value)
                      }
                      placeholder={field.placeholder}
                      autoComplete="off"
                      className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
                    />
                    {field.hint ? (
                      <span className="mt-1 block text-[10px] text-ink-3">
                        {field.hint}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}

            {def.toggles ? (
              <div className="space-y-3">
                {def.toggles.map((toggle) => (
                  <label
                    key={toggle.key}
                    className="flex items-start gap-3 rounded-xl border border-line bg-white shadow-card px-4 py-3"
                  >
                    <input
                      type="checkbox"
                      checked={(groupValues[toggle.key] || "") === "on"}
                      onChange={(event) =>
                        update(
                          def.id,
                          toggle.key,
                          event.target.checked ? "on" : "off"
                        )
                      }
                      className="mt-0.5 h-4 w-4 accent-cyan-400"
                    />
                    <span>
                      <span className="block text-sm text-ink">
                        {toggle.label}
                      </span>
                      <span className="block text-[11px] text-ink-3">
                        {toggle.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            {def.note ? (
              <p className="mt-4 text-[11px] text-ink-3">{def.note}</p>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void save(def)}
                disabled={busyGroup === def.id}
                className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
              >
                {busyGroup === def.id ? "Saving…" : "Save"}
              </button>
              {def.actions?.includes("test") ? (
                <button
                  onClick={() => void action(def, "test")}
                  disabled={busyGroup === def.id + ":test"}
                  className="rounded-xl border border-line bg-white shadow-card px-4 py-2 text-xs text-ink-2 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {busyGroup === def.id + ":test" ? "Sending…" : "Send test email"}
                </button>
              ) : null}
              {def.actions?.includes("weekly") ? (
                <button
                  onClick={() => void action(def, "weekly")}
                  disabled={busyGroup === def.id + ":weekly"}
                  className="rounded-xl border border-line bg-white shadow-card px-4 py-2 text-xs text-ink-2 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {busyGroup === def.id + ":weekly"
                    ? "Sending…"
                    : "Send weekly report now"}
                </button>
              ) : null}
              {notice && notice.group === def.id ? (
                <span
                  className={
                    "text-[11px] " + (notice.ok ? "text-ok" : "text-danger")
                  }
                >
                  {notice.text}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      <VoiceNumbersPanel />
    </div>
  );
}
