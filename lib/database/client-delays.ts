// lib/database/client-delays.ts
// Per-client response delay storage in PostgreSQL

import { Pool } from "pg";

// Singleton pool
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || "",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export interface ClientDelayRecord {
  client_id: string;
  response_delay_seconds: number;
  updated_at: Date;
}

/**
 * Get delay for a specific client.
 * Returns 0 (instant) if no record found.
 */
export async function getClientDelay(clientId: string): Promise<number> {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ response_delay_seconds: number }>(
      `SELECT response_delay_seconds FROM response_delays WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    if (result.rows.length === 0) {
      return 0;
    }
    return result.rows[0].response_delay_seconds;
  } finally {
    client.release();
  }
}

/**
 * Set or update delay for a client.
 */
export async function setClientDelay(
  clientId: string,
  delaySeconds: number
): Promise<void> {
  // Validate range
  const validatedDelay = Math.max(0, Math.min(3600, delaySeconds));

  const client = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO response_delays (client_id, response_delay_seconds, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (client_id) DO UPDATE
       SET response_delay_seconds = $2, updated_at = NOW()`,
      [clientId, validatedDelay]
    );
  } finally {
    client.release();
  }
}

/**
 * Get all client delays (for analytics).
 */
export async function getAllClientDelays(): Promise<ClientDelayRecord[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query<ClientDelayRecord>(
      `SELECT client_id, response_delay_seconds, updated_at
       FROM response_delays
       ORDER BY client_id`
    );
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Delete a client's delay record.
 */
export async function deleteClientDelay(clientId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `DELETE FROM response_delays WHERE client_id = $1`,
      [clientId]
    );
  } finally {
    client.release();
  }
}

/**
 * Initialize the delays table if it doesn't exist.
 */
export async function initClientDelaysTable(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS response_delays (
        client_id TEXT PRIMARY KEY,
        response_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (response_delay_seconds >= 0 AND response_delay_seconds <= 3600),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}
