import { createClient } from "../../../../../lib/supabase/server";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";
import {
  createClientWorkspace,
  deleteClientWorkspace,
  listAllWorkspacesAndUsers,
  updateClientWorkspaceAccess,
  type ConnectorPlatform,
} from "../../../../lib/workspace-store";

async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const admin = await requireAdminSession();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }

  try {
    const users = await listAllWorkspacesAndUsers();
    return safeJson({ users });
  } catch {
    return safeJson(
      {
        error: {
          code: "clients_unavailable",
          message: "Could not load clients. Please try again.",
        },
      },
      503
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const admin = await requireAdminSession();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceName = typeof body.workspace_name === "string" ? body.workspace_name.trim() : "";
    const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password.trim() : undefined;
    const plan =
      body.plan === "Starter" || body.plan === "Growth" || body.plan === "Enterprise"
        ? body.plan
        : "Growth";
    const status = body.status === "Suspended" ? "Suspended" : "Active";
    const allowedChannels = Array.isArray(body.allowed_channels)
      ? (body.allowed_channels.map(String) as ConnectorPlatform[])
      : undefined;

    if (!email || !email.includes("@")) {
      return safeJson(
        { error: { code: "bad_request", message: "Enter a valid client email address." } },
        400
      );
    }

    const created = await createClientWorkspace({
      workspace_name: workspaceName || (displayName ? displayName + " Workspace" : "Client Workspace"),
      display_name: displayName || email.split("@")[0],
      email,
      password,
      plan,
      status,
      allowed_channels: allowedChannels,
    });

    const users = await listAllWorkspacesAndUsers();
    return safeJson({
      ok: true,
      user: created.user,
      workspace: created.workspace,
      temp_password: created.temp_password,
      users,
    });
  } catch (err) {
    return safeJson(
      {
        error: {
          code: "create_failed",
          message: err instanceof Error ? err.message : "Could not create workspace.",
        },
      },
      400
    );
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const admin = await requireAdminSession();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = Number(body.user_id || body.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid client ID." } }, 400);
  }

  const updated = await updateClientWorkspaceAccess(userId, {
    locked: typeof body.locked === "boolean" ? body.locked : undefined,
    status:
      body.status === "Active" || body.status === "Suspended" || body.status === "Locked"
        ? body.status
        : undefined,
    plan:
      body.plan === "Starter" || body.plan === "Growth" || body.plan === "Enterprise"
        ? body.plan
        : undefined,
    workspace_name: typeof body.workspace_name === "string" ? body.workspace_name : undefined,
    allowed_channels: Array.isArray(body.allowed_channels)
      ? (body.allowed_channels.map(String) as ConnectorPlatform[])
      : undefined,
  });

  const users = await listAllWorkspacesAndUsers();
  return safeJson({ ok: true, user: updated, users });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const admin = await requireAdminSession();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid workspace ID." } }, 400);
  }

  await deleteClientWorkspace(id);
  const users = await listAllWorkspacesAndUsers();
  return safeJson({ ok: true, users });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
