import Link from "next/link";

interface ContentSection {
  label: string;
  description: string;
  href: string;
  icon: string;
  enabled: boolean;
}

const sections: ContentSection[] = [
  {
    label: "Hero",
    description: "Main headline, description, buttons and channel chips.",
    href: "/admin/content/hero",
    icon: "◇",
    enabled: true,
  },
    {
    label: "AI Intelligence",
    description: "Section heading and the 3 intelligence pillars.",
    href: "/admin/content/ai-intelligence",
    icon: "✦",
    enabled: true,
  },
    {
    label: "How It Works",
    description: "Section heading and the 4 workflow steps.",
    href: "/admin/content/how-it-works",
    icon: "↗",
    enabled: true,
  },
  {
    label: "Problem / Solution",
    description: "The problem framing and OmniFlow's answer.",
    href: "/admin/content/problem-solution",
    icon: "◇",
    enabled: true,
  },
  {
    label: "Features",
    description: "Capability cards and the section heading.",
    href: "/admin/content/features",
    icon: "◇",
    enabled: true,
  },
    {
    label: "Use cases",
    description: "The 5 business tabs — headlines, automations and statuses.",
    href: "/admin/content/use-cases",
    icon: "◇",
    enabled: true,
  },
  {
    label: "Why OmniFlow",
    description: "Section heading and the 4 benefit rows.",
    href: "/admin/content/why-omniflow",
    icon: "◆",
    enabled: true,
  },
  {
    label: "Final CTA",
    description: "Early-access headline, copy and notes.",
    href: "/admin/content/final-cta",
    icon: "◇",
    enabled: true,
  },
    {
    label: "Multi-Channel",
    description: "Channel cards, workflow strip and section heading.",
    href: "/admin/content/multi-channel",
    icon: "◈",
    enabled: true,
  },
  {
    label: "Footer",
    description: "Footer description and link labels.",
    href: "/admin/content/footer",
    icon: "⌘",
    enabled: true,
  },
    {
    label: "Trust",
    description: "The 4 trust pillars and principles strip.",
    href: "/admin/content/trust",
    icon: "✦",
    enabled: true,
  },
    {
    label: "Customer Memory",
    description: "Section heading, context points and bottom note.",
    href: "/admin/content/customer-memory",
    icon: "◉",
    enabled: true,
  },
    
];

export default function ContentHubPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Content
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Edit website sections without touching code. More sections are being
          made editable step by step.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => {
          if (!section.enabled) {
            return (
              <div
                key={section.href}
                className="cursor-not-allowed rounded-2xl border border-white/[0.05] bg-white/[0.01] p-5 opacity-50"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-sm text-slate-500">
                    {section.icon}
                  </div>
                  <span className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                    Soon
                  </span>
                </div>
                <h2 className="text-sm font-semibold text-slate-400">
                  {section.label}
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  {section.description}
                </p>
              </div>
            );
          }

          return (
            <Link
              key={section.href}
              href={section.href}
              className="group rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 transition-colors duration-300 hover:border-cyan-400/20"
            >
              <div className="mb-4 flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
                  {section.icon}
                </div>
                <span className="text-slate-600 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-cyan-300">
                  →
                </span>
              </div>
              <h2 className="text-sm font-semibold text-white">
                {section.label}
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {section.description}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}