import { getAnalytics } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import AnalyticsClient from "./AnalyticsClient";


export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { accessToken } = await readSessionCookies();
  const data = accessToken ? await getAnalytics(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Analytics
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          How your assistant is performing — conversations, messages,
          automation and the questions customers actually ask.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
          <p className="text-xs leading-relaxed text-slate-500">
            Analytics is rolling out on the server — try again shortly after
            the deploy finishes.
          </p>
        </div>
      ) : (
        <AnalyticsClient initial={data} />
      )}
    </div>
  );
}
