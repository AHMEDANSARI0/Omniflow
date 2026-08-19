import Link from "next/link";

interface ModuleCard {
  icon: string;
  title: string;
  description: string;
  href: string;
  status: "active" | "soon";
}

const modules: ModuleCard[] = [
  {
    icon: "◎",
    title: "SEO settings",
    description: "Control meta title, description and social tags of the website.",
    href: "/admin/seo",
    status: "active",
  },
  {
    icon: "✦",
    title: "Content",
    description: "Edit website sections and copy without touching code.",
    href: "/admin/content",
    status: "active",
  },
  {
    icon: "◇",
    title: "Leads",
    description: "View and manage early-access requests from the website.",
    href: "/admin/leads",
    status: "active",
  },
  {
    icon: "⌘",
    title: "Settings",
    description: "General site configuration and admin preferences.",
    href: "/admin/settings",
    status: "active",
  },
];

export default function AdminDashboardPage() {
  return (
    <div className="mx-auto max-w-4xl">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Dashboard
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Manage your OmniFlow website from one place.
        </p>
      </div>

      {/* Status strip */}
      <div className="mb-8 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        <p className="text-sm text-slate-300">
          Website is live and running.
          <span className="ml-2 text-slate-500">
            SEO, Content and Leads modules are active.
          </span>
        </p>
      </div>

      {/* Module cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {modules.map((mod) => {
          if (mod.status === "soon") {
            return (
              <div
                key={mod.title}
                className="cursor-not-allowed rounded-2xl border border-white/[0.05] bg-white/[0.01] p-5 opacity-50"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-sm text-slate-500">
                    {mod.icon}
                  </div>
                  <span className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                    Coming soon
                  </span>
                </div>
                <h2 className="text-sm font-semibold text-slate-400">
                  {mod.title}
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  {mod.description}
                </p>
              </div>
            );
          }

          return (
            <Link
              key={mod.title}
              href={mod.href}
              className="group rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 transition-colors duration-300 hover:border-cyan-400/20"
            >
              <div className="mb-4 flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
                  {mod.icon}
                </div>
                <span className="rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
                  Active
                </span>
              </div>
              <h2 className="text-sm font-semibold text-white">{mod.title}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {mod.description}
              </p>
              <span className="mt-3 inline-block text-xs text-slate-600 transition-colors duration-300 group-hover:text-cyan-300">
                Open →
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}