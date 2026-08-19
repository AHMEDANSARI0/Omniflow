"use client";

import { useState } from "react";
import AdminSidebar from "./AdminSidebar";

export default function AdminShell({
  userEmail,
  children,
}: {
  userEmail: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#06101d]">
      <AdminSidebar
        userEmail={userEmail}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />

      {/* Main content */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <main className="flex-1 px-5 pb-12 pt-20 sm:px-8 lg:pt-10">
          {children}
        </main>
      </div>
    </div>
  );
}