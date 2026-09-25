import { Check, X } from "lucide-react";
import type { ProblemSolutionContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

/**
 * The before/after story: a chaotic inbox vs one automation layer.
 * Server component — scroll reveals only, no client JS.
 */
export default function ProblemSolution({
  content,
}: {
  content: ProblemSolutionContent;
}) {
  const problems = content.problems.split("|").map((item) => item.trim());
  const solutions = content.solutions.split("|").map((item) => item.trim());
  const metrics = [
    { value: content.m1_value, label: content.m1_label },
    { value: content.m2_value, label: content.m2_label },
    { value: content.m3_value, label: content.m3_label },
    { value: content.m4_value, label: content.m4_label },
  ];

  return (
    <Section id="product" tone="white">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      <div className="mt-14 grid gap-5 lg:grid-cols-2">
        <Reveal lift>
          <Card className="h-full p-7">
            <Badge tone="neutral">{content.problem_title}</Badge>
            <ul className="mt-5 space-y-3.5">
              {problems.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-danger/20 bg-danger-soft"
                  >
                    <X className="h-3 w-3 text-danger" />
                  </span>
                  <span className="text-[15px] leading-relaxed text-ink-2">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-6 rounded-xl2 border border-line bg-soft px-4 py-3 text-[13px] text-ink-3">
              Every message becomes manual work for your team.
            </div>
          </Card>
        </Reveal>

        <Reveal lift>
          <Card gradientRing className="h-full p-7">
            <Badge tone="brand">{content.solution_title}</Badge>
            <ul className="mt-5 space-y-3.5">
              {solutions.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ok/20 bg-ok-soft"
                  >
                    <Check className="h-3 w-3 text-ok" />
                  </span>
                  <span className="text-[15px] leading-relaxed text-ink">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-6 rounded-xl2 border border-brand/15 bg-brand-soft px-4 py-3 text-[13px] text-brand-2">
              Every conversation becomes an automated workflow.
            </div>
          </Card>
        </Reveal>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-5 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Reveal key={metric.label}>
            <div className="rounded-xl2 border border-line bg-white px-5 py-6 text-center shadow-card">
              <p className="of-gradient bg-clip-text font-display text-3xl font-semibold text-transparent">
                {metric.value}
              </p>
              <p className="mt-1.5 text-[13px] font-medium text-ink-2">
                {metric.label}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
