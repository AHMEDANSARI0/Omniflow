import Link from "next/link";
import { getPublicCheckout } from "../../../lib/omniflow/portal";


export default async function PublicCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await getPublicCheckout(token);

  if (!view) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold text-white">Link not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          This order link is not valid. Please ask the business for a fresh
          link.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
        OmniFlow order summary
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
        {view.title || "Your order"}
      </h1>
      <p className="mt-1 text-sm capitalize text-slate-500">
        Status: {view.status}
      </p>

      <ul className="mt-6 space-y-2">
        {view.items.map((item, index) => (
          <li
            key={index}
            className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3"
          >
            <div>
              <p className="text-sm text-slate-200">{item.name}</p>
              <p className="text-[11px] text-slate-500">Qty {item.qty}</p>
            </div>
            <p className="text-sm font-medium text-white">{item.price}</p>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3">
        <p className="text-sm font-medium text-cyan-200">Total</p>
        <p className="text-lg font-semibold text-white">{view.total}</p>
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Confirm or ask questions by replying to the business on WhatsApp —
        this link always shows the latest status of your order.
      </p>

      <Link
        href="/"
        className="mt-8 inline-block text-xs text-slate-600 transition-colors hover:text-slate-400"
      >
        Powered by OmniFlow
      </Link>
    </main>
  );
}
