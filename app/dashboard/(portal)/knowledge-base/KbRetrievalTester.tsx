"use client";

import { useState } from "react";

interface KbHit {
  kind: "entry" | "chunk";
  id: number;
  title: string;
  content: string;
  source: string;
  position: number;
  score: number;
  matched: string[];
  via?: "keyword" | "semantic" | "both";
  semantic?: number | null;
}

interface SearchPayload {
  query: string;
  tokens: string[];
  hits: KbHit[];
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand/[0.12] disabled:opacity-50";

/**
 * Knowledge base -> Test retrieval: type a customer question and see the
 * exact ranked knowledge (answers + published document sections) the
 * assistant would be given, with the matched words and a relevance score.
 * With semantic search on, each hit also says whether it was found by
 * words, by meaning, or both, plus the meaning similarity.
 */

function hitDetail(hit: KbHit): string {
  const parts: string[] = [];
  if (hit.via === "semantic") {
    parts.push("found by meaning");
  } else if (hit.via === "both") {
    parts.push("found by words and meaning");
  } else {
    parts.push("score " + hit.score.toFixed(2));
  }
  if (typeof hit.semantic === "number") {
    parts.push("similarity " + Math.round(hit.semantic * 100) + "%");
  }
  if (hit.matched.length > 0) parts.push(hit.matched.join(", "));
  return parts.join(" \u00b7 ");
}
export default function KbRetrievalTester() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/kb/search?q=" + encodeURIComponent(q) + "&n=5",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) {
        setError("Retrieval is unavailable right now. Try again shortly.");
        setResult(null);
        return;
      }
      setResult((await response.json()) as SearchPayload);
    } catch {
      setError("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
      <h2 className="text-sm font-semibold text-ink">Test retrieval</h2>
      <p className="mt-1 text-xs text-ink-3">
        Ask a question the way a customer would and see which answers and
        document sections the assistant would read before replying.
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. delivery kitne din me hoti hai?"
          maxLength={300}
          className={inputClass}
        />
        <button type="submit" disabled={busy || !query.trim()} className={primaryBtn}>
          {busy ? "Searching\u2026" : "Search"}
        </button>
      </form>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      {result ? (
        <div className="mt-3">
          <p className="text-[11px] text-ink-3">
            {result.tokens.length > 0
              ? "Matched on: " + result.tokens.join(", ")
              : result.hits.length > 0
                ? "Matched by meaning."
                : "No searchable words in that question."}
          </p>
          {result.hits.length === 0 ? (
            <p className="mt-2 text-xs text-ink-3">
              Nothing matched. Add an answer with these keywords, or publish a
              document that covers it.
            </p>
          ) : (
            <ol className="mt-2 space-y-1.5">
              {result.hits.map((hit, index) => (
                <li
                  key={hit.kind + "-" + hit.id}
                  className="rounded-xl border border-line bg-white shadow-card px-3 py-2"
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink">
                    <span className="text-ink-3">{index + 1}.</span>
                    <span className="font-medium">
                      {hit.kind === "chunk"
                        ? (hit.source || "Document") + (hit.title ? " \u203a " + hit.title : "") + " (section " + (hit.position + 1) + ")"
                        : hit.title || "Answer"}
                    </span>
                    <span className="rounded-md border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-3">
                      {hit.kind === "chunk" ? "document" : "answer"}
                    </span>
                    <span className="text-[10px] text-ink-3">
                      {hitDetail(hit)}
                    </span>
                  </p>
                  <p className="mt-1 whitespace-pre-line text-xs text-ink-2">{hit.content}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
