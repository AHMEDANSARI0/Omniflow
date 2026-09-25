import Link from "next/link";


export default function ControlPlanePending({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-sm text-ink-3">{description}</p>
      </div>

      <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.025] px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-brand/20 bg-cyan-400/[0.05] text-brand">
          ◈
        </div>
        <h2 className="text-sm font-semibold text-ink">
          Control Plane connection pending
        </h2>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-3">
          This module will activate through the tenant-scoped OmniFlow API. The
          previous direct-database path is disabled to protect customer data.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-block text-xs text-brand transition-colors hover:text-brand"
        >
          Return to secure overview →
        </Link>
      </div>
    </div>
  );
}
