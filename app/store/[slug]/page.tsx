import {
  getPublicStore,
} from "../../../lib/omniflow/portal";
import StoreOrder from "./StoreOrder";

export default async function PublicStorePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  const store = clean ? await getPublicStore(clean) : null;

  if (!store) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold text-ink">Store not found</h1>
        <p className="mt-2 text-sm text-ink-3">
          This store link is not valid. Please ask the business for a fresh
          link.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-brand/70">
        {store.brand.name} · store
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
        {store.brand.name}
      </h1>
      {store.items.length === 0 ? (
        <p className="mt-6 text-sm text-ink-3">
          Nothing is listed yet — check back soon.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {store.items.map((item) => (
            <li
              key={item.id}
              className="rounded-2xl border border-line bg-soft p-4"
            >
              <div className="flex gap-3">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    className="h-16 w-16 shrink-0 rounded-xl border border-line object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-line bg-soft text-lg text-ink-3">
                    ◇
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {item.name}
                  </p>
                  {item.priceText ? (
                    <p className="mt-0.5 text-sm text-ok">
                      {item.priceText}
                    </p>
                  ) : item.price > 0 ? (
                    <p className="mt-0.5 text-sm text-ok">
                      Rs {item.price}
                    </p>
                  ) : null}
                  {item.notes ? (
                    <p className="mt-1 line-clamp-2 text-[11px] text-ink-3">
                      {item.notes}
                    </p>
                  ) : null}
                </div>
              </div>
              <StoreOrder slug={store.brand.slug} itemId={item.id} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-center text-[11px] text-ink-3">
        Ordering sends a confirmation link to your WhatsApp.
      </p>
    </main>
  );
}
