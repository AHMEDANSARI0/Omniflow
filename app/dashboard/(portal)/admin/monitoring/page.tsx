import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import MonitoringPageClient, {
  type ErrorLog,
  type MonitoringData,
} from "./MonitoringPageClient";

const EMPTY_MONITORING: MonitoringData = {
  uptime: "0s",
  memory_usage: "0MB",
  cpu_usage: "0%",
  requests_per_minute: 0,
  error_rate: 0,
  active_connections: 0,
  last_error: null,
  last_updated: "",
};

export default async function MonitoringPage() {
  const session = (await cookies()).get("session");
  if (!session?.value) {
    redirect("/login");
  }

  let monitoring = {
    ...EMPTY_MONITORING,
    last_updated: new Date().toISOString(),
  };
  let errors: ErrorLog[] = [];

  try {
    const cookieHeader = `session=${session.value}`;
    const [monitoringResponse, errorsResponse] = await Promise.all([
      fetch("http://localhost:3000/api/v1/monitoring", {
        headers: { Cookie: cookieHeader },
        cache: "no-store",
      }),
      fetch("http://localhost:3000/api/v1/admin/errors?limit=10", {
        headers: { Cookie: cookieHeader },
        cache: "no-store",
      }),
    ]);

    if (!monitoringResponse.ok || !errorsResponse.ok) {
      throw new Error(
        `Monitoring API requests failed (${monitoringResponse.status}, ${errorsResponse.status})`
      );
    }

    monitoring = (await monitoringResponse.json()) as MonitoringData;
    const errorsData = (await errorsResponse.json()) as { errors?: ErrorLog[] };
    errors = errorsData.errors ?? [];
  } catch (error) {
    console.error("Failed to fetch monitoring:", error);
  }

  return (
    <MonitoringPageClient
      monitoring={monitoring}
      errors={errors}
      isLoading={false}
    />
  );
}
