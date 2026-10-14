import { redirect } from "next/navigation";
import { getAiReport, requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import AiReportClient from "./AiReportClient";

export const dynamic = "force-dynamic";

export default async function AiReportPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");
  const result = await getAiReport(accessToken);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">AI setup report</h1>
        <p className="mt-1 text-sm text-ink-2">
          How your assistant is set up, what is missing or risky, and where to
          fix it. Checked when you open this page and automatically once a day;
          nothing is changed for you.
        </p>
      </div>
      <AiReportClient
        initial={result.kind === "ok" ? result.data : null}
        initialError={
          result.kind === "invalid"
            ? result.message
            : result.kind === "unavailable"
              ? "The report could not be loaded. Try again shortly."
              : ""
        }
      />
    </div>
  );
}
