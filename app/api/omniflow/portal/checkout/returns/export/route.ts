import {
  exportReturnsCsv,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
} from "../../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }

  try {
    const csv = await exportReturnsCsv(accessToken);
    if (csv === null) {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
      });
    }
    return new Response(csv, {
      status: 200,
      headers: {
        ...noStoreHeaders(),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=omniflow-returns.csv",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }
}
