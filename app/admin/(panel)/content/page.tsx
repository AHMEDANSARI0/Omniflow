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
    label: "FAQ",
    description: "Questions, answers and contact email.",
    href: "/admin/content/faq",
    icon: "◎",
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

  {
    href: "/admin/content/blog",
    label: "Blog",
    icon: "✎",
    description: "Write, publish and manage blog articles.",
    enabled: true,
  },
];

export default function ContentHubPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Content
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
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
                className="cursor-not-allowed rounded-2xl border border-line bg-white/[0.01] p-5 opacity-50"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-soft text-sm text-ink-3">
                    {section.icon}
                  </div>
                  <span className="rounded-md border border-line bg-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-3">
                    Soon
                  </span>
                </div>
                <h2 className="text-sm font-semibold text-ink-3">
                  {section.label}
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                  {section.description}
                </p>
              </div>
            );
          }

          return (
            <Link
              key={section.href}
              href={section.href}
              className="group rounded-2xl border border-line bg-soft p-5 transition-colors duration-300 hover:border-brand/20"
            >
              <div className="mb-4 flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand/20 bg-cyan-400/[0.05] text-sm text-brand">
                  {section.icon}
                </div>
                <span className="text-ink-3 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-brand">
                  →
                </span>
              </div>
              <h2 className="text-sm font-semibold text-ink">
                {section.label}
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                {section.description}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}