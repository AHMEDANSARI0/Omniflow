export default function OnboardingLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-white/5" />
      <div className="h-4 w-72 animate-pulse rounded bg-white/5" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div
            key={row}
            className="h-28 animate-pulse rounded-2xl bg-white/5"
          />
        ))}
      </div>
    </div>
  );
}
