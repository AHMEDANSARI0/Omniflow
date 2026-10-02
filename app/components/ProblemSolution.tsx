import { ArrowRight, Check, TriangleAlert, X } from "lucide-react";
import type { ProblemSolutionContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { Emphasis, SectionHead } from "./ui/Section";

function splitList(value: string) {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * What breaks -> how OmniFlow solves it (§216). Two contrasting light
 * panels joined by a flow connector, then the CMS metrics strip.
 * Server component; all copy from site_content.problem_solution.
 */
export default function ProblemSolution({ content }: { content: ProblemSolutionContent }) {
  const problems = splitList(content.problems);
  const solutions = splitList(content.solutions);
  const metrics = [
    { value: content.m1_value, label: content.m1_label },
    { value: content.m2_value, label: content.m2_label },
    { value: content.m3_value, label: content.m3_label },
    { value: content.m4_value, label: content.m4_label },
  ].filter((metric) => metric.value.trim() && metric.label.trim());

  return (
    <Section id="problem" tone="canvas" labelledBy="problem-title">
      <Reveal>
        <SectionHead
          id="problem-title"
          eyebrow={content.badge}
          title={
            <>
              {content.heading_line1} <Emphasis>{content.heading_line2}</Emphasis>
            </>
          }
          copy={content.description}
        />
      </Reveal>

      <div className="mt-14 grid items-stretch gap-5 lg:grid-cols-[1fr_auto_1fr] lg:gap-6">
        <Reveal lift className="h-full">
          <div className="h-full rounded-xl3 border border-line bg-white p-6 shadow-card sm:p-8">
            <p className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-rose-700">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-rose-200 bg-rose-50">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              </span>
              {content.problem_title}
            </p>
            <ul className="mt-6 space-y-3">
              {problems.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 rounded-xl2 border border-line/80 bg-soft/50 px-4 py-3 text-[14.5px] font-medium text-ink-2"
                >
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                    <X className="h-3 w-3" aria-hidden />
                  </span>
                  <span>
                    <span className="sr-only">Problem: </span>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <div aria-hidden className="relative flex items-center justify-center">
          <span className="of-connector of-connector-v absolute inset-y-0 left-1/2 hidden w-[2px] -translate-x-1/2 lg:block" />
          <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-full border border-brand/20 bg-white text-brand shadow-card">
            <ArrowRight className="h-5 w-5 rotate-90 lg:rotate-0" />
          </span>
        </div>

        <Reveal lift className="h-full">
          <div className="h-full rounded-xl3 border border-brand/25 bg-white p-6 shadow-card sm:p-8 [background-image:radial-gradient(28rem_18rem_at_100%_0%,rgba(99,91,255,0.07),transparent_65%)]">
            <p className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-brand-2">
              <span className="of-gradient inline-flex h-7 w-7 items-center justify-center rounded-lg text-white">
                <Check className="h-3.5 w-3.5" aria-hidden />
              </span>
              {content.solution_title}
            </p>
            <ul className="mt-6 space-y-3">
              {solutions.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 rounded-xl2 border border-brand/10 bg-brand-soft/50 px-4 py-3 text-[14.5px] font-medium text-ink"
                >
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                  <span>
                    <span className="sr-only">Solution: </span>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>

      {metrics.length > 0 ? (
        <Reveal>
          <dl className="mt-12 grid grid-cols-2 overflow-hidden rounded-xl3 border border-line bg-white shadow-card md:grid-cols-4">
            {metrics.map((metric, index) => (
              <div
                key={metric.label}
                className={`px-6 py-6 text-center ${index > 0 ? "md:border-l md:border-line" : ""} ${
                  index % 2 === 1 ? "border-l border-line md:border-l" : ""
                } ${index > 1 ? "border-t border-line md:border-t-0" : ""}`}
              >
                <dt className="sr-only">{metric.label}</dt>
                <dd className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">
                  {metric.value}
                </dd>
                <dd className="mt-1 text-[13px] font-medium text-ink-2">{metric.label}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      ) : null}
    </Section>
  );
}
