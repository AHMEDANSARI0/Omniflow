import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import IntegrationsClient from "./IntegrationsClient";

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Integrations
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Paste the provider keys once — every feature waiting on a key
          starts working the moment its settings are saved.
        </p>
      </div>
      <IntegrationsClient />
    </div>
  );
}
