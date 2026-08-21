import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "../../../../../lib/supabase/server";

interface Message {
  id: string;
  role: "customer" | "bot" | "agent";
  text: string;
  created_at: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const { data: conversation } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", id)
    .single();

  if (!conversation) {
    notFound();
  }

  const { data: messagesData } = await supabase
    .from("conversation_messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  const messages = (messagesData as Message[] | null) ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/conversations"
          className="text-xs text-slate-500 transition-colors hover:text-slate-300"
        >
          ← Conversations
        </Link>

        <div className="mt-3 flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-gradient-to-br from-cyan-400/[0.1] to-violet-400/[0.05] text-base font-semibold text-slate-300">
            {(conversation.customer_name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-white">
              {conversation.customer_name}
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {conversation.customer_identifier} ·{" "}
              <span className="uppercase">{conversation.channel}</span>
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-3 py-1 text-[10px] uppercase tracking-wider ${
              conversation.status === "open"
                ? "border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-300"
                : "border-white/[0.08] bg-white/[0.02] text-slate-500"
            }`}
          >
            {conversation.status}
          </span>
        </div>
      </div>

      {/* Thread */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 sm:p-6">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">
            No messages in this conversation yet.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => {
              const isCustomer = message.role === "customer";
              return (
                <div
                  key={message.id}
                  className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}
                >
                  <div className="max-w-[85%]">
                    <div
                      className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                        isCustomer
                          ? "rounded-bl-sm border border-white/[0.06] bg-white/[0.02] text-slate-300"
                          : message.role === "bot"
                            ? "rounded-br-sm border border-cyan-400/15 bg-cyan-400/[0.05] text-slate-200"
                            : "rounded-br-sm border border-violet-400/15 bg-violet-400/[0.05] text-slate-200"
                      }`}
                    >
                      {message.text}
                    </div>
                    <p
                      className={`mt-1 text-[10px] text-slate-600 ${
                        isCustomer ? "text-left" : "text-right"
                      }`}
                    >
                      {message.role === "bot"
                        ? "✦ AI"
                        : message.role === "agent"
                          ? "Agent"
                          : conversation.customer_name}{" "}
                      · {formatDateTime(message.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-4 text-center text-[11px] text-slate-600">
        Messages are pushed by your connected bot in real time. Refresh to see
        the latest.
      </p>
    </div>
  );
}