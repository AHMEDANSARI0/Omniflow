import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import DashShell from "../components/DashShell";

export default async function DashboardPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/dashboard/login");
  }

  // Role check — admins belong in /admin, clients here
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role === "admin") {
    redirect("/admin");
  }

  return <DashShell userEmail={user.email ?? "client"}>{children}</DashShell>;
}