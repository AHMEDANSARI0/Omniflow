import Link from "next/link";
import { COPY_BLOCKS } from "../../../../lib/marketing/copy";
import { MARKETING_LISTS } from "../../../../lib/marketing/lists";

interface ContentLink {
  label: string;
  description: string;
  href: string;
  icon: string;
}

const sections: ContentLink[] = [
  { label: "Hero", description: "Main headline, description, buttons and channel chips.", href: "/admin/content/hero", icon: "◇" },
  { label: "AI Intelligence", description: "Section heading and the 3 intelligence pillars.", href: "/admin/content/ai-intelligence", icon: "✦" },
  { label: "How It Works", description: "Section heading and the 4 workflow steps.", href: "/admin/content/how-it-works", icon: "↗" },
  { label: "Problem / Solution", description: "The problem framing and OmniFlow's answer.", href: "/admin/content/problem-solution", icon: "◇" },
  { label: "Features", description: "Capability cards and the section heading.", href: "/admin/content/features", icon: "◇" },
  { label: "Use cases", description: "The 5 business tabs — headlines, automations and statuses.", href: "/admin/content/use-cases", icon: "◇" },
  { label: "Why OmniFlow", description: "Section heading and the 4 benefit rows.", href: "/admin/content/why-omniflow", icon: "◆" },
  { label: "Final CTA", description: "Early-access headline, copy and notes.", href: "/admin/content/final-cta", icon: "◇" },
  { label: "FAQ", description: "Questions, answers and contact email.", href: "/admin/content/faq", icon: "◎" },
  { label: "Multi-Channel", description: "Channel cards, workflow strip and section heading.", href: "/admin/content/multi-channel", icon: "◈" },
  { label: "Footer", description: "Footer description and link labels.", href: "/admin/content/footer", icon: "⌘" },
  { label: "Trust", description: "The 4 trust pillars and principles strip.", href: "/admin/content/trust", icon: "✦" },
  { label: "Customer Memory", description: "Section heading, context points and bottom note.", href: "/admin/content/customer-memory", icon: "◉" },
  { label: "Blog", description: "Write, publish and manage blog articles.", href: "/admin/content/blog", icon: "✎" },
];

// Lists and copy blocks: one generic editor each, config-driven.
const groups: { title: string; copy: string; links: ContentLink[] }[] = [
  { title: "Website sections", copy: "The main homepage sections and the blog.", links: sections },
  {
    title: "Lists",
    copy: "Repeating items: add, remove, reorder and edit.",
    links: Object.entries(MARKETING_LISTS).map(([key, spec]) => ({
      label: spec.title,
      description: spec.description,
      href: `/admin/content/lists/${key}`,
      icon: spec.hubIcon,
    })),
  },
  {
    title: "Page copy & product mockups",
    copy: "Headings, inner-page text and the sample content inside the product mockups.",
    links: Object.entries(COPY_BLOCKS).map(([key, spec]) => ({
      label: spec.title,
      description: spec.description,
      href: `/admin/content/copy/${key}`,
      icon: spec.hubIcon,
    })),
  },
];

export default function ContentHubPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Content</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Edit all website text without touching code. Anything left unchanged uses the built-in default.
        </p>
      </div>

      <Link
        href="/admin/content/overrides"
        className="mb-10 flex items-center justify-between gap-4 rounded-2xl border border-line bg-white p-5 shadow-card transition-colors duration-300 hover:border-brand/20"
      >
        <div>
          <h2 className="text-sm font-semibold text-ink">Overrides</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Saved text replaces the built-in default, even after the default changes. See what is still overridden
            and hand fields back to the default.
          </p>
        </div>
        <span className="text-ink-3">→</span>
      </Link>

      <div className="space-y-10">
        {groups.map((group) => (
          <section key={group.title}>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-2">{group.title}</h2>
            <p className="mb-4 mt-1 text-xs text-ink-3">{group.copy}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="group rounded-2xl border border-line bg-white p-5 shadow-card transition-colors duration-300 hover:border-brand/20"
                >
                  <div className="mb-4 flex items-start justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand/20 bg-brand/[0.05] text-sm text-brand">
                      {link.icon}
                    </div>
                    <span className="text-ink-3 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-brand">
                      →
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-ink">{link.label}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{link.description}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
