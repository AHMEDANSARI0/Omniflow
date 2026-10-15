# §276 — Website: Supabase → Neon (poora migration guide, rev §276r2)

Ye batch website ko **Supabase se hata kar sirf NEON** par le aata hai — admin
login, marketing CMS (`site_content`), blog (`blog_posts`), SEO settings
(`site_settings`) aur leads (`leads`). Ab website, Control Plane aur mobile —
teeno ek hi Neon database use karte hain. **Koi Supabase nahi bachta.**

> Commands **Windows PowerShell** ke liye hain (office PC). Har step ka poora
> output/error mujhe bhej dein agar atkein. Order skip na karein.

---

## Kya badla (ek nazar me)

- **Admin login** ab Neon `admin_users` + httpOnly session cookie
  (`of_admin_session`) se hota hai; password scrypt hash. Purane Supabase
  passwords **portable nahi** — is liye Step 2 me **naya admin** banta hai.
- **CMS/blog/SEO/leads** wahi tables, ab Neon me. Purana data Step 2 copy karta hai.
- **`/api/bot/config` + `/api/bot/messages`** ab **410 Gone** (bot Control
  Plane ka `/api/v1/connector/whatsapp/*` use karta hai).
- **Lead "invite"** disabled — client portal accounts Control Plane banata hai.
- Jo files badli: `lib/db/{neon,auth}.ts`, `lib/admin-actions.ts`,
  `lib/supabase/{server,service,client}.ts`, `lib/{content,settings,blog}.ts`,
  `lib/bot-api.ts`, `app/actions/early-access.ts`, `app/admin/login/page.tsx`,
  `app/admin/components/SignOutButton.tsx`,
  `app/admin/(panel)/settings/PasswordForm.tsx`,
  `app/admin/(panel)/leads/actions.ts`, `app/api/bot/{config,messages}/route.ts`,
  `proxy.ts`, `lib/omniflow/session-constants.ts`, `package.json` + lock,
  `.env.example`, `db/website_neon.sql`.

---

## Step 0 — Patcher + npm install

Website repo root se (jis folder me `package.json` + `OmniFlow-Control-Plane/` ho):

```powershell
node PATCHERS_TO_RUN/website_neon_276r2.mjs
npm install
git add -A
git commit -m "website: Supabase -> Neon (§276r2)"
git push
```

- Patcher idempotent hai: pehle wala patcher chala tha to sirf badli files
  (SQL + ye doc) REPAIR hongi, baqi `already correct`. `warnings: 0` hona chahiye.
- `npm install` se `pg` install aur `@supabase/*` remove hota hai (package.json
  + lock patcher me synced hain). **Push se Vercel auto-deploy chalega** — lekin
  env abhi purana hai, is liye site abhi bhi Supabase-free code ke sath
  fail-soft chalegi (defaults dikhayegi) jab tak Step 3 na ho.

---

## Step 1 — Neon me schema apply karein (SQL)

**⚠️ Sabse ahem: Neon SQL Editor me `Run` dabana hai, `Explain` NAHI.**
`EXPLAIN` sirf SELECT/INSERT/UPDATE/DELETE ke liye hota hai — `CREATE TABLE`
ko EXPLAIN me wrap karne se wahi error aata hai:
`syntax error at or near "UUID" (SQLSTATE 42601)`. SQL file bilkul theek hai;
bas Run karna hai.

1. Neon console → aap ka project → **SQL Editor**.
2. `db/website_neon.sql` ki **poori** contents paste karein (repo me file hai;
   editor me khol → Ctrl+A → Ctrl+C → Neon me Ctrl+V).
3. **Run** (ya Ctrl/Cmd+Enter). "Success / no results" aayega.
4. File idempotent hai — dobara Run karna bhi safe hai (agar pehle partial
   apply hua tha to ye sab complete kar dega).

**Verify (usi SQL Editor me RUN karein):**

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('admin_users','admin_sessions','site_content',
                      'blog_posts','site_settings','leads')
 ORDER BY table_name;
/* 6 rows chahiye */

SELECT count(*) FROM site_settings;
/* 1 chahiye (seed row) */

