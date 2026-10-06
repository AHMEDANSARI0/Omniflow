"use client";

import { useCallback, useEffect, useState } from "react";
import RuleConflicts from "./RuleConflicts";
import PortalIcon, { type IconName } from "../../components/PortalIcon";

interface PolicyFamily {
  ruleSet: string;
  label: string;
  href: string;
  count: number;
  summary: string;
}

const RULE_SET_ICONS: Record<string, IconName> = {
  routing: "split",
  listen: "listen",
  negotiation: "percent",
  hours: "clock",
  handoff: "handoff",
  autonomy: "sparkles",
  approvals: "approvals",
  workflows: "workflows",
};

export default function RulesPage() {
  const [families, setFamilies] = useState<PolicyFamily[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  // dry-run tester
  const [testText, setTestText] = useState("");
  const [testRules, setTestRules] = useState(
    JSON.stringify(
      {
        all: [
          { field: "keyword", op: "contains", value: "refund" },
          { field: "sentiment", op: "is", value: "negative" },
        ],
      },
      null,
      2
    )
  );
  const [testResult, setTestResult] = useState<null | boolean>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/policy/rules", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          families?: PolicyFamily[];
        };
        setFamilies(payload.families ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      let rules: unknown;
      try {
        rules = JSON.parse(testRules);
      } catch {
        setTestError("JSON theek karein.");
        setTesting(false);
        return;
      }
      const response = await fetch("/api/omniflow/portal/policy/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules,
          context: {
            text: testText,
            sentiment: "negative",
            intent: "general",
            in_hours: true,
          },
        }),
      });
      if (response.ok) {
        const payload = (await response.json()) as { matched?: boolean };
        setTestResult(payload.matched === true);
      } else {
        setTestError("Test nahi chala — dobara karein.");
      }
    } catch {
      setTestError("Network masla — dobara karein.");
    } finally {
      setTesting(false);
    }
  }

  const activeCount = (families ?? []).filter((item) => item.count > 0).length;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Rules
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          Aapke workspace ki saari business rules ek jagah — routing,
          listening, negotiation limits, business hours, AI autonomy aur
          high-risk approval gate. Click karke us rule ke page par jayen.
        </p>
        {families !== null ? (
          <p className="mt-2 text-xs text-ink-3">
            {activeCount} of {families.length} rule groups active
          </p>
        ) : null}
      </div>

      <RuleConflicts />

      {families === null && !loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-3 shadow-card">
          Load ho raha hai...
        </div>
      ) : null}
      {loadError ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center text-sm text-ink-2 shadow-card">
          Rules load nahi hui — refresh karke dobara koshish karein.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(families ?? []).map((family) => {
          const active = family.count > 0;
          return (
            <a
              key={family.ruleSet}
              href={family.href}
              className={
                "block rounded-xl2 border bg-white p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover " +
                (active ? "border-line" : "border-line-2 bg-soft")
              }
            >
              <div className="flex items-center justify-between">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-brand/25 bg-brand-soft text-sm font-semibold text-brand">
                  <PortalIcon name={RULE_SET_ICONS[family.ruleSet] || "rules"} />
                </span>
                <span
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold " +
                    (active
                      ? "border-ok/30 bg-ok-soft text-ok"
                      : "border-line-2 bg-white text-ink-3")
                  }
                >
                  {active ? "Active" : "Inactive"}
                </span>
              </div>
              <p className="mt-3.5 text-sm font-semibold text-ink">
                {family.label}
              </p>
              <p className="mt-1 min-h-[36px] text-xs leading-relaxed text-ink-2">
                {family.summary}
              </p>
              <p className="mt-2 text-[11px] font-medium text-ink-3">
                {family.count > 0
                  ? family.count +
                    (family.count === 1 ? " rule" : " rules")
                  : "—"}
              </p>
            </a>
          );
        })}
      </div>

      {/* dry-run tester */}
      <div className="mt-10 rounded-xl2 border border-line bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Rule tester</h2>
        <p className="mt-1 text-xs text-ink-3">
          Naye rule ka idea yahan test karein — kuch bhi save nahi hota.
          Example: customer ka message aur rule JSON — result batata hai ke
          rule match karega ya nahi.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="test_text" className="mb-1.5 block text-xs font-medium text-ink-3">
              Customer message (sample)
            </label>
            <textarea
              id="test_text"
              rows={4}
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              placeholder="Mera order kharab aya hai, refund chahiye"
              className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink placeholder-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
            />
          </div>
          <div>
            <label htmlFor="test_rules" className="mb-1.5 block text-xs font-medium text-ink-3">
              Rule JSON
            </label>
            <textarea
              id="test_rules"
              rows={4}
              value={testRules}
              onChange={(event) => setTestRules(event.target.value)}
              className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 font-mono text-[12.5px] text-ink outline-none transition-colors duration-300 focus:border-brand/40"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test rule"}
          </button>
          {testResult !== null ? (
            <span
              className={
                "rounded-full border px-3 py-1 text-xs font-semibold " +
                (testResult
                  ? "border-ok/30 bg-ok-soft text-ok"
                  : "border-line-2 bg-soft text-ink-3")
              }
            >
              {testResult ? "MATCHED — rule fire hoga" : "NOT MATCHED"}
            </span>
          ) : null}
          {testError ? (
            <span className="text-xs text-danger">{testError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
