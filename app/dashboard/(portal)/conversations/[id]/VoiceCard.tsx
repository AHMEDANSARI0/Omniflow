"use client";

import { useCallback, useEffect, useState } from "react";

interface VoiceCall {
  id: number;
  contactId: string;
  phone: string;
  sid: string;
  status: string;
  message: string;
  direction: "inbound" | "outbound";
  hasRecording: boolean;
  durationSeconds: number;
  aiTurns?: number;
  outcome?: string;
  createdAt: string | null;
}

interface TranscriptTurn {
  role: string;
  text: string;
}

const OUTCOME_LABELS: Record<string, string> = {
  ai: "Answered by assistant",
  handoff: "Handed to team",
  turn_limit: "Reply limit reached",
  no_speech: "Caller silent",
  voicemail: "Voicemail",
  transfer_missed: "Transfer missed",
};

const ROLE_LABELS: Record<string, string> = {
  caller: "Caller",
  assistant: "Assistant",
  system: "Note",
};

function durationLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export default function VoiceCard({ conversationId }: { conversationId: number }) {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [calls, setCalls] = useState<VoiceCall[]>([]);
  const [openSid, setOpenSid] = useState("");
  const [transcript, setTranscript] = useState<TranscriptTurn[] | null>(null);

  async function toggleTranscript(sid: string) {
    if (openSid === sid) {
      setOpenSid("");
      return;
    }
    setOpenSid(sid);
    setTranscript(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/voice/calls/" + encodeURIComponent(sid) + "/transcript",
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as {
        turns?: TranscriptTurn[];
      } | null;
      setTranscript(response.ok && payload?.turns ? payload.turns : []);
    } catch {
      setTranscript([]);
    }
  }

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/voice/calls", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        calls?: VoiceCall[];
      } | null;
      if (payload && Array.isArray(payload.calls)) {
        setCalls(payload.calls.slice(0, 5));
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call() {
    if (busy) return;
    if (!phone.startsWith("+")) {
      setNote({ text: "Enter the number in +92300... format.", ok: false });
      return;
    }
    if (!message.trim()) {
      setNote({ text: "Write the short message the call should read.", ok: false });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/voice/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: String(conversationId),
          phone: phone.trim(),
          message: message.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setNote({ text: "Call placed — Twilio is dialling.", ok: true });
        setMessage("");
        await load();
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not place the call — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not place the call — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="of-fade-up rounded-2xl border border-line bg-white shadow-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">Call the customer</p>
        <span className="text-[10px] text-ink-3">Twilio voice</span>
      </div>
      <div className="mt-3 space-y-2">
        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+923001234567"
          autoComplete="off"
          className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
        />
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What should the call say? (reads aloud, max 300 chars)"
          rows={2}
          maxLength={300}
          className="w-full resize-none rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void call()}
            disabled={busy}
            className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {busy ? "Dialling…" : "Place call"}
          </button>
          {note ? (
            <span
              className={
                "text-[11px] " + (note.ok ? "text-ok" : "text-danger")
              }
            >
              {note.text}
            </span>
          ) : null}
        </div>
      </div>
      {calls.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {calls.map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink-2">{entry.phone}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <span
                    className={
                      "rounded-md border px-1.5 py-0.5 text-[10px] " +
                      (entry.direction === "inbound"
                        ? "border-brand/25 bg-brand-soft text-brand"
                        : "border-line bg-soft text-ink-3")
                    }
                  >
                    {entry.direction === "inbound" ? "In" : "Out"}
                  </span>
                  {entry.aiTurns ? (
                    <span className="rounded-md border border-brand/25 bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
                      AI
                    </span>
                  ) : null}
                  <span className="rounded-md border border-line bg-soft px-1.5 py-0.5 text-[10px] text-ink-3">
                    {entry.status}
                  </span>
                </span>
              </div>
              {entry.direction === "inbound" && (entry.aiTurns || entry.outcome) ? (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-ink-3">
                    {OUTCOME_LABELS[entry.outcome || ""] || "Phone assistant"}
                    {entry.aiTurns ? " · " + entry.aiTurns + " replies" : ""}
                  </span>
                  <button
                    onClick={() => void toggleTranscript(entry.sid)}
                    className="text-[10px] font-medium text-brand"
                  >
                    {openSid === entry.sid ? "Hide transcript" : "Transcript"}
                  </button>
                </div>
              ) : null}
              {openSid === entry.sid ? (
                <div className="mt-1.5 space-y-1 rounded-md border border-line bg-white p-2">
                  {transcript === null ? (
                    <p className="text-[10px] text-ink-3">Loading…</p>
                  ) : transcript.length === 0 ? (
                    <p className="text-[10px] text-ink-3">No transcript for this call.</p>
                  ) : (
                    transcript.map((turn, index) => (
                      <p key={index} className="text-[10px] text-ink-2">
                        <span className="font-medium text-ink">
                          {ROLE_LABELS[turn.role] || turn.role}:
                        </span>{" "}
                        {turn.text}
                      </p>
                    ))
                  )}
                </div>
              ) : null}
              {entry.hasRecording ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <audio
                    controls
                    preload="none"
                    className="h-7 w-full"
                    src={"/api/omniflow/portal/voice/recordings/" + entry.sid}
                  />
                  <span className="shrink-0 text-[10px] text-ink-3">
                    {durationLabel(entry.durationSeconds)}
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
