"use client";

import { useState, type ReactNode } from "react";
import type {
  SiteApplyResult,
  SiteEvidence,
  SitePage,
  SiteReport,
  SiteScan,
} from "../../../../lib/omniflow/portal";

const TABS = ["Overview", "Business", "Policies", "Products", "FAQs", "Pages"] as const;
type Tab = (typeof TABS)[number];

const PARTS: Record<string, string> = {
  contact: "Contact",
  policies: "Policies",
  catalog: "Catalog",
  answers: "Answers",
  technical: "Technical",
};

const PROFILE_LABELS: Record<string, string> = {
  business_name: "Business name",
  industry: "Industry",
  phone: "Phone",
  website: "Website",
  address: "Address",
  business_hours: "Business hours",
  about: "About",
  products: "Products",
  policies: "Policies",
  faqs: "FAQs",
};

const SEVERITY: Record<string, string> = {
  high: "bg-danger-soft text-danger",
  medium: "bg-warn-soft text-ink-2",
  low: "bg-soft text-ink-2",
  info: "bg-soft text-ink-3",
};

/** Scraped links are shown only when they are plain web addresses. */
function safeHref(value: string | null | undefined): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function Source({ url }: { url: string | null | undefined }) {
  const href = safeHref(url);
  if (!href) return null;
  let label = href;
  try {
    label = new URL(href).pathname || "/";
  } catch {
    /* keep the full address */
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11px] text-brand hover:underline"
    >
      {label}
    </a>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-2.5 last:border-0 sm:grid-cols-[150px_1fr]">
      <p className="text-xs text-ink-3">{label}</p>
      <div className="min-w-0 text-sm text-ink">{children}</div>
    </div>
  );
}

function Evidence({ items, empty }: { items: SiteEvidence[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index}>
          <p className="text-sm text-ink">{item.snippet || item.value}</p>
          <Source url={item.url} />
        </li>
      ))}
    </ul>
  );
}

function Check({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
    />
  );
}

function toggle<T>(set: Set<T>, value: T, on: boolean): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

