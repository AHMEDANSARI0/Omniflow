import { createClient } from "../../../../lib/supabase/server";
import ProfileForm, { type BusinessProfile } from "./ProfileForm";

const EMPTY_PROFILE: BusinessProfile = {
  business_name: "",
  industry: "",
  phone: "",
  website: "",
  address: "",
  timezone: "Asia/Karachi",
  business_hours: "Mon–Sat, 9:00 – 18:00",
  default_language: "english",
};

export default async function BusinessProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("id", user!.id)
    .single();

  const profile: BusinessProfile = {
    ...EMPTY_PROFILE,
    ...((data as Partial<BusinessProfile> | null) ?? {}),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Business profile
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Your company details. Your AI assistant will use this context in
          conversations.
        </p>
      </div>

      <ProfileForm profile={profile} />
    </div>
  );
}