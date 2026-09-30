"use client";

import { useCallback, useEffect, useState } from "react";

import MediaStoreSection from "./MediaStoreSection";

interface VoiceAiSettings {
  enabled: boolean;
  greeting: string;
  handoff_message: string;
  language: string;
  speech_model: string;
  tts_voice: string;
  max_turns: number;
  forward_to: string;
  number: string;
}

interface VoiceAiStatus {
  active: boolean;
  reason: string;
}

interface Capability {
  active: boolean;
  reason: string;
  model: string;
}

interface MediaAsset {
  id: number;
  kind: string;
  filename: string;
}

const VOICE_REASONS: Record<string, string> = {
  active: "Answering calls",
  off: "Turned off",
  platform_off: "Paused by the platform",
  no_twilio: "Twilio is not connected on the platform",
  no_number: "No phone number assigned yet",
  no_llm: "The AI engine is not configured on the platform",
  autonomy:
    "The assistant autonomy must be Auto (Bot page) for it to answer calls",
};

const MEDIA_REASONS: Record<string, string> = {
  active: "Ready",
  off: "Paused by the platform",
  no_key: "Not configured on the platform",
  llm_disabled: "The AI engine is disabled on the platform",
};

const INPUT =
  "w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none";

function errorText(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        "rounded-full border px-2.5 py-1 text-[10px] font-semibold " +
        (ok
          ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
          : "border-line bg-soft text-ink-3")
      }
    >
      {label}
    </span>
  );
}

