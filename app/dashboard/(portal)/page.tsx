interface ModuleCard {
  icon: string;
  title: string;
  description: string;
  status: "active" | "soon";
}

const modules: ModuleCard[] = [
  {
    icon: "✦",
    title: "My Bot",
    description:
      "Configure your AI assistant — welcome message, behavior and status.",
    status: "active",
  },
  {
    icon: "◎",
    title: "Conversations",
    description: "See the conversations your bot is handling in real time.",
    status: "active",
  },
  {
    icon: "◉",
    title: "Business profile",
    description: "Your company details, hours and contact information.",
    status: "active",
  },
  {
    icon: "⌘",
    title: "Settings",
    description: "Account preferences and password.",
    status: "active",
  },
];

export default function ClientDashboardPage() {
  return (
    <div className="mx-auto max-w-4xl">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Overview
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Welcome to your OmniFlow workspace.
        </p>
      </div>

      {/* Status strip */}
      <div className="mb-8 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
        </span>
        <p className="text-sm text-slate-300">
          Your workspace is ready.
          <span className="ml-2 text-slate-500">
            Modules are being rolled out step by step.
          </span>
        </p>
      </div>

      {/* Module cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {modules.map((mod) => (
          <div
            key={mod.title}
            className={`rounded-2xl border p-5 ${
              mod.status === "soon"
                ? "cursor-not-allowed border-white/[0.05] bg-white/[0.01] opacity-60"
                : "border-white/[0.06] bg-white/[0.015]"
            }`}
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
                {mod.icon}
              </div>
              <span
                className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  mod.status === "active"
                    ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                }`}
              >
                {mod.status === "active" ? "Active" : "Coming soon"}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-white">{mod.title}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              {mod.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}