import { redirect } from "next/navigation";
import ProfileForm, { type BusinessProfile } from "./ProfileForm";
import {
  DEFAULT_BUSINESS_PROFILE,
  getBusinessProfile,
  requirePortalAccessToken,
} from "../../../../lib/omniflow/portal";


export const dynamic = "force-dynamic";

export default async function BusinessProfilePage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  const result = await getBusinessProfile(accessToken);
  const profile = {
    ...DEFAULT_BUSINESS_PROFILE,
    ...result.data,
  } as BusinessProfile;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Business profile
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Your AI agent answers questions using this profile — products, hours,
          language and contact details.
        </p>
      </div>

      {!result.configured && (
        <div className="mb-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] px-5 py-4">
          <p className="text-sm text-amber-200/90">
            The profile module is rolling out on the server — you can fill the
            form now and save in a couple of minutes.
          </p>
        </div>
      )}

      <ProfileForm profile={profile} />
    </div>
  );
}
