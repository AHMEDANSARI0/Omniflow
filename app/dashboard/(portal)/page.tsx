import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";


interface ModuleCard {
  icon: string;
  title: string;
  description: string;
  status: "active" | "next" | "soon";
}

const modules: ModuleCard[] = [
  {
    icon: "◉",
    title: "Managed WhatsApp",
    description:
      "Authorize once from mobile, then OmniFlow-managed infrastructure keeps the session available.",
    status: "active",
  },
  {
    icon: "✦",
    title: "AI agents",
    description:
      "Tone, greetings, fallbacks, working hours and handoff policies — live from the Control Plane.",
    status: "active",
  },
  {
    icon: "◎",
    title: "Conversations",
    description:
      "Tenant-isolated customer conversations, AI outcomes and human handoffs across channels.",
    status: "active",
  },
  {
    icon: "◇",
    title: "Business profile",
    description:
      "Products, services, prices, policies, FAQs, operating hours and language preferences.",
    status: "active",
  },
];

const statusStyle = {
  active: "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300",
  next: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-300",
  soon: "border-white/[0.06] bg-white/[0.02] text-slate-500",
};

export default async function ClientDashboardPage() {
  const principal = await requireOmniFlowPrincipal();

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
          Workspace {principal.clientId}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Welcome{principal.displayName ? `, ${principal.displayName}` : ""}
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Your tenant-isolated OmniFlow workspace is authenticated and ready.
        </p>
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.035] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-emerald-300/70">Session</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-medium text-white">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> Secure
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Role</p>
          <p className="mt-1 text-sm font-medium capitalize text-white">{principal.role}</p>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Architecture</p>
          <p className="mt-1 text-sm font-medium text-white">Managed connector</p>
        </div>
      </div>

      <div className="mb-8 flex items-start gap-3 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.025] px-5 py-4">
        <span className="relative mt-1 flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
        </span>
        <div>
          <p className="text-sm text-slate-300">Secure portal authentication is active.</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            All portal modules are live on the versioned Control Plane API. Link your WhatsApp connector and every message, AI reply and conversation lands here automatically.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {modules.map((module) => (
          <div
            key={module.title}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
                {module.icon}
              </div>
              <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${statusStyle[module.status]}`}>
                {module.status === "active" ? "Active" : module.status === "next" ? "Next" : "Coming soon"}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-white">{module.title}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              {module.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
