import { getAnalytics } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import AnalyticsClient from "./AnalyticsClient";
import CsatSummaryCard from "./CsatSummaryCard";


export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { accessToken } = await readSessionCookies();
  const data = accessToken ? await getAnalytics(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Analytics
        </h1>
        <p className="mt-1 text-sm text-ink-3">
          How your assistant is performing — conversations, messages,
          automation and the questions customers actually ask.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-line bg-soft p-6">
          <p className="text-xs leading-relaxed text-ink-3">
            Analytics is rolling out on the server — try again shortly after
            the deploy finishes.
          </p>
        </div>
      ) : (
        <>
          <AnalyticsClient initial={data} />
          <CsatSummaryCard />
        </>
      )}
    </div>
  );
}
