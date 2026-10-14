// §267 instant shell: the route paints immediately, data streams in after.
export default function WebsiteAnalyzerLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-line/60" />
      <div className="h-4 w-72 animate-pulse rounded bg-line/60" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-2xl bg-line/60" />
        <div className="h-40 animate-pulse rounded-2xl bg-line/60" />
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-line/60" />
    </div>
  );
}
