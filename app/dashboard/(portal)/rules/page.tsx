"use client";

import { useCallback, useEffect, useState } from "react";
import RuleConflicts from "./RuleConflicts";
import PortalIcon, { type IconName } from "../../components/PortalIcon";
import { usePortalEntitlements } from "../../components/usePortalEntitlements";
import HybridWhatsAppCard from "../bot/HybridWhatsAppCard";

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

const RULE_SET_FEATURE_MAP: Record<string, string> = {
  routing: "workspace.advanced_team",
  listen: "automation.advanced_builder",
  negotiation: "ai.advanced_tools",
  hours: "automation.advanced_builder",
  handoff: "automation.advanced_builder",
  autonomy: "ai.advanced_tools",
  approvals: "workspace.approvals",
  workflows: "automation.workflows",
};

export default function RulesPage() {
  const { hasFeature } = usePortalEntitlements();
  const canUseAdvancedBuilder = hasFeature("automation.advanced_builder");
  const [families, setFamilies] = useState<PolicyFamily[] | null>(null);

  const load = useCallback(async () => {
    if (!canUseAdvancedBuilder) return;
    try {
      const response = await fetch("/api/omniflow/portal/policy/rules", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          families?: PolicyFamily[];
        };
        setFamilies(payload.families ?? []);
      }
    } catch {
      // ignore
    }
  }, [canUseAdvancedBuilder]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only show advanced policy families that are both entitled AND active (count > 0)
  const visibleFamilies = canUseAdvancedBuilder
    ? (families ?? []).filter((family) => {
        const reqKey = RULE_SET_FEATURE_MAP[family.ruleSet];
        return (!reqKey || hasFeature(reqKey)) && family.count > 0;
      })
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Automation Rules
        </h1>
        <p className="mt-1 text-sm text-ink-2">
          Configure deterministic welcome greetings, keyword & FAQ auto-replies, and business hours away messages that execute before the AI assistant.
        </p>
      </div>

      {/* Deterministic Rule Engine (Rules Mode Only — no duplicate Business/AI form) */}
      <HybridWhatsAppCard mode="rules" />

      {canUseAdvancedBuilder && <RuleConflicts />}

      {visibleFamilies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleFamilies.map((family) => (
            <a
              key={family.ruleSet}
              href={family.href}
              className="block rounded-xl2 border border-line bg-white p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-brand/25 bg-brand-soft text-sm font-semibold text-brand">
                  <PortalIcon name={RULE_SET_ICONS[family.ruleSet] || "rules"} />
                </span>
                <span className="rounded-full border border-ok/30 bg-ok-soft px-2.5 py-0.5 text-[11px] font-semibold text-ok">
                  Active
                </span>
              </div>
              <p className="mt-3.5 text-sm font-semibold text-ink">
                {family.label}
              </p>
              <p className="mt-1 min-h-[36px] text-xs leading-relaxed text-ink-2">
                {family.summary}
              </p>
              <p className="mt-2 text-[11px] font-medium text-ink-3">
                {family.count} {family.count === 1 ? "rule" : "rules"}
              </p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
