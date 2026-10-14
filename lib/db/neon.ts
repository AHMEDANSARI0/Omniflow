import { Pool, types } from "pg";

/**
 * §276 — Neon data layer for the website (replaces Supabase PostgREST).
 *
 * Exposes a SMALL, Supabase-compatible query builder so the ~60 files that
 * already call `supabase.from("table").select(...).eq(...)` keep working with
 * NO changes: only the client that hands out `.from()` is swapped (see
 * lib/supabase/server.ts / service.ts). There is no Supabase anywhere.
 *
 * Supported surface (exactly what the codebase uses, audited):
 *   from(t).select(cols?) | insert(row|rows) | update(obj) | upsert(obj,{onConflict?}) | delete()
 *     .eq(col,val) .order(col,{ascending}) .limit(n) .single() .maybeSingle()
 *   -> thenable resolving to { data, error, count }
 *
 * Driver: node-postgres (`pg`) over the Neon POOLED connection string in
 * DATABASE_URL. Works on Vercel serverless (short pooled connections) and in
 * local tests (pgserver unix socket). JSONB columns: node-postgres serialises
 * plain objects to JSON automatically, Postgres coerces to jsonb.
 */

// Parse BIGINT (int8) and numeric as JS number/string safely. BIGSERIAL ids
// come back as int8; keep them as string to avoid precision loss, but the
// website treats ids opaquely, so number is fine for our ranges. Use Number
// for int8 to match Supabase's JSON (which returns numbers for int8).
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let pool: Pool | null = null;

export function neonEnabled(): boolean {
  return Boolean((process.env.DATABASE_URL || "").trim());
}

export function getPool(): Pool {
  if (pool) return pool;
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set (Neon connection string required)");
  }
  const needsSsl = /sslmode=require/.test(url) || /\.neon\.tech/i.test(url);
  pool = new Pool({
    connectionString: url,
    max: 5,
    // Neon presents a valid cert; rejectUnauthorized:false avoids serverless
    // CA-store issues. Local pgserver has no SSL (needsSsl false).
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

/** Run a parameterised query. Used by the builder and by lib/db/auth.ts. */
export async function neonQuery<T extends import("pg").QueryResultRow = any>(
  text: string,
  params: unknown[] = []
): Promise<import("pg").QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params as any[]);
}

// ---------------------------------------------------------------------------
// Supabase-shaped error
// ---------------------------------------------------------------------------
export interface PgRestError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

function shapeError(err: any): PgRestError {
  return {
    message: err?.message || "Database error",
    code: err?.code || undefined,
    details: err?.detail || err?.details || undefined,
    hint: err?.hint || undefined,
  };
}

// ---------------------------------------------------------------------------
// Identifier safety (columns/tables come from trusted code, but validate anyway)
// ---------------------------------------------------------------------------
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  const n = name.trim();
  if (!IDENT_RE.test(n)) {
    throw new Error(`Unsafe SQL identifier rejected: ${JSON.stringify(name)}`);
  }
  return `"${n}"`;
}

function quoteTable(name: string): string {
  // allow optional schema.table
  const parts = name.split(".");
  return parts.map(quoteIdent).join(".");
}

