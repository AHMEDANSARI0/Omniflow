import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ClientsPageClient from "./ClientsPageClient";

interface ClientRecord {
  id: string;
  client_id: string;
  name: string;
  platform: string;
  status: string;
}

export default async function ClientsPage() {
  const session = (await cookies()).get("session");
  if (!session?.value) {
    redirect("/login");
  }

  let clients: ClientRecord[] = [];
  try {
    const response = await fetch("http://localhost:3000/api/v1/admin/clients", {
      headers: { Cookie: `session=${session.value}` },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error("Failed to fetch clients:", response.status);
    } else {
      const result = (await response.json()) as { clients?: ClientRecord[] };
      clients = result.clients ?? [];
    }
  } catch (error) {
    console.error("Failed to fetch clients:", error);
  }

  return <ClientsPageClient clients={clients} isLoading={false} />;
}
