"use client";

import { useCallback, useEffect, useState } from "react";

interface VideoRoom {
  id: number;
  conversationId: number;
  contactId: string;
  provider: string;
  url: string;
  createdAt: string | null;
}

export default function VideoCard({ conversationId }: { conversationId: number }) {
  const [provider, setProvider] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [rooms, setRooms] = useState<VideoRoom[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/video/rooms?conversation_id=" + conversationId,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        rooms?: VideoRoom[];
      } | null;
      if (payload && Array.isArray(payload.rooms)) {
        setRooms(payload.rooms.slice(0, 3));
      }
    } catch {
      return;
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/video/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          provider: provider || undefined,
          title: title.trim() || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        room?: VideoRoom;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setNote({
          text: "Invite sent to the customer on WhatsApp.",
          ok: true,
        });
        setTitle("");
        await load();
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not create the room — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not create the room — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Video invite</p>
        <span className="text-[10px] text-slate-500">Whereby / Daily / Zoom</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Creates a room and drops the link into this chat.
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="w-32 rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 py-2 text-xs text-slate-200 focus:border-cyan-400/40 focus:outline-none"
          >
            <option value="">Default</option>
            <option value="whereby">Whereby</option>
            <option value="daily">Daily</option>
            <option value="zoom">Zoom</option>
          </select>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Topic (optional)"
            className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void invite()}
            disabled={busy}
            className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create & send invite"}
          </button>
          {note ? (
            <span
              className={
                "text-[11px] " + (note.ok ? "text-emerald-300" : "text-rose-300")
              }
            >
              {note.text}
            </span>
          ) : null}
        </div>
      </div>
      {rooms.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {rooms.map((room) => (
            <li key={room.id}>
              <a
                href={room.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04]"
              >
                <span className="truncate">{room.url}</span>
                <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[10px] text-slate-400">
                  {room.provider}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
