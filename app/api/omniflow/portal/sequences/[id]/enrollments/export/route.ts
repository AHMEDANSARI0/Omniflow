import {
  exportEnrollmentsCsv,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
} from "../../../../../../../../lib/omniflow/request-security";


export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }

  try {
    const result = await exportEnrollmentsCsv(accessToken, sequenceId);
    if (result.kind === "not_found") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
      });
    }
    if (result.kind !== "ok") {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
      });
    }
    return new Response(result.csv, {
      status: 200,
      headers: {
        ...noStoreHeaders(),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          "attachment; filename=sequence-" + String(sequenceId) + "-enrollments.csv",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }
}