export default function VoiceVisionCard() {
  const [voice, setVoice] = useState<VoiceAiSettings | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceAiStatus | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [turnLimit, setTurnLimit] = useState(20);
  const [media, setMedia] = useState<{ voice_notes: boolean; images: boolean } | null>(null);
  const [platform, setPlatform] = useState<{
    voice_notes: Capability;
    images: Capability;
  } | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [assetId, setAssetId] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [testResult, setTestResult] = useState("");
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [voiceRes, mediaRes, assetsRes] = await Promise.all([
        fetch("/api/omniflow/portal/voice/ai-settings", { cache: "no-store" }),
        fetch("/api/omniflow/portal/media-ai/settings", { cache: "no-store" }),
        fetch("/api/omniflow/portal/media", { cache: "no-store" }),
      ]);
      const voicePayload = (await voiceRes.json().catch(() => null)) as {
        settings?: VoiceAiSettings;
        status?: VoiceAiStatus;
        languages?: string[];
        max_turns_limit?: number;
      } | null;
      if (voiceRes.ok && voicePayload?.settings) {
        setVoice(voicePayload.settings);
        setVoiceStatus(voicePayload.status ?? null);
        setLanguages(voicePayload.languages ?? []);
        setTurnLimit(voicePayload.max_turns_limit ?? 20);
      } else {
        setLoadError(true);
      }
      const mediaPayload = (await mediaRes.json().catch(() => null)) as {
        settings?: { voice_notes: boolean; images: boolean };
        platform?: { voice_notes: Capability; images: Capability };
      } | null;
      if (mediaRes.ok && mediaPayload?.settings) {
        setMedia(mediaPayload.settings);
        setPlatform(mediaPayload.platform ?? null);
      } else {
        setLoadError(true);
      }
      const assetsPayload = (await assetsRes.json().catch(() => null)) as {
        assets?: MediaAsset[];
      } | null;
      const usable = (assetsPayload?.assets ?? []).filter(
        (asset) => asset.kind === "audio" || asset.kind === "image"
      );
      setAssets(usable);
      setAssetId((current) => current || (usable[0]?.id ?? 0));
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveVoice() {
    if (!voice || busy) return;
    setBusy("voice");
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/voice/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: voice }),
      });
      const payload = (await response.json().catch(() => null)) as {
        settings?: VoiceAiSettings;
        status?: VoiceAiStatus;
      } | null;
      if (response.ok && payload?.settings) {
        setVoice(payload.settings);
        setVoiceStatus(payload.status ?? null);
        setNotice({ text: "Phone assistant saved.", ok: true });
      } else {
        setNotice({ text: errorText(payload, "The save did not go through."), ok: false });
      }
    } catch {
      setNotice({ text: "The save did not go through. Check the connection.", ok: false });
    } finally {
      setBusy("");
    }
  }

  async function saveMedia(next: { voice_notes: boolean; images: boolean }) {
    if (busy) return;
    setBusy("media");
    setNotice(null);
    const previous = media;
    setMedia(next);
    try {
      const response = await fetch("/api/omniflow/portal/media-ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: next }),
      });
      const payload = (await response.json().catch(() => null)) as {
        settings?: { voice_notes: boolean; images: boolean };
      } | null;
      if (response.ok && payload?.settings) {
        setMedia(payload.settings);
        setNotice({ text: "Customer media settings saved.", ok: true });
      } else {
        setMedia(previous);
        setNotice({ text: errorText(payload, "The save did not go through."), ok: false });
      }
    } catch {
      setMedia(previous);
      setNotice({ text: "The save did not go through. Check the connection.", ok: false });
    } finally {
      setBusy("");
    }
  }

  async function runTest() {
    if (!assetId || busy) return;
    setBusy("test");
    setTestResult("");
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/media-ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: assetId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        text?: string;
      } | null;
      if (response.ok && payload?.text) {
        setTestResult(payload.text);
      } else {
        setNotice({ text: errorText(payload, "The test did not go through."), ok: false });
      }
    } catch {
      setNotice({ text: "The test did not go through. Check the connection.", ok: false });
    } finally {
      setBusy("");
    }
  }

  if (!voice || !media) {
    return (
      <section className="rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-semibold text-ink">Voice and images</h2>
        <p className="mt-2 text-xs text-ink-3">
          {loadError ? "These settings could not be loaded. Refresh to try again." : "Loading…"}
        </p>
      </section>
    );
  }

  const voiceReason = voiceStatus?.reason ?? "off";

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Voice and images</h2>
        {notice ? (
          <span className={"text-[11px] " + (notice.ok ? "text-ok" : "text-danger")}>
            {notice.text}
          </span>
        ) : null}
      </div>

      {/* ---- phone assistant ---- */}
      <div className="mt-4 rounded-xl border border-line bg-soft/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-ink">Phone assistant</p>
          <StatusChip
            ok={voiceStatus?.active === true}
            label={VOICE_REASONS[voiceReason] ?? voiceReason}
          />
        </div>
        <p className="mt-1 text-[11px] text-ink-3">
          Answers calls to your number, replies from your knowledge base and
          hands the caller to your team (live transfer or voicemail) when it is
          unsure, when asked, or after the turn limit. Every call is logged
          with its transcript.
        </p>
        <p className="mt-2 text-[11px] text-ink-2">
          Your number:{" "}
          <span className="font-medium text-ink">
            {voice.number || "Not assigned. Ask the platform admin to assign one."}
          </span>
        </p>
        <label className="mt-3 flex items-center gap-3 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={voice.enabled}
            onChange={(event) => setVoice({ ...voice, enabled: event.target.checked })}
            className="h-4 w-4 accent-cyan-400"
          />
          Let the assistant answer calls
        </label>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] text-ink-3 sm:col-span-2">
            Greeting
            <input
              value={voice.greeting}
              maxLength={200}
              onChange={(event) => setVoice({ ...voice, greeting: event.target.value })}
              placeholder="Hello, thanks for calling. How can I help you today?"
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-[11px] text-ink-3 sm:col-span-2">
            Voicemail message
            <input
              value={voice.handoff_message}
              maxLength={200}
              onChange={(event) =>
                setVoice({ ...voice, handoff_message: event.target.value })
              }
              placeholder="Please leave your message after the tone and our team will call you back."
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-[11px] text-ink-3">
            Transfer to (optional)
            <input
              value={voice.forward_to}
              onChange={(event) => setVoice({ ...voice, forward_to: event.target.value })}
              placeholder="+923001234567"
              autoComplete="off"
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-[11px] text-ink-3">
            Caller language
            <select
              value={voice.language}
              onChange={(event) => setVoice({ ...voice, language: event.target.value })}
              className={INPUT + " mt-1"}
            >
              {languages.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-3">
            Assistant replies per call
            <input
              type="number"
              min={1}
              max={turnLimit}
              value={voice.max_turns}
              onChange={(event) =>
                setVoice({ ...voice, max_turns: Number(event.target.value) || 1 })
              }
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-[11px] text-ink-3">
            Speech model (optional)
            <input
              value={voice.speech_model}
              onChange={(event) => setVoice({ ...voice, speech_model: event.target.value })}
              placeholder="Twilio default"
              autoComplete="off"
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-[11px] text-ink-3 sm:col-span-2">
            Voice (optional)
            <input
              value={voice.tts_voice}
              onChange={(event) => setVoice({ ...voice, tts_voice: event.target.value })}
              placeholder="Twilio default, e.g. Polly.Aditi"
              autoComplete="off"
              className={INPUT + " mt-1"}
            />
          </label>
        </div>
        <p className="mt-2 text-[10px] text-ink-3">
          Leave the transfer number empty to send unresolved callers to
          voicemail. Some languages (for example ur-PK) depend on the speech
          model your Twilio account supports.
        </p>
        <button
          onClick={() => void saveVoice()}
          disabled={busy !== ""}
          className="mt-3 rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors disabled:opacity-50"
        >
          {busy === "voice" ? "Saving…" : "Save phone assistant"}
        </button>
      </div>

      {/* ---- customer media ---- */}
      <div className="mt-4 rounded-xl border border-line bg-soft/60 p-4">
        <p className="text-xs font-semibold text-ink">Customer voice notes and images</p>
        <p className="mt-1 text-[11px] text-ink-3">
          Voice notes are transcribed and pictures are described before the
          assistant reads the message, so it can answer them. The text is shown
          in the conversation. Content inside images is treated as customer
          data, never as instructions.
        </p>
        {(["voice_notes", "images"] as const).map((key) => {
          const capability = platform?.[key];
          return (
            <label
              key={key}
              className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2"
            >
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={media[key]}
                  disabled={busy !== ""}
                  onChange={(event) =>
                    void saveMedia({ ...media, [key]: event.target.checked })
                  }
                  className="h-4 w-4 accent-cyan-400"
                />
                {key === "voice_notes" ? "Transcribe voice notes" : "Understand images"}
              </span>
              <StatusChip
                ok={capability?.active === true}
                label={
                  (MEDIA_REASONS[capability?.reason ?? "no_key"] ?? capability?.reason ?? "") +
                  (capability?.active && capability.model ? " · " + capability.model : "")
                }
              />
            </label>
          );
        })}
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-[11px] font-medium text-ink-2">Try it on a Media library file</p>
          {assets.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-3">
              Upload an audio file or an image on the Media page to test.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={assetId}
                onChange={(event) => setAssetId(Number(event.target.value))}
                className={INPUT + " max-w-xs"}
              >
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {(asset.kind === "audio" ? "Audio: " : "Image: ") + asset.filename}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void runTest()}
                disabled={busy !== "" || !assetId}
                className="rounded-xl border border-line bg-white px-4 py-2 text-xs font-medium text-ink-2 transition-colors disabled:opacity-50"
              >
                {busy === "test" ? "Reading…" : "Test"}
              </button>
            </div>
          )}
          {testResult ? (
            <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-white px-3 py-2 text-[11px] text-ink-2">
              {testResult}
            </p>
          ) : null}
          <p className="mt-2 text-[10px] text-ink-3">
            Each test uses one AI call and counts toward your AI usage.
          </p>
        </div>
      </div>

      {/* ---- §214: customer file storage ---- */}
      <MediaStoreSection />
    </section>
  );
}
