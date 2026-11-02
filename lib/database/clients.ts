// lib/database/clients.ts
// Client management database operations

import { Pool } from "pg";

// Use the same pool as client-delays.ts
import { getPool } from "./client-delays";

export interface ClientRecord {
  id: string;
  client_id: string;
  name: string;
  platform: string;
  status: "active" | "inactive";
  created_at: Date;
  updated_at: Date;
}

/**
 * Get all clients.
 */
export async function getClients(): Promise<ClientRecord[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query<ClientRecord>(
      `SELECT id, client_id, name, platform, status, created_at, updated_at
       FROM clients
       ORDER BY name`
    );
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Get a single client by ID.
 */
export async function getClient(clientId: string): Promise<ClientRecord | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query<ClientRecord>(
      `SELECT id, client_id, name, platform, status, created_at, updated_at
       FROM clients
       WHERE client_id = $1`,
      [clientId]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/**
 * Create a new client.
 */
export async function createClient(
  clientId: string,
  name: string,
  platform: string = "whatsapp"
): Promise<ClientRecord> {
  const validatedPlatform = platform.toLowerCase();

  const dbClient = await getPool().connect();
  try {
    const result = await dbClient.query<ClientRecord>(
      `INSERT INTO clients (client_id, name, platform, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', NOW(), NOW())
       RETURNING id, client_id, name, platform, status, created_at, updated_at`,
      [clientId, name, validatedPlatform]
    );
    return result.rows[0];
  } finally {
    dbClient.release();
  }
}