SELECT count(*) FROM profiles;
/* view hai - error ke baghair chalna chahiye (0 ok) */
```

Alternative (agar console tang kare): repo root se

```powershell
psql "postgresql://USER:PASS@ep-NAME-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require" -f db/website_neon.sql
```

> Note: `gen_random_uuid()` Neon (PG 13+) me built-in hai — kisi extension ki
> zaroorat nahi. Region wahi rakhein jo Control Plane ke Neon ka hai.

---

## Step 2 — Purana data copy + naya admin bootstrap (EK dafa)

Ye command Supabase se CMS/blog/SEO/leads parh kar Neon me upsert karti hai
aur website admin banati hai. **Pehle values jama karein:**

| Value | Kahan se |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → project → Settings → API Keys → **Project URL** (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | usi page par **service_role** (secret) key |
| `DATABASE_URL` | Neon console → project → **Connection string (pooled)** — host me `-pooler` ho aur `sslmode=require` |
| `MIGRATE_ADMIN_EMAIL` | jo email aap `/admin/login` par use karna chahte hain |
| `MIGRATE_ADMIN_PASSWORD` | aap ka chuna **8+ character** password |

**PowerShell me (repo root se):**

```powershell
$env:SUPABASE_URL="https://<ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
$env:DATABASE_URL="postgresql://USER:PASS@ep-NAME-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require"
$env:MIGRATE_ADMIN_EMAIL="owner@omniflow.pk"
$env:MIGRATE_ADMIN_PASSWORD="AapKaMazboot8+Password"
npx tsx tools/website-migrate/migrate-supabase-to-neon.ts
```

(`npx tsx` pehli dafa tsx download karega — `Ok to proceed? (y)` dabayein.)

**Expected output:**

```
§276 Supabase → Neon website migration
+ site_content: N/N rows upserted into Neon.
+ blog_posts: N/N rows upserted into Neon.
+ site_settings: 1/1 rows upserted into Neon.
+ leads: N/N rows upserted into Neon.
+ admin: owner@omniflow.pk ready — sign in at /admin/login.
```

- `X <table>: skipped …` = wo table Supabase me tha hi nahi — **theek hai**,
  baqi tables chalti rehti hain.
- `= <table>: 0 rows` = table khali tha — theek hai.
- Script **idempotent** hai: dobara chalane se duplicate nahi bante; admin ka
  password dobara set ho jata hai (bhool jayein to yehi command phir chalein).

**Baad me:** terminal window **band kar dein** — `SUPABASE_*` vars sirf us
window me the, band hote hi khatam. (Live site ko ye kabhi nahi chahiye.)

---

## Step 3 — Vercel website env (Supabase vars hatao, Neon add karo)

Vercel → **website** project → Settings → Environment Variables:

**REMOVE karein (har environment se — Production/Preview/Development):**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

**ADD karein:**

| Name | Value | Environment |
|---|---|---|
| `DATABASE_URL` | Neon **pooled** string (`...-pooler...?sslmode=require`) — wahi jo Step 2 me thi | Production (+ Preview agar use hota hai) |

**CONFIRM karein (pehle se hone chahiye):**
`OMNIFLOW_CONTROL_PLANE_URL`, `OMNIFLOW_SERVICE_KEY`, `OF_ANALYTICS_SALT`,
`CRON_SECRET`. Optional: `OF_WEB_SESSION_TTL_DAYS` (default 30).

**Settings → General → Function Region** = wahi region jo Neon project ka hai.

**Phir redeploy:** Deployments → latest → **••• → Redeploy** →
**"Use existing Build Cache" UNCHECK** karein → Redeploy. `Ready` hone dein.

> Pooled string hi use karein (direct nahi): Vercel serverless par direct
> connections jaldi exhaust hoti hain. Neon me **Scale to zero OFF** rakhein
> (Settings → Compute) taake portal/website fast rahe.

---

## Step 4 — Verify (poori checklist)

1. `https://<website>/admin/login` → Step-2 wale **email + password** se
   sign in → admin panel khule.
2. Admin → **Content** → Hero (ya koi section) → ek word badal → **Save** →
   public homepage khol → change dikhe. (Turant dikhe; cache tag refresh hota hai.)
3. `https://<website>/blog` → migrated posts list hon; ek post khol → poori
   render ho. (Supabase me blog khali tha to 3 seed articles dikhenge — normal.)
4. Public site → **early-access form** → apna naam/email submit → Admin →
   **Leads** → entry aaye (status `new`) → status change karein → delete karein.
   Wahi email dobara submit karein → "already on the list" message aaye.
5. Admin → **Settings** → password change → "Password updated successfully" →
   aap **signed in rahein** → Sign out → `/admin/login` par jaye → **naye**
   password se login ho.
