/**
 * §276 — ONE-TIME Supabase → Neon data migration for the website.
 *
 * Copies the marketing CMS (`site_content`), blog (`blog_posts`), SEO
 * (`site_settings`) and captured `leads` out of the old Supabase project and
 * upserts them into Neon. Idempotent (safe to re-run) and fail-soft per table.
 *
 * Supabase admin AUTH users are NOT copied: their password hashes (bcrypt) are
 * not portable to the Neon scrypt scheme. Instead this script bootstraps a
 * fresh website admin (MIGRATE_ADMIN_EMAIL / MIGRATE_ADMIN_PASSWORD) so you can
 * sign in at /admin/login immediately after the switch.
 *
 * Reads Supabase over its REST API with the SERVICE ROLE key (no Supabase SDK —
 * the website no longer depends on one) and writes to Neon through the same
 * tested shim the site uses (lib/db/neon.ts).
 *
 * Run from the website repo root (needs DATABASE_URL already applied with
 * db/website_neon.sql):
 *
 *   SUPABASE_URL="https://<project>.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
 *   DATABASE_URL="postgresql://...neon...?sslmode=require" \
 *   MIGRATE_ADMIN_EMAIL="owner@omniflow.pk" \
 *   MIGRATE_ADMIN_PASSWORD="<8+ chars>" \
 *   node_modules/.bin/tsx tools/website-migrate/migrate-supabase-to-neon.ts
 *
 * After it prints OK, the Supabase vars can be discarded — the live site needs
 * only DATABASE_URL.
 */
import { from, neonEnabled } from "../../lib/db/neon";
import { upsertAdminUser } from "../../lib/db/auth";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ""
).replace(/\/$/, "");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  "";
const ADMIN_EMAIL = process.env.MIGRATE_ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.MIGRATE_ADMIN_PASSWORD || "";

const PAGE = 1000;

type Row = Record<string, unknown>;

/** Pick only the whitelisted columns that exist in the Neon schema. */
function pick(row: Row, cols: string[]): Row {
  const out: Row = {};
  for (const c of cols) {
    if (row[c] !== undefined) out[c] = row[c];
  }
  return out;
}

/** Fetch every row of a Supabase table, paginating with the Range header. */
async function fetchAll(table: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=*`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Range: `${offset}-${offset + PAGE - 1}`,
        },
      }
    );
    if (!res.ok) {
      throw new Error(`GET ${table} → ${res.status} ${await res.text()}`);
    }
    const batch = (await res.json()) as Row[];
    if (!Array.isArray(batch)) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function migrateTable(
  label: string,
  table: string,
  cols: string[],
  onConflict: string,
  transform?: (row: Row) => Row
): Promise<void> {
  try {
    const source = await fetchAll(table);
    if (source.length === 0) {
      console.log(`= ${label}: 0 rows in Supabase — nothing to copy.`);
      return;
    }
    let written = 0;
    for (const raw of source) {
      const row = transform ? transform(pick(raw, cols)) : pick(raw, cols);
      // site_settings is a single fixed row (id = 1) in Neon.
      const { error } = await from(table).upsert(row, { onConflict });
      if (error) {
        console.log(`! ${label}: upsert failed for a row — ${error.message}`);
        continue;
      }
      written += 1;
    }
    console.log(`+ ${label}: ${written}/${source.length} rows upserted into Neon.`);
  } catch (err) {
    console.log(
      `X ${label}: skipped — ${(err as Error).message}. ` +
        `(Table missing or unreadable in Supabase; other tables continue.)`
    );
  }
}

async function bootstrapAdmin(): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(
      "= admin: MIGRATE_ADMIN_EMAIL / MIGRATE_ADMIN_PASSWORD not set — " +
        "no website admin created. Set them and re-run, or create one later."
    );
    return;
  }
  if (ADMIN_PASSWORD.length < 8) {
    console.log("X admin: password must be 8+ characters — admin NOT created.");
    return;
  }
  try {
    const user = await upsertAdminUser(ADMIN_EMAIL, ADMIN_PASSWORD, "admin");
    if (user) {
      console.log(`+ admin: ${user.email} ready — sign in at /admin/login.`);
    } else {
      console.log("X admin: upsertAdminUser returned null (DATABASE_URL unset?).");
    }
  } catch (err) {
    console.log(`X admin: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("§276 Supabase → Neon website migration");

  if (!neonEnabled()) {
    console.error(
      "X DATABASE_URL (Neon) is not set. Apply db/website_neon.sql to Neon and " +
        "export DATABASE_URL first. Nothing was done."
    );
    process.exit(1);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      "X SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required to read the old " +
        "data (one time). Nothing was done."
    );
    process.exit(1);
  }

  // Marketing CMS sections: { section (PK), data JSONB, updated_at }.
  await migrateTable("site_content", "site_content", ["section", "data", "updated_at"], "section");

  // Blog posts: copy the editable fields; let Neon assign id/created_at.
  await migrateTable(
    "blog_posts",
    "blog_posts",
    [
      "slug",
      "title",
      "excerpt",
      "category",
      "author",
      "reading_minutes",
      "content",
      "status",
      "published_at",
    ],
    "slug"
  );

  // SEO settings: force the single row id = 1.
  await migrateTable(
    "site_settings",
    "site_settings",
    [
      "meta_title",
      "meta_description",
      "keywords",
      "og_title",
      "og_description",
      "site_url",
    ],
    "id",
    (row) => ({ id: 1, ...row })
  );

  // Captured leads: { name, email (unique), company, status, created_at }.
  await migrateTable(
    "leads",
    "leads",
    ["name", "email", "company", "status", "created_at"],
    "email"
  );

  await bootstrapAdmin();

  console.log("");
  console.log(
    "Done. Verify the site reads Neon (admin login + a blog page), then remove " +
      "the SUPABASE_* vars — the live website needs only DATABASE_URL."
  );
}

main().catch((err) => {
  console.error("X migration crashed:", err);
  process.exit(1);
});
