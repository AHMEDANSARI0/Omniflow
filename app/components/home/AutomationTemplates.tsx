"use client";

import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  AUTOMATION_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
} from "../../../lib/marketing/templates";
import { TEMPLATES_SECTION } from "../../../lib/marketing/sections";
import { SITE_ROUTES } from "../../../lib/marketing/site";
import Reveal from "../Reveal";
import Section, { SectionHead } from "../ui/Section";
import Icon from "../ui/Icon";

/**
 * Automation templates (§216): filterable cards, each with icon, title,
 * description, the workflow steps and a CTA. Data lives in
 * lib/marketing/templates.ts.
 */
export default function AutomationTemplates() {
  const [category, setCategory] = useState<TemplateCategory | "all">("all");

  const visible = useMemo(
    () =>
      category === "all"
        ? AUTOMATION_TEMPLATES
        : AUTOMATION_TEMPLATES.filter((template) => template.category === category),
    [category]
  );

  const labelFor = (key: TemplateCategory) =>
    TEMPLATE_CATEGORIES.find((item) => item.key === key)?.label ?? key;

  return (
    <Section id={TEMPLATES_SECTION.id} tone="white" labelledBy="templates-title">
      <Reveal>
        <SectionHead
          id="templates-title"
          eyebrow={TEMPLATES_SECTION.eyebrow}
          title={TEMPLATES_SECTION.title}
          copy={TEMPLATES_SECTION.copy}
        />
      </Reveal>

      <div
        role="group"
        aria-label="Filter templates by category"
        className="mx-auto mt-10 flex max-w-full flex-wrap justify-center gap-2"
      >
        {TEMPLATE_CATEGORIES.map((item) => {
          const active = item.key === category;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(item.key)}
              className={`h-9 rounded-full border px-4 text-[13px] font-semibold transition-all duration-200 ${
                active
                  ? "border-brand bg-brand text-white shadow-cta"
                  : "border-line bg-white text-ink-2 hover:border-line-2 hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <p className="sr-only" aria-live="polite">
        {visible.length} templates shown
      </p>

      <ul className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((template) => (
          <Reveal as="li" key={template.id}>
            <article className="of-hover-lift group flex h-full flex-col rounded-xl3 border border-line bg-white p-6 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                  <Icon name={template.icon} />
                </span>
                <span className="rounded-full border border-line bg-soft px-2.5 py-0.5 text-[11px] font-semibold text-ink-3">
                  {labelFor(template.category)}
                </span>
              </div>
              <h3 className="mt-5 font-display text-lg font-semibold text-ink">{template.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{template.description}</p>

              <ol className="mt-5 space-y-2.5 border-t border-line pt-5" aria-label={`${template.title} steps`}>
                {template.steps.map((step, index) => (
                  <li key={step} className="relative flex items-center gap-3 text-[13px] font-medium text-ink-2">
                    <span className="relative z-[1] inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-white font-display text-[11px] font-semibold tabular-nums text-brand-2">
                      {index + 1}
                    </span>
                    {index < template.steps.length - 1 ? (
                      <span aria-hidden className="absolute left-3 top-6 h-2.5 w-px bg-line-2" />
                    ) : null}
                    {step}
                  </li>
                ))}
              </ol>

              <a
                href={SITE_ROUTES.start}
                className="mt-6 inline-flex items-center gap-1.5 self-start rounded-lg text-[14px] font-semibold text-brand-2 transition-colors hover:text-brand"
                aria-label={`${template.cta}: ${template.title}`}
              >
                {template.cta}
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
              </a>
            </article>
          </Reveal>
        ))}
      </ul>

      <div className="mt-10 text-center">
        <a
          href={SITE_ROUTES.start}
          className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-2 bg-white px-5 text-sm font-semibold text-ink shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition-colors hover:border-brand/40"
        >
          {TEMPLATES_SECTION.allLabel}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </a>
      </div>
    </Section>
  );
}
