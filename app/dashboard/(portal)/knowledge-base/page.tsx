import { getKnowledgeBase } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import KnowledgeBaseClient from "./KnowledgeBaseClient";
import KbGapsCard from "./KbGapsCard";


export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const { accessToken } = await readSessionCookies();
  const data = accessToken ? await getKnowledgeBase(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Knowledge base
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Ready answers your assistant sends instantly when customers ask
          general questions. Add entries with trigger keywords; sensitive
          conversations are never auto-answered.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
          <p className="text-xs leading-relaxed text-slate-500">
            The knowledge base is rolling out on the server — try again
            shortly after the deploy finishes.
          </p>
        </div>
      ) : (
        <>
          <KbGapsCard />
          <KnowledgeBaseClient initial={data} />
        </>
      )}
    </div>
  );
}
