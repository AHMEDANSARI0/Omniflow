export default function ControlPlaneUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#07111f] px-5">
      <div className="w-full max-w-md rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-7 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/[0.05] text-amber-300">
          !
        </div>
        <h1 className="text-base font-semibold text-white">
          Portal temporarily unavailable
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          OmniFlow could not verify your session. No credentials were exposed
          or cleared. Please retry in a moment.
        </p>
        <a
          href="/dashboard"
          className="mt-5 inline-block rounded-xl border border-white/[0.1] px-4 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-400/30 hover:text-white"
        >
          Retry securely
        </a>
      </div>
    </main>
  );
}