6. SEO: homepage par right-click → View Page Source → `<title>` me aap ki
   settings/migration wali meta title ho.
7. `https://<website>/api/bot/config` → `{"error":"gone",...}` (410) — ye
   **expected** hai (bot ab CP use karta hai).

Sab green = website poori tarah Neon par. **Supabase project abhi delete na
karein** — 3-4 din backup ke taur par rakhein, phir hata dein.

---

## Troubleshooting

| Masla | Wajah / hal |
|---|---|
| `syntax error at or near "UUID"` (SQL Editor) | Aap ne **Explain** dabaya — **Run** dabayein. DDL EXPLAIN nahi hota. |
| Admin login: "Invalid email or password" | Admin bana nahi ya password galat. Step 2 command dobara chalein (output me `+ admin: ... ready` dekhein). Purane Supabase password se login **nahi** hoga — naya Neon admin use karein. |
| Site chal rahi hai magar admin edits public par nahi dikhte / content defaults hain | Vercel me `DATABASE_URL` set nahi ya redeploy nahi hua. Env confirm → Redeploy (cache unchecked). Vercel → Functions logs me `pg` error ho to connection string check karein (`-pooler`, `sslmode=require`). |
| Vercel build fail: `Cannot find module 'pg'` | `npm install` ke baad `git add -A` (lock file bhi) commit/push nahi hua. Local me `npm install` → `git add -A` → push. |
| Migration: `DATABASE_URL (Neon) is not set` | Ussi PowerShell window me `$env:DATABASE_URL=...` set karein (Step 2) — doosri window me vars nahi hote. |
| Migration: `SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required` | Step 2 ke pehle do vars usi window me set karein; URL me trailing `/` na ho. |
| Migration: `X <table>: skipped — 404/401 …` | 404 = wo table Supabase me nahi (ignore). 401/403 = service_role key galat — Settings → API Keys se **secret** service_role copy karein (anon nahi). |
| Patcher: `Run this from the website repo root…` | Aap galat folder me hain — us folder se chalein jahan `package.json` + `OmniFlow-Control-Plane/` ho. |
| Kuch bhi ulta ho jaye | Har file ka backup `.pre_276.bak` / `.pre_276r2.bak` me hai; env switch tak purani Supabase deployment chalti rehti hai; Supabase project abhi delete na karein. |

---

## Chhote notes

- `profiles` ek **VIEW** hai `admin_users` par (purani code ke role checks
  unchanged chalte hain); is me direct insert nahi hota.
- `site_settings` single-row (`id = 1`, CHECK guarded); khali values par code
  apne defaults merge karta hai.
- `leads.email` UNIQUE hai — duplicate signup par friendly message (23505 handle).
- Session cookie httpOnly + secure (production) + sameSite=lax, TTL 30 din
  (`OF_WEB_SESSION_TTL_DAYS` se badal sakte hain). Password change karne par
  purane sessions revoke + naya session turant mil jata hai (signed in rahte hain).

---

## §276r4 — Option B: Neon-only admin bootstrap (Supabase ka koi zikr nahi)

Agar Supabase se purana data copy karne ki zaroorat nahi (ya Supabase project band ho
chuka hai), to migration script bilkul skip karein. Sirf admin user banane ke liye ye
Neon-only bootstrap kafi hai — isme Supabase ke ZERO variables lagte hain:

PowerShell / CMD (repo root, ek ek line):

    set DATABASE_URL=postgresql://<neon-pooled-url>?sslmode=require
    set MIGRATE_ADMIN_EMAIL=apna-admin-email
    set MIGRATE_ADMIN_PASSWORD=apna-strong-password-8+
    npx tsx tools/website-migrate/bootstrap-admin.ts

Expected output:

    + admin: apna-admin-email ready (role=admin)
      Sign in at /admin/login with these credentials.

Idempotent: dobara chalane par usi email ka password reset ho jata hai.
Pehle `db/website_neon.sql` RUN ho chuka hona zaroori hai (6 tables verify).

Note: migration script (`migrate-supabase-to-neon.ts`) me SUPABASE_URL /
SUPABASE_SERVICE_ROLE_KEY sirf EK DAFE purana data PARHNE ke liye hote hain
(leads/content/blog copy). Website ya app code Supabase ko kabhi touch nahi karta.
Data copy na chahiye to wo script optional hai; bootstrap ke baad site poori tarah
Neon par chalti hai.
