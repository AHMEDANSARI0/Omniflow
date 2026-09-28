export default function InsightsLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-4" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-soft" />
      <div className="h-4 w-80 animate-pulse rounded bg-soft" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-32 animate-pulse rounded-2xl bg-soft" />
        ))}
      </div>
    </div>
  );
}
