import { getKnowledgeBase, listBrands } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import KnowledgeBaseClient from "./KnowledgeBaseClient";
import KbGapsCard from "./KbGapsCard";
import KbSourcesCard from "./KbSourcesCard";
import KbRetrievalTester from "./KbRetrievalTester";


export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const { accessToken } = await readSessionCookies();
  const [data, brands] = await Promise.all([
    accessToken ? getKnowledgeBase(accessToken) : Promise.resolve(null),
    accessToken ? listBrands(accessToken) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Knowledge base
        </h1>
        <p className="mt-1 text-sm text-ink-2">
          Everything your assistant is allowed to know: ready answers it sends
          instantly, plus documents and web pages it reads before replying.
          Sensitive conversations are never auto-answered, and nothing you
          import is used until you publish it.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-line bg-white shadow-card p-6">
          <p className="text-xs leading-relaxed text-ink-3">
            The knowledge base is rolling out on the server — try again
            shortly after the deploy finishes.
          </p>
        </div>
      ) : (
        <>
          <KbGapsCard />
          <KbSourcesCard />
          <KbRetrievalTester />
          <KnowledgeBaseClient
            initial={data}
            brands={(brands ?? []).map((b) => ({ id: b.id, name: b.name }))}
          />
        </>
      )}
    </div>
  );
}
