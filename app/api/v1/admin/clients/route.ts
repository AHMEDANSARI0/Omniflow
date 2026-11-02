import { NextRequest, NextResponse } from "next/server";
import { getClients, getClient, createClient, updateClient, deleteClient } from "../../../../lib/database/clients";
import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";

/**
 * GET /api/v1/admin/clients
 * List all clients (admin only).
 */
export async function GET(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  // Optional: filter by client_id
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id");

  try {
    let clients;
    if (clientId) {
      const client = await getClient(clientId);
      clients = client ? [client] : [];
    } else {
      clients = await getClients();
    }

    return NextResponse.json({ clients });
  } catch (error) {
    console.error("Failed to fetch clients:", error);
    return NextResponse.json(
      { error: "Failed to fetch clients" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/admin/clients
 * Create a new client (admin only).
 */
export async function POST(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { client_id, name, platform, status } = body;

    if (!client_id || !name) {
      return NextResponse.json(
        { error: "client_id and name are required" },
        { status: 400 }
      );
    }

    const client = await createClient(
      client_id,
      name,
      platform || "whatsapp"
    );

    return NextResponse.json({ client }, { status: 201 });
  } catch (error) {
    console.error("Failed to create client:", error);
    return NextResponse.json(
      { error: "Failed to create client" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/v1/admin/clients
 * Update an existing client (admin only).
 */
export async function PUT(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { client_id, name, platform, status } = body;

    if (!client_id) {
      return NextResponse.json(
        { error: "client_id is required" },
        { status: 400 }
      );
    }

    const client = await updateClient(client_id, {
      name,
      platform,
      status,
    });

    if (!client) {
      return NextResponse.json(
        { error: "Client not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ client });
  } catch (error) {
    console.error("Failed to update client:", error);
    return NextResponse.json(
      { error: "Failed to update client" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/admin/clients?client_id=<id>
 * Delete a client (admin only).
 */
export async function DELETE(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  const clientId = request.nextUrl.searchParams.get("client_id");

  if (!clientId) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 }
    );
  }

  try {
    const deleted = await deleteClient(clientId);

    if (!deleted) {
      return NextResponse.json(
        { error: "Client not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete client:", error);
    return NextResponse.json(
      { error: "Failed to delete client" },
      { status: 500 }
    );
  }
}
