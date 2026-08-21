import Link from "next/link";
import { createClient } from "../../../../lib/supabase/server";

interface Conversation {
  id: string;
  customer_name: string;
  customer_identifier: string;
  channel: string;
  status: string;
  last_message: string;
  last_message_at: string;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const channelColors: Record<string, string> = {
  whatsapp: "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300",
  instagram: "border-violet-400/20 bg-violet-400/[0.05] text-violet-300",
  messenger: "border-blue-400/20 bg-blue-400/[0.05] text-blue-300",
  telegram: "border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-300",
};

export default async function ConversationsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .order("last_message_at", { ascending: false });

  const conversations = (data as Conversation[] | null) ?? [];
  const openCount = conversations.filter((c) => c.status === "open").length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Conversations
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Conversations your bot is handling across channels.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-2 text-xs text-slate-400">
            Total:{" "}
            <span className="font-semibold text-white">
              {conversations.length}
            </span>
          </span>
          <span className="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] px-4 py-2 text-xs text-cyan-300">
            Open: <span className="font-semibold">{openCount}</span>
          </span>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-slate-500">
            ◎
          </div>
          <p className="text-sm font-medium text-slate-300">
            No conversations yet
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-slate-500">
            Once your bot is connected via the API, every customer
            conversation will appear here automatically.
          </p>
          <Link
            href="/dashboard/settings"
            className="mt-5 inline-block text-xs text-cyan-400/80 transition-colors hover:text-cyan-300"
          >
            Set up API access →
          </Link>
        </div>
      ) : (
        <div className="space-y-2.5">
          {conversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={`/dashboard/conversations/${conversation.id}`}
              className="group flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4 transition-colors duration-300 hover:border-cyan-400/20"
            >
              {/* Avatar */}
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-gradient-to-br from-cyan-400/[0.1] to-violet-400/[0.05] text-sm font-semibold text-slate-300">
                {(conversation.customer_name || "?").charAt(0).toUpperCase()}
              </div>

              {/* Details */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">
                    {conversation.customer_name}
                  </span>
                  <span
                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                      channelColors[conversation.channel] ??
                      "border-white/[0.08] bg-white/[0.02] text-slate-500"
                    }`}
                  >
                    {conversation.channel}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {conversation.last_message || "No messages yet"}
                </p>
              </div>

              {/* Meta */}
              <div className="shrink-0 text-right">
                <p className="text-[10px] text-slate-600">
                  {formatTime(conversation.last_message_at)}
                </p>
                <span
                  className={`mt-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                    conversation.status === "open"
                      ? "bg-cyan-400"
                      : "bg-slate-600"
                  }`}
                />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}