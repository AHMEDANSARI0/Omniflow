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
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Account and admin preferences.
        </p>
      </div>

      {/* Account info card */}
      <div className="mb-6 rounded-2xl border border-line bg-soft p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">Account</h2>
        <p className="mb-5 text-xs text-ink-3">
          The admin account used to sign in to this panel.
        </p>

        <div className="flex items-center gap-3 rounded-xl border border-line bg-soft px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand/20 bg-cyan-400/[0.05] text-sm text-brand">
            ◈
          </div>
          <div>
            <p className="text-sm font-medium text-ink">{user.email}</p>
            <p className="text-[11px] text-ink-3">Administrator</p>
          </div>
        </div>
      </div>

      {/* Change password */}
      <PasswordForm />
    </div>
  );
}