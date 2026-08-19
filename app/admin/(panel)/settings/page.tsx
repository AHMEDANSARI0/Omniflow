import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import PasswordForm from "./PasswordForm";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Settings
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Account and admin preferences.
        </p>
      </div>

      {/* Account info card */}
      <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="mb-1 text-sm font-semibold text-white">Account</h2>
        <p className="mb-5 text-xs text-slate-500">
          The admin account used to sign in to this panel.
        </p>

        <div className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-sm text-cyan-300">
            ◈
          </div>
          <div>
            <p className="text-sm font-medium text-white">{user.email}</p>
            <p className="text-[11px] text-slate-500">Administrator</p>
          </div>
        </div>
      </div>

      {/* Change password */}
      <PasswordForm />
    </div>
  );
}