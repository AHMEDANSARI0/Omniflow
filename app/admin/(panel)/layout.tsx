import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import AdminShell from "../components/AdminShell";

export default async function AdminPanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }

  // Role check — only admins may enter the admin panel
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") {
    redirect("/");
  }

  return <AdminShell userEmail={user.email ?? "admin"}>{children}</AdminShell>;
}