export default function AnalyzerReport({
  scan,
  report,
  pages,
  canApply,
  onApplied,
}: {
  scan: SiteScan;
  report: SiteReport;
  pages: SitePage[];
  canApply: boolean;
  onApplied: () => void;
}) {
  const sug = report.suggestions;
  const [tab, setTab] = useState<Tab>("Overview");
  const [facts, setFacts] = useState(
    () => new Set(sug.facts.filter((f) => f.origin === "site").map((f) => f.key))
  );
  const [profile, setProfile] = useState(() => new Set<string>());
  const [kbPages, setKbPages] = useState(() => new Set(sug.kbPages));
  const [faqSource, setFaqSource] = useState(sug.faqSource);
  const [products, setProducts] = useState(
    () => new Set(report.catalog.items.map((_, index) => index))
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SiteApplyResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { business, policies, catalog, site, score } = report;
  const kbSet = new Set(sug.kbPages);
  const selected =
    facts.size + profile.size + kbPages.size + (faqSource ? 1 : 0) + products.size;
  const locked = !canApply || busy;

  async function apply() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/site-analyzer/" + scan.id + "/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facts: [...facts],
            profile: [...profile],
            kbPages: [...kbPages],
            faqSource,
            products: [...products],
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        result?: SiteApplyResult;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.result) {
        setResult(payload.result);
        onApplied();
      } else {
        setNote(payload?.error?.message || "Could not apply. Try again shortly.");
      }
    } catch {
      setNote("Could not apply. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-white shadow-card">
        <div className="flex flex-wrap items-end justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{business.name || site.host}</p>
            <p className="mt-0.5 text-xs text-ink-3">
              {site.host}
              {site.platform ? " · " + site.platform : ""}
              {" · " + pages.length + " pages read"}
            </p>
          </div>
          <p className="text-2xl font-semibold text-ink">
            {score.total}
            <span className="text-sm font-normal text-ink-3">/100 ready</span>
          </p>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-line px-5" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={
                "-mb-px shrink-0 border-b-2 px-2.5 py-2 text-xs " +
                (tab === name
                  ? "border-brand font-semibold text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2")
              }
            >
              {name}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === "Overview" ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-5">
                {Object.keys(PARTS).map((key) => (
                  <div key={key}>
                    <p className="text-[11px] text-ink-3">{PARTS[key]}</p>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{
                          width:
                            String(
                              Math.round(
                                ((score.parts[key] ?? 0) / Math.max(1, score.max[key] ?? 1)) * 100
                              )
                            ) + "%",
                        }}
                      />
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-2">
                      {score.parts[key] ?? 0} / {score.max[key] ?? 0}
                    </p>
                  </div>
                ))}
              </div>
              {report.ai.status === "used" && report.ai.summary ? (
                <div className="rounded-xl bg-soft p-3">
                  <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
                    AI extracted
                  </span>
                  <p className="mt-1.5 text-sm text-ink">{report.ai.summary}</p>
                  {report.ai.industry ? (
                    <p className="mt-0.5 text-[11px] text-ink-3">Industry: {report.ai.industry}</p>
                  ) : null}
                </div>
              ) : null}
              {report.ai.status === "failed" ? (
                <p className="text-[11px] text-ink-3">
                  The AI reading did not finish this time; everything below comes from your pages.
                </p>
              ) : null}
              <div>
                <h4 className="text-xs font-semibold text-ink">What to fix</h4>
                {report.issues.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No issues found.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {report.issues.map((issue) => (
                      <li key={issue.code} className="rounded-xl border border-line px-3 py-2">
                        <div className="flex items-start gap-2">
                          <span
                            className={
                              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] " +
                              (SEVERITY[issue.severity] ?? SEVERITY.info)
                            }
                          >
                            {issue.severity}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm text-ink">{issue.title}</p>
                            <p className="text-[11px] text-ink-3">{issue.fix}</p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          {tab === "Business" ? (
            <div>
              <Row label="Name">{business.name || "-"}</Row>
              <Row label="About">
                {business.about ? <p>{business.about}</p> : <p className="text-ink-3">Not found</p>}
              </Row>
              {(["phones", "whatsapp", "emails"] as const).map((key) => (
                <Row key={key} label={key === "phones" ? "Phone" : key === "emails" ? "Email" : "WhatsApp"}>
                  {business[key].length === 0 ? (
                    <p className="text-ink-3">Not found</p>
                  ) : (
                    business[key].map((item) => (
                      <p key={item.value}>
                        {item.value} <Source url={item.url} />
                      </p>
                    ))
                  )}
                </Row>
              ))}
              <Row label="Address">
                {business.address ? (
                  <p>
                    {business.address.value} <Source url={business.address.url} />
                  </p>
                ) : (
                  <p className="text-ink-3">Not found</p>
                )}
              </Row>
              <Row label="Hours">
                <Evidence items={business.hours} empty="Not found" />
              </Row>
              <Row label="Social">
                {Object.keys(business.socials).length === 0 ? (
                  <p className="text-ink-3">Not found</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(business.socials).map(([network, link]) => (
                      <a
                        key={network}
                        href={safeHref(link)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-line px-2 py-0.5 text-xs capitalize text-ink-2 hover:bg-line/60"
                      >
                        {network}
                      </a>
                    ))}
                  </div>
                )}
              </Row>
            </div>
          ) : null}

          {tab === "Policies" ? (
            <div>
              <Row label="Delivery time">
                <Evidence items={policies.shipping.delivery} empty="Not stated" />
              </Row>
              <Row label="Delivery charges">
                <Evidence
                  items={[...policies.shipping.fee, ...policies.shipping.free]}
                  empty="Not stated"
                />
              </Row>
              <Row label="Returns">
                <Evidence items={policies.returns.window} empty="Not stated" />
              </Row>
              <Row label="Payment methods">
                {policies.payments.methods.length === 0 ? (
                  <p className="text-ink-3">Not stated</p>
                ) : (
                  <p>{policies.payments.methods.join(", ")}</p>
                )}
              </Row>
              <Row label="Policy pages">
                <div className="flex flex-wrap gap-3">
                  {[
                    ["Shipping", policies.shipping.url],
                    ["Returns", policies.returns.url],
                    ["Payments", policies.payments.url],
                    ["Privacy", policies.privacyUrl],
                    ["Terms", policies.termsUrl],
                  ].map(([name, link]) =>
                    safeHref(link) ? (
                      <a
                        key={name}
                        href={safeHref(link)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-brand hover:underline"
                      >
                        {name}
                      </a>
                    ) : (
                      <span key={name} className="text-xs text-ink-3">
                        {name}: missing
                      </span>
                    )
                  )}
                </div>
              </Row>
            </div>
          ) : null}

          {tab === "Products" ? (
            catalog.items.length === 0 ? (
              <p className="text-sm text-ink-3">
                {catalog.store
                  ? "Product pages were found but no names or prices could be read."
                  : "No products found on this site."}
              </p>
            ) : (
              <div>
                <p className="mb-2 text-[11px] text-ink-3">
                  {catalog.count} products from{" "}
                  {catalog.source === "pages" ? "product pages" : "the " + catalog.source + " storefront"}
                  {catalog.priceMin !== null
                    ? " · " + catalog.currency + " " + catalog.priceMin + " - " + catalog.priceMax
                    : ""}
                  . Selected items are added to your catalog; existing ones are left as they are.
                </p>
                <ul className="divide-y divide-line">
                  {catalog.items.map((item, index) => (
                    <li key={item.externalId || index} className="flex items-start gap-2.5 py-2">
                      <Check
                        checked={products.has(index)}
                        disabled={locked}
                        label={"Add " + item.name}
                        onChange={(on) => setProducts(toggle(products, index, on))}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink">{item.name}</p>
                        <p className="text-[11px] text-ink-3">
                          {item.priceText || "No price"}
                          {item.category ? " · " + item.category : ""}
                          {item.available === false ? " · out of stock" : ""}
                        </p>
                      </div>
                      <Source url={item.url} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          {tab === "FAQs" ? (
            report.faqs.length === 0 ? (
              <p className="text-sm text-ink-3">No FAQs found on this site.</p>
            ) : (
              <ul className="space-y-2">
                {report.faqs.map((faq) => (
                  <li key={faq.q} className="rounded-xl border border-line px-3 py-2">
                    <p className="text-sm font-medium text-ink">{faq.q}</p>
                    <p className="mt-0.5 text-sm text-ink-2">{faq.a}</p>
                    <Source url={faq.url} />
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {tab === "Pages" ? (
            <ul className="divide-y divide-line">
              {pages.map((page) => (
                <li key={page.id} className="flex items-start gap-2.5 py-2">
                  {kbSet.has(page.id) ? (
                    <Check
                      checked={kbPages.has(page.id)}
                      disabled={locked}
                      label={"Add " + page.url + " to knowledge"}
                      onChange={(on) => setKbPages(toggle(kbPages, page.id, on))}
                    />
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{page.title || page.url}</p>
                    <p className="truncate text-[11px] text-ink-3">
                      {page.kind}
                      {page.status ? " · " + page.status : ""}
                      {page.words ? " · " + page.words + " words" : ""}
                      {page.loadMs ? " · " + page.loadMs + " ms" : ""}
                    </p>
                    {page.error ? <p className="text-[11px] text-danger">{page.error}</p> : null}
                  </div>
                  <Source url={page.url} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Apply to your assistant</h3>
        <p className="mt-0.5 text-xs text-ink-3">
          Knowledge pages and FAQs are added as drafts - review and publish them in the
          Knowledge base before the assistant uses them. A configuration snapshot is taken
          first, so you can undo from{" "}
          <a href="/dashboard/settings#config-history" className="text-brand hover:underline">
            Configuration history
          </a>
          .
        </p>

        {sug.facts.length > 0 ? (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-ink">Business facts the assistant can quote</h4>
            <ul className="mt-2 space-y-1.5">
              {sug.facts.map((fact) => (
                <li key={fact.key} className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2">
                  <Check
                    checked={facts.has(fact.key)}
                    disabled={locked}
                    label={"Apply " + fact.label}
                    onChange={(on) => setFacts(toggle(facts, fact.key, on))}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">
                      {fact.label}
                      {fact.origin === "ai" ? (
                        <span className="ml-2 rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
                          AI extracted
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-3">{fact.content}</p>
                    <Source url={fact.url} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {Object.keys(sug.profile).length > 0 ? (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-ink">Business profile fields</h4>
            <p className="text-[11px] text-ink-3">A selected field replaces its current value.</p>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {Object.entries(sug.profile).map(([field, value]) => (
                <li key={field} className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2">
                  <Check
                    checked={profile.has(field)}
                    disabled={locked}
                    label={"Apply " + (PROFILE_LABELS[field] ?? field)}
                    onChange={(on) => setProfile(toggle(profile, field, on))}
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{PROFILE_LABELS[field] ?? field}</p>
                    <p className="line-clamp-2 text-[11px] text-ink-3">{value}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4 space-y-1.5 text-sm text-ink">
          {sug.kbPages.length > 0 ? (
            <p>
              {kbPages.size} of {sug.kbPages.length} policy and info pages as knowledge drafts{" "}
              <button onClick={() => setTab("Pages")} className="text-xs text-brand hover:underline">
                choose
              </button>
            </p>
          ) : null}
          {catalog.items.length > 0 ? (
            <p>
              {products.size} of {catalog.items.length} products to the catalog{" "}
              <button onClick={() => setTab("Products")} className="text-xs text-brand hover:underline">
                choose
              </button>
            </p>
          ) : null}
          {sug.faqSource ? (
            <label className="flex items-start gap-2.5">
              <Check
                checked={faqSource}
                disabled={locked}
                label="Add FAQs as a knowledge draft"
                onChange={setFaqSource}
              />
              <span>{report.faqs.length} FAQs as one knowledge draft</span>
            </label>
          ) : null}
        </div>

        {result ? (
          <div className="mt-4 rounded-xl bg-ok-soft p-3 text-sm text-ink">
            <p>
              Added {result.facts} facts, {result.knowledge} knowledge drafts and {result.catalog}{" "}
              catalog items
              {result.profile.length > 0
                ? "; updated " + result.profile.map((f) => PROFILE_LABELS[f] ?? f).join(", ")
                : ""}
              .
            </p>
            {result.skipped.length > 0 ? (
              <p className="mt-0.5 text-[11px] text-ink-3">
                Skipped {result.skipped.length} already present:{" "}
                {result.skipped.slice(0, 6).map((s) => s.item).join(", ")}
                {result.skipped.length > 6 ? "..." : ""}
              </p>
            ) : null}
            {result.knowledge > 0 ? (
              <a href="/dashboard/knowledge-base" className="mt-1 inline-block text-xs text-brand hover:underline">
                Review drafts in the Knowledge base
              </a>
            ) : null}
          </div>
        ) : null}
        {note ? <p className="mt-3 text-xs text-danger">{note}</p> : null}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void apply()}
            disabled={locked || selected === 0}
            className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Applying..." : "Apply selected"}
          </button>
          {!canApply ? (
            <p className="text-[11px] text-ink-3">Your role can view this report but not apply it.</p>
          ) : null}
          {scan.applied.length > 0 ? (
            <p className="text-[11px] text-ink-3">Applied {scan.applied.length} time(s) from this scan.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
