"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SemanticStatus {
  active: boolean;
  reason: string;
  mode: string;
  model: string;
  dimensions: number;
  min_similarity: number;
  key_source: string;
  total: number;
  indexed: number;
  pending: number;
  coverage: number;
  running: boolean;
  provider_cooldown: boolean;
  last_sync_at: string | null;
  last_error: string;
  last_embedded: number;
  last_reused: number;
  started?: boolean;
}

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

const POLL_MS = 3000;
const POLL_MAX = 60;

function inactiveCopy(reason: string): string {
  if (reason === "off") {
    return "Semantic search is switched off for this platform. Your assistant uses keyword search.";
  }
  if (reason === "llm_disabled") {
    return "AI is disabled on this platform, so semantic search is paused. Your assistant uses keyword search.";
  }
  return "Semantic search is not configured yet. Your assistant uses keyword search until the platform admin adds an embeddings key under Integrations.";
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString();
}

/**
 * Knowledge base -> Semantic search (D1): shows whether meaning-based
 * retrieval is active, how much of the published knowledge is indexed,
 * and lets the owner start an index build. Indexing also runs by itself
 * after every knowledge edit.
 */
export default function KbSemanticCard() {
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const polls = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<SemanticStatus | null> => {
    try {
      const response = await fetch("/api/omniflow/portal/kb/semantic", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const next = response.ok ? ((await response.json()) as SemanticStatus) : null;
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      polls.current += 1;
      const next = await load();
      if (next && (next.running || next.started) && next.pending > 0 && polls.current < POLL_MAX) {
        poll();
      }
    }, POLL_MS);
  }, [load]);

  useEffect(() => {
    void load().then((first) => {
      if (first && first.running) poll();
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, poll]);

  async function build() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/omniflow/portal/kb/semantic/sync", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          (payload && payload.error && payload.error.message) ||
            "Could not start indexing. Try again shortly."
        );
        return;
      }
      setStatus(payload as SemanticStatus);
      polls.current = 0;
      poll();
    } catch {
      setError("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <section className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-semibold text-ink">Semantic search</h2>
        <p className="mt-1 text-xs text-ink-3">Checking the index{"\u2026"}</p>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-semibold text-ink">Semantic search</h2>
        <p className="mt-1 text-xs text-ink-3">
          Semantic search status is unavailable right now. Keyword search keeps working.
        </p>
      </section>
    );
  }

  const percent = Math.round((status.coverage || 0) * 100);
  const indexing = status.running || Boolean(status.started);

  return (
    <section className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Semantic search
            <span
              className={
                "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                (status.active
                  ? "border-brand/25 bg-brand-soft text-brand"
                  : "border-line text-ink-3")
              }
            >
              {status.active ? "On" : "Keyword only"}
            </span>
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            {status.active
              ? "Your assistant finds answers by meaning as well as exact words, so questions phrased differently still reach the right section. Only published documents and active answers are indexed."
              : inactiveCopy(status.reason)}
          </p>
        </div>
        {status.active ? (
          <button
            type="button"
            onClick={() => void build()}
            disabled={busy || indexing || status.total === 0}
            className={primaryBtn}
          >
            {indexing ? "Indexing\u2026" : busy ? "Starting\u2026" : "Build index now"}
          </button>
        ) : null}
      </div>

      {status.active ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-soft">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: percent + "%" }}
            />
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            {status.total === 0
              ? "Nothing to index yet. Publish a document or add an answer."
              : status.indexed +
                " of " +
                status.total +
                " items indexed (" +
                percent +
                "%)" +
                (status.pending > 0 ? " \u00b7 " + status.pending + " waiting" : "")}
          </p>
          <p className="mt-1 text-[11px] text-ink-3">
            {"Model " +
              (status.model || "default") +
              (status.dimensions ? " \u00b7 " + status.dimensions + " dimensions" : "") +
              " \u00b7 last indexed " +
              when(status.last_sync_at) +
              (status.last_reused > 0
                ? " \u00b7 " + status.last_reused + " reused without new cost"
                : "")}
          </p>
          {status.provider_cooldown ? (
            <p className="mt-2 text-xs text-amber-700">
              The embeddings provider is not responding. Keyword search is used until it recovers.
            </p>
          ) : null}
          {status.last_error ? (
            <p className="mt-2 text-xs text-danger">
              Last indexing attempt failed: {status.last_error}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </section>
  );
}
