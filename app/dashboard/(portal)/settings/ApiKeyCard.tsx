"use client";

import { useActionState } from "react";
import {
  generateApiKey,
  revokeApiKey,
  type ApiKeyActionState,
} from "./actions";

export interface ApiKeyInfo {
  key_prefix: string;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
}

const initialState: ApiKeyActionState = { success: false, message: "" };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function ApiKeyCard({ keyInfo }: { keyInfo: ApiKeyInfo | null }) {
  const [genState, genAction, genPending] = useActionState(
    generateApiKey,
    initialState
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeApiKey,
    initialState
  );

  const hasActiveKey = keyInfo !== null && !keyInfo.revoked;

  return (
    <div className="space-y-6">
      {/* API key card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">API key</h2>
        <p className="mb-5 text-xs text-slate-500">
          Your bot uses this key to read its configuration and push
          conversations to OmniFlow. Keep it secret.
        </p>

        {/* Newly generated key — shown once */}
        {genState.success && genState.newKey && (
          <div className="mb-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4">
            <p className="text-xs font-medium text-emerald-300">
              ✓ {genState.message}
            </p>
            <code className="mt-3 block select-all break-all rounded-lg border border-white/[0.08] bg-[#060f1b] px-3 py-2.5 font-mono text-xs text-cyan-300">
              {genState.newKey}
            </code>
          </div>
        )}

        {/* Current key status */}
        {hasActiveKey && !genState.newKey ? (
          <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Key
              </p>
              <p className="mt-0.5 font-mono text-xs text-slate-300">
                {keyInfo.key_prefix}••••••••
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Created
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {formatDate(keyInfo.created_at)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Last used
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {keyInfo.last_used_at
                  ? formatDate(keyInfo.last_used_at)
                  : "Never"}
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Active
            </span>
          </div>
        ) : !hasActiveKey && !genState.newKey ? (
          <p className="mb-5 text-xs text-slate-500">
            {keyInfo?.revoked
              ? "Your key was revoked. Generate a new one to reconnect your bot."
              : "No API key yet. Generate one to connect your bot."}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <form action={genAction}>
            <button
              type="submit"
              disabled={genPending}
              className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {genPending
                ? "Generating…"
                : hasActiveKey
                  ? "Regenerate key"
                  : "Generate API key"}
            </button>
          </form>

          {hasActiveKey && (
            <form action={revokeAction}>
              <button
                type="submit"
                disabled={revokePending}
                className="rounded-xl border border-red-400/20 bg-red-400/[0.04] px-5 py-2.5 text-sm font-medium text-red-300 transition-colors duration-300 hover:border-red-400/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {revokePending ? "Revoking…" : "Revoke key"}
              </button>
            </form>
          )}

          {!genState.success && genState.message && (
            <p className="text-xs text-red-300">{genState.message}</p>
          )}
          {revokeState.message && (
            <p
              className={`text-xs ${
                revokeState.success ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {revokeState.message}
            </p>
          )}
        </div>

        <p className="mt-4 text-[11px] text-slate-600">
          ⚠ Regenerating or revoking immediately disconnects any bot using the
          old key.
        </p>
      </div>

      {/* Integration guide card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">
          Connect your bot
        </h2>
        <p className="mb-5 text-xs text-slate-500">
          Works with any stack — Python, Node.js, n8n or anything that can
          make HTTP requests.
        </p>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              1 · Read your bot&apos;s configuration
            </p>
            <code className="block overflow-x-auto rounded-lg border border-white/[0.06] bg-[#060f1b] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-400">
              GET /api/bot/config
              <br />
              Authorization: Bearer ofk_your_key
            </code>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              2 · Push conversation messages
            </p>
            <code className="block overflow-x-auto rounded-lg border border-white/[0.06] bg-[#060f1b] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-400">
              POST /api/bot/messages
              <br />
              Authorization: Bearer ofk_your_key
              <br />
              {`{ "customer_identifier": "+92300...", "customer_name": "Ahmed", "channel": "whatsapp", "role": "customer", "text": "Hello!" }`}
            </code>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-600">
            role = <span className="text-slate-400">customer</span> (incoming),{" "}
            <span className="text-slate-400">bot</span> (AI reply) or{" "}
            <span className="text-slate-400">agent</span> (human reply).
            Conversations appear automatically in your dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}