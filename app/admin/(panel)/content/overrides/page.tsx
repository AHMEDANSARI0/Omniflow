import Link from "next/link";
import { overrideRow, type OverrideRow } from "../../../../../lib/marketing/overrides";
import { createClient } from "../../../../../lib/supabase/server";
import { resetOverrideField, resetOverrideRow, tidyOverrides } from "./actions";
import ConfirmButton from "./ConfirmButton";

const DONE: Record<string, { ok: boolean; text: string }> = {
  field: { ok: true, text: "Done - that field shows the default again." },
  row: { ok: true, text: "Done - that block shows the defaults again." },
  tidy: { ok: true, text: "Tidied - nothing on the website changed; code updates reach those fields again." },
  failed: { ok: false, text: "Could not save. Please try again." },
  denied: { ok: false, text: "Only admins can change website content." },
  unknown: { ok: false, text: "That field is not part of the website content any more." },
};

const KIND_TITLE: Record<OverrideRow["kind"], string> = {
  section: "Website sections",
  copy: "Page copy & product mockups",
  list: "Lists",
};

const SMALL_BUTTON =
  "rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-danger/40 hover:text-danger";

/**
 * §256: every CMS value that still overrides the code defaults, side by
 * side with the default, so stale copy (an old hero headline, an old bot
 * line) can be handed back to the defaults field by field.
 */
export default async function ContentOverridesPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.from("site_content").select("section, data");
  const rows = (data ?? [])
    .map((row) => overrideRow(String(row.section ?? ""), row.data))
    .filter((row): row is OverrideRow => row !== null);
  const changed = rows.filter((row) => row.fields.length);
  const tidyCount = rows.filter((row) => row.tidy).length;
  const message = done ? DONE[done] : undefined;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <Link href="/admin/content" className="text-xs text-ink-3 transition-colors hover:text-ink-2">
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Overrides</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Text saved in the CMS replaces the built-in default, even after the default is updated. Review what is
          still overridden and hand fields back to the default.
        </p>
      </div>

      {message ? (
        <p role="status" className={"mb-6 text-xs " + (message.ok ? "text-ok" : "text-danger")}>
          {message.text}
        </p>
      ) : null}
      {error ? <p className="mb-6 text-xs text-danger">Could not read the website content.</p> : null}

      {tidyCount ? (
        <form action={tidyOverrides} className="mb-8 rounded-2xl border border-line bg-white p-5 shadow-card">
          <p className="text-sm font-semibold text-ink">Tidy saved content</p>
          <p className="mt-1 text-xs text-ink-3">
            {tidyCount} block{tidyCount === 1 ? " stores" : "s store"} values that equal today&apos;s default. They
            look the same now but would block future copy updates. Tidying removes only those values - the website
            does not change.
          </p>
          <button
            type="submit"
            className="mt-3 rounded-xl border border-line bg-white px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:border-brand/30 hover:text-brand"
          >
            Tidy now
          </button>
        </form>
      ) : null}

      {!error && !changed.length ? (
        <p className="rounded-2xl border border-line bg-white p-5 text-sm text-ink-3 shadow-card">
          Nothing is overridden - the website shows the built-in defaults everywhere.
        </p>
      ) : null}

      <div className="space-y-10">
        {(["section", "copy", "list"] as const).map((kind) => {
          const group = changed.filter((row) => row.kind === kind);
          if (!group.length) return null;
          return (
            <section key={kind}>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ink-2">{KIND_TITLE[kind]}</h2>
              <div className="space-y-4">
                {group.map((row) => (
                  <div key={row.section} className="rounded-2xl border border-line bg-white p-5 shadow-card">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-ink">{row.title}</h3>
                        <p className="text-xs text-ink-3">
                          {row.fields.length} overridden {row.fields.length === 1 ? "value" : "values"} ·{" "}
                          <Link href={row.href} className="text-brand hover:underline">
                            Open editor
                          </Link>
                        </p>
                      </div>
                      <form action={resetOverrideRow}>
                        <input type="hidden" name="section" value={row.section} />
                        <ConfirmButton
                          label={row.kind === "list" ? "Reset list" : "Reset block"}
                          prompt={`Show the built-in defaults for "${row.title}" again? Your saved text for it is removed.`}
                          className={SMALL_BUTTON}
                        />
                      </form>
                    </div>
                    <ul className="mt-4 divide-y divide-line">
                      {row.fields.map((field) => (
                        <li key={field.path} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-start">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-ink">{field.label}</p>
                            <p className="mt-1 break-words text-xs text-ink-2">
                              <span className="text-ink-3">Website shows: </span>
                              {field.stored || "(empty)"}
                            </p>
                            <p className="mt-0.5 break-words text-xs text-ink-3">Default: {field.fallback || "(empty)"}</p>
                          </div>
                          {field.resettable ? (
                            <form action={resetOverrideField} className="sm:self-center">
                              <input type="hidden" name="section" value={row.section} />
                              <input type="hidden" name="path" value={field.path} />
                              <button type="submit" className={SMALL_BUTTON}>
                                Use default
                              </button>
                            </form>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
