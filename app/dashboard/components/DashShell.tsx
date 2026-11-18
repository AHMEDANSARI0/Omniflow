"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import AskOmniBubble from "./AskOmniBubble";
import CommandPalette from "./CommandPalette";
import DashSidebar from "./DashSidebar";
import DashTopbar from "./DashTopbar";
import MobileTabBar from "./MobileTabBar";
import { isRouteAllowedByEntitlements } from "./portalNav";

export default function DashShell({
  userEmail,
  clientId,
  role,
  planName = "Basic WhatsApp",
  workspaceStatus = "Active",
  enabledFeatures,
  children,
}: {
  userEmail: string;
  clientId: number;
  role: string;
  planName?: string;
  workspaceStatus?: "Active" | "Suspended" | "Locked";
  enabledFeatures?: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/dashboard";
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [liveFeatures, setLiveFeatures] = useState<string[] | undefined>(
    enabledFeatures
  );
  const [liveStatus, setLiveStatus] = useState<"Active" | "Suspended" | "Locked">(
    workspaceStatus
  );
  const [livePlan, setLivePlan] = useState(planName);

  useEffect(() => {
    setLiveFeatures(enabledFeatures);
  }, [enabledFeatures]);

  useEffect(() => {
    setLiveStatus(workspaceStatus);
  }, [workspaceStatus]);

  useEffect(() => {
    setLivePlan(planName);
  }, [planName]);

  // Automatically reflect updated entitlements when Platform Admin changes access
  useEffect(() => {
    let active = true;
    async function refreshEntitlements() {
      try {
        const res = await fetch("/api/omniflow/portal/entitlements", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const payload = await res.json().catch(() => null);
        const ent = payload?.entitlements;
        if (!active || !ent) return;
        const nextEnabled = Object.values(
          ent.features as Record<string, { featureKey: string; enabled: boolean }>
        )
          .filter((f) => f.enabled)
          .map((f) => f.featureKey);
        setLiveFeatures(nextEnabled);
        if (ent.workspaceStatus) setLiveStatus(ent.workspaceStatus);
        if (ent.planName) setLivePlan(ent.planName);
      } catch {
        // ignore network hiccup
      }
    }
    const id = setInterval(() => void refreshEntitlements(), 20000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const routeCheck = isRouteAllowedByEntitlements(pathname, liveFeatures);
  const askOmniAllowed =
    !liveFeatures || liveFeatures.includes("ai.advanced_tools");

  return (
    <div className="flex min-h-screen bg-canvas">
      <DashSidebar
        userEmail={userEmail}
        clientId={clientId}
        role={role}
        planName={livePlan}
        enabledFeatures={liveFeatures}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <DashTopbar
          menuOpen={mobileOpen}
          onMenu={() => setMobileOpen((value) => !value)}
        />
        <main className="flex-1 px-5 pb-36 pt-20 sm:px-8 lg:px-10 lg:pb-28 lg:pt-8">
          {liveStatus !== "Active" ? (
            <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-danger/25 bg-white p-8 text-center shadow-card">
              <span className="inline-flex rounded-full bg-danger/10 px-3 py-1 text-xs font-semibold text-danger">
                Workspace {liveStatus}
              </span>
              <h1 className="mt-3 text-xl font-semibold text-ink">
                Workspace Access Restricted
              </h1>
              <p className="mt-2 text-sm text-ink-2">
                Your workspace (#{clientId}) is currently marked as{" "}
                <strong>{liveStatus}</strong> by Platform Admin. All automation
                and portal operations are paused until access is restored.
              </p>
            </div>
          ) : !routeCheck.allowed ? (
            <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-line bg-white p-8 text-center shadow-card">
              <span className="inline-flex rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand">
                Managed by Platform Admin
              </span>
              <h1 className="mt-3 text-xl font-semibold text-ink">
                {routeCheck.label} is Not Enabled for Your Workspace
              </h1>
              <p className="mt-2 text-sm text-ink-2">
                Your workspace is currently on the <strong>{livePlan}</strong>{" "}
                configuration. Advanced modules ({routeCheck.label}) are
                controlled centrally by Platform Admin.
              </p>
              {routeCheck.featureKey ? (
                <p className="mt-2 font-mono text-xs text-ink-3">
                  Entitlement key: {routeCheck.featureKey}
                </p>
              ) : null}
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href="/dashboard"
                  className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2"
                >
                  Back to WhatsApp Dashboard
                </Link>
                <Link
                  href="/dashboard/conversations"
                  className="inline-flex min-h-10 items-center rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 hover:bg-line/50 hover:text-ink"
                >
                  Open Inbox
                </Link>
              </div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      <MobileTabBar enabledFeatures={liveFeatures} />
      {askOmniAllowed ? <AskOmniBubble /> : null}
      <CommandPalette enabledFeatures={liveFeatures} />
    </div>
  );
}
