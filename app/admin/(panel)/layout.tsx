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

  // Real auth guard for every admin panel page (proxy handles redirects too)
  if (!user) {
    redirect("/admin/login");
  }

  return <AdminShell userEmail={user.email ?? "admin"}>{children}</AdminShell>;
}