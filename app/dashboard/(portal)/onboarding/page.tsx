"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePortalEntitlements } from "../../components/usePortalEntitlements";

interface PackPersona {
  agent_name: string;
  tone: string;
  greeting: string;
  fallback: string;
}

interface Pack {
  key: string;
  label: string;
  description: string;
  persona: PackPersona;
  kb: {
    title: string;
    category: string;
    keywords: string;
    content: string;
    lang: string;
  }[];
  keywords: { keyword: string; note: string }[];
  saved_replies: { shortcut: string; body: string }[];
  journey: string[];
  workflows?: {
    key: string;
    name: string;
    description: string;
    trigger_type: string;
  }[];
}

const CUSTOM_INDUSTRY_PRESETS = [
  {
    label: "Electronics & Appliances",
    industry: "Electronics & Home Appliances",
    products: "LED TVs, Washing Machines, Refrigerators, Air Conditioners, Kitchen Appliances",
    greeting:
      "Assalam-o-Alaikum! Welcome to our Electronics & Appliances WhatsApp Desk. Ask about model availability, warranty, or prices.",
    keywords: [
      {
        keyword: "price, rate, कीमत, kitne",
        response:
          "Please share the model name or size (e.g., 55-inch LED TV or 8kg Washing Machine) so we can share the latest price and warranty details.",
      },
      {
        keyword: "warranty, guarantee, claim",
        response:
          "All our branded appliances come with official company warranty. Share your invoice or model number for warranty assistance.",
      },
      {
        keyword: "delivery, shipping, installation",
        response:
          "Same-day and next-day safe delivery is available. Let us know your city/area for delivery charges.",
      },
    ],
  },
  {
    label: "Travel & Visa Agency",
    industry: "Travel, Umrah & Visa Consultancy",
    products: "Umrah Packages, Visit Visas, International Flights, Hotel Bookings, Tour Packages",
    greeting:
      "Assalam-o-Alaikum! Welcome to our Travel & Visa Desk. Let us know which destination, Umrah package, or visa service you need.",
    keywords: [
      {
        keyword: "umrah, package, makkah",
        response:
          "We offer Economy, Star, and Executive Umrah packages (14, 21, and 28 days). How many travelers are in your family?",
      },
      {
        keyword: "visa, documents, requirement",
        response:
          "Please share the country name you want to apply for so we can send the complete document checklist and visa fee.",
      },
    ],
  },
  {
    label: "Auto Workshop & Parts",
    industry: "Automobile Service, Detailing & Spare Parts",
    products: "Periodic Maintenance, Oil Change, Ceramic Coating, Genuine Spare Parts, Diagnostics",
    greeting:
      "Welcome to our Auto Service & Parts Desk! Share your car make/model to check part availability or book a service bay.",
    keywords: [
      {
        keyword: "booking, service, tuning, oil",
        response:
          "Please share your vehicle model and preferred time slot to reserve your service bay.",
      },
      {
        keyword: "part, price, available",
        response:
          "Please share your car make, model year, and the required part name for instant stock and price confirmation.",
      },
    ],
  },
  {
    label: "Wholesale & Distribution",
    industry: "B2B Wholesale & Supply Distribution",
    products: "Bulk Orders, Dealer Rates, Carton Supply, Nationwide Dispatch",
    greeting:
      "Assalam-o-Alaikum! Welcome to our Wholesale Order Desk. Share your shop/company name and required items for bulk rates.",
    keywords: [
      {
        keyword: "bulk, wholesale, rate, dealer",
        response:
          "For wholesale price lists and MOQ details, please share your business name, city, and required product quantity.",
      },
    ],
  },
];

