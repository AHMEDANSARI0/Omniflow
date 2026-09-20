import Link from "next/link";
import {
  getPublicCheckout,
  getPublicPayInfo,
} from "../../../lib/omniflow/portal";


export default async function PublicCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await getPublicCheckout(token);
  const payInfo = view ? await getPublicPayInfo(token) : null;

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
      <div className="mt-4 flex items-center gap-1.5">
        {["ordered", "paid", "shipped", "delivered"].map((step, index) => {
          const order = ["open", "paid", "shipped", "delivered"];
          const at = order.indexOf(view.status);
          const done = view.status === "returned"
            ? false
            : at >= index && at !== 0
              ? true
              : index === 0;
          return (
            <span
              key={step}
              className={`rounded-full border px-2 py-0.5 text-[10px] capitalize ${
                done
                  ? "border-emerald-400/30 bg-emerald-400/[0.1] text-emerald-300"
                  : "border-white/[0.08] bg-white/[0.02] text-slate-500"
              }`}
            >
              {step}
            </span>
          );
        })}
      </div>

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
            <p className="text-sm font-medium text-white">
              {item.price * item.qty}
            </p>
          </li>
        ))}
      </ul>

      {view.discount > 0 ? (
        <div className="mt-2 flex items-center justify-between rounded-xl border border-rose-400/20 bg-rose-400/[0.05] px-4 py-2.5">
          <p className="text-sm text-rose-200">Discount</p>
          <p className="text-sm font-medium text-rose-200">
            -{view.discount}
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3">
        <p className="text-sm font-medium text-cyan-200">Total</p>
        <p className="text-lg font-semibold text-white">{view.total}</p>
      </div>

      {view.payment ? (
        <div className="mt-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-emerald-200">
              Advance received: {view.payment.paidAmount}
            </p>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-sm font-medium text-emerald-100">
              Due on delivery
            </p>
            <p className="text-base font-semibold text-white">
              {view.payment.due}
            </p>
          </div>
        </div>
      ) : null}

      {view.trackingNumber ? (
        <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
          <p className="text-xs text-slate-400">
            Courier: {view.courier || "-"}
          </p>
          <p className="mt-1 text-sm font-medium text-slate-200">
            Tracking #: {view.trackingNumber}
          </p>
        </div>
      ) : null}

      {payInfo && payInfo.enabled && view.payment
        && view.payment.due > 0 ? (
        <a
          href={"/api/omniflow/public/checkout/" + token + "/pay"}
          className="mt-3 block rounded-xl border border-emerald-400/30 bg-emerald-400/[0.1] px-4 py-3 text-center text-sm font-semibold text-emerald-200 hover:bg-emerald-400/[0.18]"
        >
          Pay {view.payment.due} online
        </a>
      ) : null}

      {view.status === "paid" ? (
        <p className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] px-4 py-2.5 text-center text-sm font-medium text-emerald-300">
          Paid in full — thank you!
        </p>
      ) : null}

      <p className="mt-6 text-xs text-slate-500">
        Confirm or ask questions by replying to the business on WhatsApp —
        this link always shows the latest status of your order. If the link
        has expired, ask the business for a fresh one.
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
