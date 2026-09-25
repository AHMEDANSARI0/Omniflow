export default function ConversationsLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-white/5" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          <div className="h-10 animate-pulse rounded-xl bg-white/5" />
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div
              key={row}
              className="h-16 animate-pulse rounded-2xl bg-white/5"
            />
          ))}
        </div>
        <div className="hidden h-96 animate-pulse rounded-2xl bg-white/5 lg:block" />
      </div>
    </div>
  );
}
