"use client";

import { useState } from "react";
import AskOmniBubble from "./AskOmniBubble";
import CommandPalette from "./CommandPalette";
import DashSidebar from "./DashSidebar";
import DashTopbar from "./DashTopbar";
import MobileTabBar from "./MobileTabBar";


export default function DashShell({
  userEmail,
  clientId,
  role,
  children,
}: {
  userEmail: string;
  clientId: number;
  role: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-canvas">
      <DashSidebar
        userEmail={userEmail}
        clientId={clientId}
        role={role}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <DashTopbar menuOpen={mobileOpen} onMenu={() => setMobileOpen((value) => !value)} />
        <main className="flex-1 px-5 pb-36 pt-20 sm:px-8 lg:px-10 lg:pb-28 lg:pt-8">
          {children}
        </main>
      </div>
      <MobileTabBar />
      <AskOmniBubble />
      <CommandPalette />
    </div>
  );
}