export default function OnboardingPage() {
  const { hasFeature } = usePortalEntitlements();
  const canUseKb = hasFeature("content.knowledge_base");
  const canUsePipeline = hasFeature("sales.pipeline");
  const canUseWorkflows = hasFeature("automation.workflows");

  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [applied, setApplied] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Custom Business Type Studio state
  const [customBusinessName, setCustomBusinessName] = useState("Ahmed Electronics");
  const [customIndustry, setCustomIndustry] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customProducts, setCustomProducts] = useState("");
  const [customAgentName, setCustomAgentName] = useState("Ayesha");
  const [customTone, setCustomTone] = useState<"friendly" | "professional" | "concise">("friendly");
  const [customGreeting, setCustomGreeting] = useState(
    "Assalam-o-Alaikum! Welcome to our WhatsApp support desk. How can we help you today?"
  );
  const [customKeywords, setCustomKeywords] = useState<
    { keyword: string; response: string }[]
  >([
    {
      keyword: "price, rate, cost, kitne",
      response:
        "Please share the product or service name you are interested in so we can provide the exact pricing.",
    },
    {
      keyword: "delivery, timing, location, hours",
      response:
        "We are available Monday to Saturday, 9:00 AM to 9:00 PM. Share your location for delivery or visit details.",
    },
  ]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/templates", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          packs?: Pack[];
          applied?: string;
        };
        setPacks(payload.packs ?? []);
        setApplied(payload.applied ?? "");
      } else {
        setPacks([]);
      }
    } catch {
      setPacks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function applyTemplate(key: string) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/templates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vertical: key }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            created?: Record<string, number>;
            error?: { message?: string };
          }
        | null;
      if (response.ok && payload?.created) {
        setApplied(key);
        setNote(
          "Template activated successfully — AI persona, saved replies, and keyword rules have been configured for your workspace."
        );
      } else {
        setNote(payload?.error?.message ?? "Could not activate template.");
      }
    } catch {
      setNote("Could not activate template.");
    } finally {
      setBusy(false);
    }
  }

  async function applyCustomBusiness() {
    if (!customIndustry.trim() || !customBusinessName.trim()) {
      setNote("Please enter both your Business Name and Business Type / Industry.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/templates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vertical: "custom",
          custom: {
            businessName: customBusinessName.trim(),
            industryName: customIndustry.trim(),
            description:
              customDescription.trim() ||
              `${customIndustry.trim()} customer support and WhatsApp automation desk.`,
            products: customProducts.trim(),
            agentName: customAgentName.trim() || "Ayesha",
            tone: customTone,
            greeting: customGreeting.trim(),
            keywords: customKeywords,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setApplied("custom");
        setNote(
          `Custom business setup for "${customBusinessName.trim()}" (${customIndustry.trim()}) activated! Your Business Profile, AI Assistant, and Keyword Rules are now live.`
        );
      } else {
        setNote(payload?.error?.message || "Could not save custom business setup.");
      }
    } catch {
      setNote("Network error while activating custom business setup.");
    } finally {
      setBusy(false);
    }
  }

  function autoGenerateSmartTemplate() {
    const ind = customIndustry.trim() || "General Business";
    const bName = customBusinessName.trim() || "Our Business";
    setCustomGreeting(
      `Assalam-o-Alaikum! Welcome to ${bName} (${ind}). Feel free to ask about our products, rates, availability, or support.`
    );
    if (!customDescription.trim()) {
      setCustomDescription(
        `Official WhatsApp customer service and inquiry desk for ${bName} specializing in ${ind}.`
      );
    }
    setCustomKeywords([
      {
        keyword: "price, rate, cost, quotation, kitne",
        response: `Thank you for contacting ${bName}! Please share the exact item or service you need so we can send our latest rates.`,
      },
      {
        keyword: "available, stock, catalog, details",
        response: `Yes! At ${bName}, we offer a full range of ${customProducts.trim() || ind + " solutions"}. Tell us your requirement and our team will assist you.`,
      },
      {
        keyword: "location, address, timing, hours",
        response: `${bName} is available Monday to Saturday, 09:00 AM to 09:00 PM. Reply with "agent" anytime if you wish to speak with a team member.`,
      },
    ]);
  }

  const active =
    selected && selected !== "custom"
      ? (packs ?? []).find((pack) => pack.key === selected) ?? null
      : null;

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-ink">
      <div className="mx-auto max-w-5xl">
        <p className="text-[11px] font-medium uppercase tracking-widest text-brand">
          Workspace
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
          Setup wizard
        </h1>
        <p className="mt-1 max-w-2xl text-xs text-ink-3">
          Choose a ready-made industry template or create your own custom business type — the wizard configures your AI assistant persona, welcome greeting, and automated keyword rules in one click.
        </p>

        {packs === null ? (
          <p className="mt-6 text-xs text-ink-3">Loading business templates...</p>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((pack) => {
              const isSelected = pack.key === selected;
              const isApplied = pack.key === applied;
              return (
                <button
                  key={pack.key}
                  type="button"
                  onClick={() => setSelected(pack.key)}
                  className={
                    "rounded-2xl border p-4 text-left transition-all duration-200 shadow-card " +
                    (isSelected
                      ? "border-brand/40 bg-brand/[0.04] ring-1 ring-brand/20"
                      : "border-line bg-white hover:border-brand/25 hover:shadow-md")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {pack.label}
                    </span>
                    {isApplied ? (
                      <span className="rounded-full border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[10px] font-semibold text-ok">
                        Active
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                    {pack.description}
                  </p>
                </button>
              );
            })}

            {/* Create Your Own Custom Business Type Card */}
            <button
              type="button"
              onClick={() => setSelected("custom")}
              className={
                "rounded-2xl border-2 border-dashed p-4 text-left transition-all duration-200 " +
                (selected === "custom"
                  ? "border-brand bg-brand/[0.05] shadow-md"
                  : "border-brand/35 bg-brand/[0.02] hover:border-brand hover:bg-brand/[0.04]")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
                    +
                  </span>
                  Create Your Own Business Type
                </span>
                {applied === "custom" ? (
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[10px] font-semibold text-ok">
                    Active
                  </span>
                ) : (
                  <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand">
                    Custom
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                Don&apos;t see your industry above? Build a custom WhatsApp automation setup for Electronics, Travel, Auto, Wholesale, or any business.
              </p>
            </button>
          </div>
        )}

        {/* CUSTOM BUSINESS TYPE STUDIO */}
        {selected === "custom" && (
          <section className="mt-6 rounded-2xl border border-brand/25 bg-white p-6 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
              <div>
                <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                  Custom Business Builder
                </span>
                <h2 className="mt-1.5 text-base font-semibold text-ink">
                  Create Your Custom Business Setup
                </h2>
                <p className="mt-0.5 text-xs text-ink-3">
                  Define your business category, products, greeting, and custom keyword triggers. Everything syncs directly to your Business Profile, AI Agent, and Rules.
                </p>
              </div>
              <button
                type="button"
                onClick={autoGenerateSmartTemplate}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-brand/30 bg-brand-soft px-3.5 text-xs font-semibold text-brand transition-colors hover:bg-brand/15"
              >
                <span>✨ Auto-Generate Smart Rules</span>
              </button>
            </div>

            {/* Quick Industry Preset Chips */}
            <div className="mt-4">
              <p className="text-[11px] font-medium text-ink-3">
                Quick-fill from popular custom industries (optional):
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {CUSTOM_INDUSTRY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setCustomIndustry(preset.industry);
                      setCustomProducts(preset.products);
                      setCustomGreeting(preset.greeting);
                      setCustomKeywords(preset.keywords);
                    }}
                    className="rounded-xl border border-line bg-soft px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-brand/35 hover:bg-brand-soft hover:text-brand"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-ink-2">
                Business Name *
                <input
                  value={customBusinessName}
                  onChange={(e) => setCustomBusinessName(e.target.value)}
                  placeholder="e.g., Ahmed Electronics / Star Travel Agency"
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                />
              </label>

              <label className="block text-xs font-medium text-ink-2">
                Custom Business Type / Industry *
                <input
                  value={customIndustry}
                  onChange={(e) => setCustomIndustry(e.target.value)}
                  placeholder="e.g., Electronics Store, Logistics, Gym, Pharmacy, Consultancy"
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                />
              </label>

              <label className="block text-xs font-medium text-ink-2 sm:col-span-2">
                Products or Services Offered
                <input
                  value={customProducts}
                  onChange={(e) => setCustomProducts(e.target.value)}
                  placeholder="e.g., LED TVs, Washing Machines, Refrigerators, Home Delivery & Warranty Support"
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                />
              </label>

              <label className="block text-xs font-medium text-ink-2">
                AI Assistant Name
                <input
                  value={customAgentName}
                  onChange={(e) => setCustomAgentName(e.target.value)}
                  placeholder="e.g., Ayesha / Support Desk"
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                />
              </label>

              <label className="block text-xs font-medium text-ink-2">
                Assistant Conversation Tone
                <select
                  value={customTone}
                  onChange={(e) =>
                    setCustomTone(
                      e.target.value as "friendly" | "professional" | "concise"
                    )
                  }
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                >
                  <option value="friendly">Friendly & Helpful</option>
                  <option value="professional">Professional & Formal</option>
                  <option value="concise">Short & Direct</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-ink-2 sm:col-span-2">
                Welcome Greeting (Sent on Customer&apos;s First Message)
                <textarea
                  rows={2}
                  value={customGreeting}
                  onChange={(e) => setCustomGreeting(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink outline-none focus:border-brand focus:bg-white"
                />
              </label>
            </div>

            {/* Custom Keyword Rules Builder */}
            <div className="mt-5 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-semibold text-ink">
                    Custom Keyword Auto-Reply Rules
                  </h3>
                  <p className="text-[11px] text-ink-3">
                    Instant replies triggered when customers mention specific keywords.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setCustomKeywords((prev) => [
                      ...prev,
                      { keyword: "", response: "" },
                    ])
                  }
                  className="rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/15"
                >
                  + Add Keyword Rule
                </button>
              </div>

              <div className="mt-3 space-y-2.5">
                {customKeywords.map((item, idx) => (
                  <div
                    key={idx}
                    className="grid gap-2.5 rounded-xl border border-line bg-soft/60 p-3 sm:grid-cols-12"
                  >
                    <div className="sm:col-span-4">
                      <label className="block text-[10px] font-medium uppercase tracking-wider text-ink-3">
                        Keywords (comma-separated)
                      </label>
                      <input
                        value={item.keyword}
                        onChange={(e) =>
                          setCustomKeywords((prev) =>
                            prev.map((row, i) =>
                              i === idx ? { ...row, keyword: e.target.value } : row
                            )
                          )
                        }
                        placeholder="e.g., warranty, claim"
                        className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink"
                      />
                    </div>
                    <div className="sm:col-span-7">
                      <label className="block text-[10px] font-medium uppercase tracking-wider text-ink-3">
                        Automated Reply
                      </label>
                      <input
                        value={item.response}
                        onChange={(e) =>
                          setCustomKeywords((prev) =>
                            prev.map((row, i) =>
                              i === idx ? { ...row, response: e.target.value } : row
                            )
                          )
                        }
                        placeholder="Automated response message..."
                        className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink"
                      />
                    </div>
                    <div className="flex items-end justify-end sm:col-span-1">
                      <button
                        type="button"
                        onClick={() =>
                          setCustomKeywords((prev) =>
                            prev.filter((_, i) => i !== idx)
                          )
                        }
                        className="rounded-lg px-2 py-1.5 text-xs font-medium text-danger hover:bg-red-50"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyCustomBusiness()}
                className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-brand-2 disabled:opacity-50"
              >
                {busy
                  ? "Activating Custom Setup..."
                  : "Activate Custom Business Setup"}
              </button>
            </div>
          </section>
        )}

        {/* PRESET INDUSTRY TEMPLATE PREVIEW */}
        {active ? (
          <section className="mt-6 rounded-2xl border border-line bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  {active.label}
                </h2>
                <p className="text-[11px] text-ink-3">
                  Preview of what will be configured in your workspace.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyTemplate(active.key)}
                className="rounded-xl bg-brand inline-flex min-h-9 items-center px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-40"
              >
                {busy
                  ? "Activating..."
                  : applied === active.key
                    ? "Re-apply Template"
                    : "Activate This Template"}
              </button>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Assistant Persona
                </p>
                <p className="mt-1 text-xs font-medium text-ink">
                  {active.persona.agent_name} · {active.persona.tone}
                </p>
                <p className="mt-1.5 rounded-xl border border-line bg-soft px-3 py-2 text-xs italic text-ink-2">
                  &ldquo;{active.persona.greeting}&rdquo;
                </p>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Keyword Alerts
                </p>
                <ul className="mt-1 space-y-1">
                  {active.keywords.map((rule) => (
                    <li key={rule.keyword} className="text-xs text-ink-2">
                      <span className="font-medium text-brand">
                        {rule.keyword}
                      </span>{" "}
                      — {rule.note}
                    </li>
                  ))}
                </ul>
                {canUsePipeline && (
                  <>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      Journey Stages
                    </p>
                    <p className="mt-1 text-xs text-ink-3">
                      {active.journey.join(" → ")}
                    </p>
                  </>
                )}
              </div>
              <div>
                {canUseKb && (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      Knowledge-base Entries
                    </p>
                    <ul className="mt-1 space-y-1.5">
                      {active.kb.map((entry) => (
                        <li
                          key={entry.title}
                          className="rounded-xl border border-line bg-soft px-3 py-2"
                        >
                          <p className="text-xs font-medium text-ink">
                            {entry.title}
                            <span className="ml-2 text-[10px] text-ink-3">
                              {entry.category}
                            </span>
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-3">
                            {entry.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p
                  className={
                    (canUseKb ? "mt-3 " : "") +
                    "text-[10px] font-semibold uppercase tracking-wider text-ink-3"
                  }
                >
                  Quick Replies
                </p>
                <ul className="mt-1 space-y-1">
                  {active.saved_replies.map((reply) => (
                    <li key={reply.shortcut} className="text-xs text-ink-2">
                      <span className="font-medium text-brand">
                        {reply.shortcut}
                      </span>{" "}
                      — {reply.body}
                    </li>
                  ))}
                </ul>
                {canUseWorkflows &&
                active.workflows &&
                active.workflows.length ? (
                  <>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      Workflow Drafts ({active.workflows.length})
                    </p>
                    <ul className="mt-1 space-y-1">
                      {active.workflows.map((flow) => (
                        <li key={flow.key} className="text-xs text-ink-2">
                          <span className="font-medium text-ink">
                            {flow.name}
                          </span>{" "}
                          — {flow.description}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {note ? (
          <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 text-xs font-medium text-emerald-800">
            {note}
          </div>
        ) : null}

        {applied ? (
          <p className="mt-4 text-xs text-ink-3">
            Next steps:{" "}
            <Link href="/dashboard/profile" className="font-medium text-brand hover:underline">
              Review Business Profile
            </Link>
            {" · "}
            <Link href="/dashboard/bot" className="font-medium text-brand hover:underline">
              Configure AI Assistant
            </Link>
            {" · "}
            <Link href="/dashboard/rules" className="font-medium text-brand hover:underline">
              Manage Automation Rules
            </Link>
            {" · "}
            <Link
              href="/dashboard/saved-replies"
              className="font-medium text-brand hover:underline"
            >
              Quick Replies
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
