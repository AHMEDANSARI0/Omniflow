"use client";

/**
 * Portal-wide error boundary: a friendly Roman-Urdu card with a
 * retry instead of a broken screen when a page-level render fails.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#07111f] px-4">
      <div className="w-full max-w-md rounded-2xl border border-rose-400/20 bg-rose-400/[0.05] p-6 text-center">
        <h1 className="text-lg font-semibold text-white">
          This page failed to load
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Try again in a moment. If it keeps failing, sign in once
          more.
        </p>
        {error.digest ? (
          <p className="mt-2 text-[11px] text-slate-600">
            Reference: {error.digest}
          </p>
        ) : null}
        <button
          onClick={reset}
          className="mt-4 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs text-cyan-200 hover:bg-cyan-400/[0.15]"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
