/**
 * §276 — Neon shim rig: proves lib/db/neon.ts (Supabase-compatible query
 * builder) + lib/db/auth.ts (Neon admin auth) against a REAL Postgres
 * (pgserver) with db/website_neon.sql applied. DATABASE_URL must point at the
 * live DB before this runs (the python runner sets it).
 *
 * Run: npx tsx tools/website-testrig/test_neon_shim.ts   (DATABASE_URL set)
 */
import { from, neonQuery, neonEnabled } from "../../lib/db/neon";
import {
  hashPassword,
  verifyPassword,
  upsertAdminUser,
  verifyLogin,
  createSession,
  getUserBySession,
  revokeSession,
  changePassword,
} from "../../lib/db/auth";

let pass = 0;
const fails: string[] = [];
function check(ok: boolean, label: string, extra = "") {
  if (ok) pass++;
  else fails.push(label + (extra ? ` [${extra}]` : ""));
}
const iso = () => new Date().toISOString();

async function main() {
  check(neonEnabled(), "DATABASE_URL is set (neon enabled)");

  // ---- site_content: upsert (PK inference) + read back --------------------
  {
    const w = await from("site_content").upsert({
      section: "hero",
      data: { h1: "Hello", bullets: ["a", "b"] },
      updated_at: iso(),
    });
    check(!w.error, "site_content upsert (no onConflict -> PK) has no error", JSON.stringify(w.error));
    const r = await from("site_content").select("data").eq("section", "hero").single();
    check(!r.error && r.data?.data?.h1 === "Hello", "site_content read back JSONB h1", JSON.stringify(r.data));
    check(Array.isArray(r.data?.data?.bullets) && r.data.data.bullets.length === 2, "site_content JSONB array round-trips");
  }
  // upsert again = update path
  {
    await from("site_content").upsert({ section: "hero", data: { h1: "Updated" }, updated_at: iso() });
    const r = await from("site_content").select("data").eq("section", "hero").single();
    check(r.data?.data?.h1 === "Updated", "site_content upsert updates existing row");
    const cnt = await neonQuery("SELECT count(*)::int AS n FROM site_content WHERE section='hero'");
    check(cnt.rows[0].n === 1, "site_content upsert did not duplicate (PK conflict resolved)");
  }
  // maybeSingle missing -> null, no error
  {
    const r = await from("site_content").select("data").eq("section", "does-not-exist").maybeSingle();
    check(r.data === null && r.error === null, "maybeSingle on missing row -> data null, error null");
  }
  // single missing -> error PGRST116
  {
    const r = await from("site_content").select("data").eq("section", "does-not-exist").single();
    check(r.data === null && r.error?.code === "PGRST116", "single on missing row -> PGRST116 error", JSON.stringify(r.error));
  }

  // ---- blog_posts: upsert(onConflict slug) + list + delete ----------------
  {
    const w = await from("blog_posts").upsert(
      {
        slug: "hello-world",
        title: "Hello World",
        excerpt: "ex",
        category: "AI Automation",
        author: "OmniFlow Team",
        reading_minutes: 5,
        content: "body",
        status: "published",
        published_at: iso(),
        updated_at: iso(),
      },
      { onConflict: "slug" }
    );
    check(!w.error, "blog_posts upsert(onConflict slug) no error", JSON.stringify(w.error));
    // upsert same slug again -> update, not duplicate
    await from("blog_posts").upsert(
      { slug: "hello-world", title: "Hello World v2", content: "body2", status: "published", updated_at: iso() },
      { onConflict: "slug" }
    );
    const list = await from("blog_posts").select("*").eq("status", "published").order("published_at", { ascending: false }).limit(50);
    check(!list.error && Array.isArray(list.data) && list.data.length === 1, "blog list returns 1 published post", JSON.stringify(list.data?.length));
    check((list.data as any[])[0]?.title === "Hello World v2", "blog upsert updated title via onConflict");
    const del = await from("blog_posts").delete().eq("slug", "hello-world");
    check(del.count === 1, "blog delete by slug removed 1 row", String(del.count));
    const after = await from("blog_posts").select("slug").eq("slug", "hello-world").maybeSingle();
    check(after.data === null, "blog row gone after delete");
  }

  // ---- site_settings: single row update + read ----------------------------
  {
    const u = await from("site_settings").update({ meta_title: "OmniFlow", site_url: "https://omniflow.test", updated_at: iso() }).eq("id", 1);
    check(u.count === 1 && !u.error, "site_settings update id=1 affects 1 row", String(u.count));
    const r = await from("site_settings").select("*").eq("id", 1).single();
    check(r.data?.meta_title === "OmniFlow" && r.data?.site_url === "https://omniflow.test", "site_settings read back updated values");
  }

  // ---- leads: insert + unique violation (23505) + list + update + delete --
  let leadId: number | null = null;
  {
    const ins = await from("leads").insert({ name: "Ali", email: "ali@x.c", company: null });
    check(!ins.error && ins.count === 1, "leads insert ok", JSON.stringify(ins.error));
    // duplicate email -> unique violation surfaced as error.code 23505
    const dup = await from("leads").insert({ name: "Ali2", email: "ali@x.c", company: null });
    check(dup.error?.code === "23505", "leads duplicate email -> error.code 23505", JSON.stringify(dup.error));
    const list = await from("leads").select("status, created_at").order("created_at", { ascending: false }).limit(100);
    check(!list.error && Array.isArray(list.data) && list.data.length >= 1, "leads list (col subset) returns rows");
    check(!!list.data && Object.keys((list.data as any[])[0]).sort().join(",") === "created_at,status", "leads select('status, created_at') returns only those cols", JSON.stringify(Object.keys((list.data as any[])[0] || {})));
    const one = await from("leads").select("id").eq("email", "ali@x.c").single();
    leadId = one.data?.id ?? null;
    check(leadId !== null, "leads single() returns the row id");
    if (leadId !== null) {
      const up = await from("leads").update({ status: "contacted" }).eq("id", leadId);
      check(up.count === 1, "leads update by id", String(up.count));
      const del = await from("leads").delete().eq("id", leadId);
      check(del.count === 1, "leads delete by id", String(del.count));
    }
  }

  // ---- identifier safety: unsafe column is rejected, not executed ---------
  {
    const r = await from("leads").select("id; DROP TABLE leads").eq("id", 1);
    check(r.error !== null, "unsafe column identifier rejected with error", JSON.stringify(r.error));
    const still = await neonQuery("SELECT to_regclass('leads')::text AS t");
    check(still.rows[0].t === "leads", "leads table survived injection attempt");
  }

  // ---- auth: password hashing ---------------------------------------------
  {
    const h = await hashPassword("S3cure-pass!");
    check(h.startsWith("scrypt$"), "hashPassword produces scrypt$ format");
    check(await verifyPassword("S3cure-pass!", h), "verifyPassword accepts correct password");
    check(!(await verifyPassword("wrong", h)), "verifyPassword rejects wrong password");
    check(!(await verifyPassword("S3cure-pass!", "garbage")), "verifyPassword rejects malformed hash");
  }

  // ---- auth: admin user + login + profiles view ---------------------------
  let adminId: string | null = null;
  {
    const u = await upsertAdminUser("owner@omniflow.pk", "S3cure-pass!", "admin");
    check(u !== null && u.role === "admin", "upsertAdminUser creates admin", JSON.stringify(u));
    adminId = u?.id ?? null;
    // idempotent upsert (same email, new password)
    const u2 = await upsertAdminUser("owner@omniflow.pk", "N3w-pass!xyz", "admin");
    check(u2?.id === adminId, "upsertAdminUser is idempotent by email (same id)");
    const good = await verifyLogin("owner@omniflow.pk", "N3w-pass!xyz");
    check(good !== null && good.email === "owner@omniflow.pk", "verifyLogin accepts new password");
    check((await verifyLogin("owner@omniflow.pk", "S3cure-pass!")) === null, "verifyLogin rejects old password after upsert");
    check((await verifyLogin("ghost@omniflow.pk", "N3w-pass!xyz")) === null, "verifyLogin rejects unknown email");
    // profiles view read (the website role gate)
    if (adminId) {
      const prof = await from("profiles").select("role").eq("id", adminId).single();
      check(prof.data?.role === "admin", "profiles VIEW returns role for admin id", JSON.stringify(prof.data));
    }
  }

  // ---- auth: sessions ------------------------------------------------------
  {
    check(adminId !== null, "have adminId for session tests");
    const s = await createSession(adminId!);
    check(s !== null && typeof s.token === "string" && s.token.length > 20, "createSession returns opaque token");
    const u = await getUserBySession(s!.token);
    check(u !== null && u.email === "owner@omniflow.pk", "getUserBySession resolves token -> user");
    check((await getUserBySession("garbage-token")) === null, "getUserBySession rejects garbage token");
    await revokeSession(s!.token);
    check((await getUserBySession(s!.token)) === null, "getUserBySession null after revokeSession");
  }

  // ---- auth: changePassword revokes sessions -------------------------------
  {
    const s = await createSession(adminId!);
    const okChange = await changePassword(adminId!, "F1nal-pass!xyz");
    check(okChange, "changePassword returns true");
    check((await verifyLogin("owner@omniflow.pk", "F1nal-pass!xyz")) !== null, "login works with new password");
    check((await verifyLogin("owner@omniflow.pk", "N3w-pass!xyz")) === null, "login fails with old password after change");
    check((await getUserBySession(s!.token)) === null, "changePassword revoked existing sessions");
  }

  // ---- summary -------------------------------------------------------------
  const total = pass + fails.length;
  console.log(`\n[test_neon_shim] ${pass}/${total} checks passed`);
  if (fails.length) {
    console.log("FAILED CHECKS:");
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL NEON SHIM CHECKS PASSED");
}

main().catch((e) => {
  console.error("RIG CRASHED:", e);
  process.exit(2);
});
