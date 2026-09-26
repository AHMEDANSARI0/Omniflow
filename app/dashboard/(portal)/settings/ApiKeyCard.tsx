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
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">API key</h2>
        <p className="mb-5 text-xs text-ink-3">
          Read-only key for your own integrations — it reads your bot config,
          profile and conversations from the OmniFlow API. Keep it secret.
        </p>

        {/* Newly generated key — shown once */}
        {genState.success && genState.newKey && (
          <div className="mb-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4">
            <p className="text-xs font-medium text-ok">
              ✓ {genState.message}
            </p>
            <code className="mt-3 block select-all break-all rounded-lg border border-line bg-white px-3 py-2.5 font-mono text-xs text-brand">
              {genState.newKey}
            </code>
          </div>
        )}

        {/* Current key status */}
        {hasActiveKey && !genState.newKey ? (
          <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-soft px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Key
              </p>
              <p className="mt-0.5 font-mono text-xs text-ink-2">
                {keyInfo.key_prefix}••••••••
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Created
              </p>
              <p className="mt-0.5 text-xs text-ink-3">
                {formatDate(keyInfo.created_at)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Last used
              </p>
              <p className="mt-0.5 text-xs text-ink-3">
                {keyInfo.last_used_at
                  ? formatDate(keyInfo.last_used_at)
                  : "Never"}
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Active
            </span>
          </div>
        ) : !hasActiveKey && !genState.newKey ? (
          <p className="mb-5 text-xs text-ink-3">
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
                className="rounded-xl border border-red-400/20 bg-red-400/[0.04] px-5 py-2.5 text-sm font-medium text-danger transition-colors duration-300 hover:border-red-400/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {revokePending ? "Revoking…" : "Revoke key"}
              </button>
            </form>
          )}

          {!genState.success && genState.message && (
            <p className="text-xs text-danger">{genState.message}</p>
          )}
          {revokeState.message && (
            <p
              className={`text-xs ${
                revokeState.success ? "text-ok" : "text-danger"
              }`}
            >
              {revokeState.message}
            </p>
          )}
        </div>

        <p className="mt-4 text-[11px] text-ink-3">
          ⚠ Regenerating or revoking immediately disconnects any bot using the
          old key.
        </p>
      </div>

      {/* Integration guide card */}
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">
          Connect your bot
        </h2>
        <p className="mb-5 text-xs text-ink-3">
          Works with any stack — Python, Node.js, n8n or anything that can
          make HTTP requests.
        </p>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">
              1 · Read your AI agent configuration
            </p>
            <code className="block overflow-x-auto rounded-lg border border-line bg-white px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-3">
              GET https://omniflow-control-plane-rho.vercel.app/api/v1/portal/bot
              <br />
              Authorization: Bearer ofk_your_key
            </code>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">
              2 · Read your business profile
            </p>
            <code className="block overflow-x-auto rounded-lg border border-line bg-white px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-3">
              GET https://omniflow-control-plane-rho.vercel.app/api/v1/portal/profile
              <br />
              Authorization: Bearer ofk_your_key
            </code>
          </div>

          <p className="text-[11px] leading-relaxed text-ink-3">
            Keys are tenant-scoped and <span className="text-ink-3">read-only</span>{" "}
            — perfect for dashboards and custom integrations. Your managed
            connector (laptop) uses its own service key.
          </p>
        </div>
      </div>
    </div>
  );
}