function parseColumns(cols: string): string {
  const c = cols.trim();
  if (c === "*" || c === "") return "*";
  return c
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(quoteIdent)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Primary-key lookup (cached) — for upsert() without an explicit onConflict
// ---------------------------------------------------------------------------
const pkCache = new Map<string, string[]>();

async function primaryKeyOf(table: string): Promise<string[]> {
  const cached = pkCache.get(table);
  if (cached) return cached;
  const res = await neonQuery<{ attname: string }>(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY a.attnum`,
    [table]
  );
  const pk = res.rows.map((r) => r.attname);
  pkCache.set(table, pk);
  return pk;
}

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------
export interface PgRestResult<T = any> {
  data: T | null;
  error: PgRestError | null;
  count: number;
}

type Op = "select" | "insert" | "update" | "upsert" | "delete";

export class QueryBuilder<T = any> implements PromiseLike<PgRestResult<T>> {
  private readonly table: string;
  private op: Op = "select";
  private cols = "*";
  private selectCalled = false;
  private filters: { col: string; val: unknown }[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private wantSingle = false;
  private wantMaybeSingle = false;
  private payload: any = null;
  private onConflict: string | null = null;

  constructor(table: string) {
    this.table = table;
  }

  // `select` resolves to an ARRAY of rows (Supabase parity), so downstream
  // `.map(row => …)` callbacks stay contextually typed instead of implicit-any.
  select(cols = "*"): QueryBuilder<any[]> {
    this.selectCalled = true;
    this.cols = cols;
    if (this.op === "select") this.op = "select";
    return this as unknown as QueryBuilder<any[]>;
  }
  insert(rows: any): this {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(obj: any): this {
    this.op = "update";
    this.payload = obj;
    return this;
  }
  upsert(obj: any, opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = obj;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  // `single`/`maybeSingle` resolve to a single OBJECT row (Supabase parity),
  // so callers can read `data.field` after a `.select(...)` array chain.
  single(): QueryBuilder<any> {
    this.wantSingle = true;
    return this as unknown as QueryBuilder<any>;
  }
  maybeSingle(): QueryBuilder<any> {
    this.wantMaybeSingle = true;
    return this as unknown as QueryBuilder<any>;
  }

  // ---- SQL construction ---------------------------------------------------
  private buildWhere(params: unknown[]): string {
    if (this.filters.length === 0) return "";
    const clauses = this.filters.map((f) => {
      params.push(f.val);
      return `${quoteIdent(f.col)} = $${params.length}`;
    });
    return ` WHERE ${clauses.join(" AND ")}`;
  }

  private buildOrderLimit(params: unknown[]): string {
    let sql = "";
    if (this.orders.length > 0) {
      sql +=
        " ORDER BY " +
        this.orders.map((o) => `${quoteIdent(o.col)} ${o.asc ? "ASC" : "DESC"}`).join(", ");
    }
    if (this.limitN !== null) {
      params.push(this.limitN);
      sql += ` LIMIT $${params.length}`;
    }
    return sql;
  }

  private rowsOf(payload: any): any[] {
    return Array.isArray(payload) ? payload : [payload];
  }

  private async execute(): Promise<PgRestResult<T>> {
    if (!neonEnabled()) {
      // Fail soft: no DATABASE_URL -> behave like an unreachable DB. Reads
      // return null data (callers fall back to code defaults); writes report
      // an error so callers can surface a message.
      return {
        data: null,
        error: { message: "Database not configured", code: "DB_NOT_CONFIGURED" },
        count: 0,
      };
    }
    const params: unknown[] = [];
    let text = "";
    const tbl = quoteTable(this.table);

    try {
      if (this.op === "select") {
        text =
          `SELECT ${parseColumns(this.cols)} FROM ${tbl}` +
          this.buildWhere(params) +
          this.buildOrderLimit(params);
        const res = await neonQuery(text, params);
        return this.shapeRead(res.rows, res.rowCount ?? res.rows.length);
      }

      if (this.op === "insert") {
        const rows = this.rowsOf(this.payload);
        if (rows.length === 0) return { data: null, error: null, count: 0 };
        const cols = Object.keys(rows[0]);
        const colSql = cols.map(quoteIdent).join(", ");
        const tuples = rows.map((row) => {
          const ph = cols.map((c) => {
            params.push(row[c] ?? null);
            return `$${params.length}`;
          });
          return `(${ph.join(", ")})`;
        });
        const returning = this.selectCalled ? ` RETURNING ${parseColumns(this.cols)}` : "";
        text = `INSERT INTO ${tbl} (${colSql}) VALUES ${tuples.join(", ")}${returning}`;
        const res = await neonQuery(text, params);
        return this.shapeWrite(res.rows, res.rowCount ?? 0);
      }

      if (this.op === "update") {
        const obj = this.payload || {};
        const cols = Object.keys(obj);
        if (cols.length === 0) return { data: null, error: null, count: 0 };
        const setSql = cols
          .map((c) => {
            params.push(obj[c] ?? null);
            return `${quoteIdent(c)} = $${params.length}`;
          })
          .join(", ");
        const where = this.buildWhere(params);
        const returning = this.selectCalled ? ` RETURNING ${parseColumns(this.cols)}` : "";
        text = `UPDATE ${tbl} SET ${setSql}${where}${returning}`;
        const res = await neonQuery(text, params);
        return this.shapeWrite(res.rows, res.rowCount ?? 0);
      }

      if (this.op === "upsert") {
        const rows = this.rowsOf(this.payload);
        if (rows.length === 0) return { data: null, error: null, count: 0 };
        const cols = Object.keys(rows[0]);
        const colSql = cols.map(quoteIdent).join(", ");
        const tuples = rows.map((row) => {
          const ph = cols.map((c) => {
            params.push(row[c] ?? null);
            return `$${params.length}`;
          });
          return `(${ph.join(", ")})`;
        });
        // Conflict target: explicit onConflict, else the table primary key.
        let conflictCols: string[];
        if (this.onConflict) {
          conflictCols = this.onConflict.split(",").map((c) => c.trim());
        } else {
          conflictCols = await primaryKeyOf(this.table);
          if (conflictCols.length === 0) {
            return {
              data: null,
              error: { message: `upsert: no primary key or onConflict for ${this.table}`, code: "NO_PK" },
              count: 0,
            };
          }
        }
        const conflictSql = conflictCols.map(quoteIdent).join(", ");
        const updateCols = cols.filter((c) => !conflictCols.includes(c));
        const doUpdate =
          updateCols.length > 0
            ? ` DO UPDATE SET ${updateCols.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(", ")}`
            : " DO NOTHING";
        const returning = this.selectCalled ? ` RETURNING ${parseColumns(this.cols)}` : "";
        text = `INSERT INTO ${tbl} (${colSql}) VALUES ${tuples.join(", ")} ON CONFLICT (${conflictSql})${doUpdate}${returning}`;
        const res = await neonQuery(text, params);
        return this.shapeWrite(res.rows, res.rowCount ?? 0);
      }

      // delete
      const where = this.buildWhere(params);
      const returning = this.selectCalled ? ` RETURNING ${parseColumns(this.cols)}` : "";
      text = `DELETE FROM ${tbl}${where}${returning}`;
      const res = await neonQuery(text, params);
      return this.shapeWrite(res.rows, res.rowCount ?? 0);
    } catch (err) {
      return { data: null, error: shapeError(err), count: 0 };
    }
  }

  private shapeRead(rows: any[], count: number): PgRestResult<T> {
    if (this.wantSingle) {
      if (rows.length === 1) return { data: rows[0] as T, error: null, count: 1 };
      return {
        data: null,
        error: {
          message:
            rows.length === 0
              ? "JSON object requested, multiple (or no) rows returned"
              : "JSON object requested, multiple (or no) rows returned",
          code: "PGRST116",
        },
        count: rows.length,
      };
    }
    if (this.wantMaybeSingle) {
      if (rows.length === 0) return { data: null, error: null, count: 0 };
      if (rows.length === 1) return { data: rows[0] as T, error: null, count: 1 };
      return {
        data: null,
        error: { message: "JSON object requested, multiple rows returned", code: "PGRST116" },
        count: rows.length,
      };
    }
    return { data: rows as unknown as T, error: null, count };
  }

  private shapeWrite(rows: any[], count: number): PgRestResult<T> {
    if (this.selectCalled) {
      // RETURNING was requested
      if (this.wantSingle) return this.shapeRead(rows, count);
      return { data: (rows.length ? rows : null) as unknown as T, error: null, count };
    }
    return { data: null, error: null, count };
  }

  then<TResult1 = PgRestResult<T>, TResult2 = never>(
    onfulfilled?: ((value: PgRestResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/** Entry point mirroring `supabase.from(table)`. */
export function from<T = any>(table: string): QueryBuilder<T> {
  return new QueryBuilder<T>(table);
}
