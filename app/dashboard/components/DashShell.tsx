"use client";

import { useState } from "react";
import DashSidebar from "./DashSidebar";


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

  return (
    <div className="flex min-h-screen bg-[#06101d]">
      <DashSidebar
        userEmail={userEmail}
        clientId={clientId}
        role={role}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <main className="flex-1 px-5 pb-12 pt-20 sm:px-8 lg:pt-10">
          {children}
        </main>
      </div>
    </div>
  );
}
