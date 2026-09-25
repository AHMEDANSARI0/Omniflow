import ProfileClient from "./ProfileClient";

export default async function CustomerProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ contact?: string }>;
}) {
  const { contact } = await searchParams;
  return <ProfileClient contact={(contact || "").trim()} />;
}
