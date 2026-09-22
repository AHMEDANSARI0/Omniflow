export default function CustomersLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-white/5" />
      <div className="h-10 w-full max-w-md animate-pulse rounded-xl bg-white/5" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((card) => (
          <div
            key={card}
            className="h-28 animate-pulse rounded-2xl bg-white/5"
          />
        ))}
      </div>
    </div>
  );
}
