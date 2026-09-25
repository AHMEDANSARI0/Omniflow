export default function PortalLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-52 animate-pulse rounded-lg bg-white/5" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
        <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
      </div>
      <div className="h-72 animate-pulse rounded-2xl bg-white/5" />
    </div>
  );
}
