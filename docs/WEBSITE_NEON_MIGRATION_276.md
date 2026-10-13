# §276 — Website: Supabase → Neon (poora migration guide)

Ye batch website ko **Supabase se hata kar sirf NEON** par le aata hai — admin
login, marketing CMS (`site_content`), blog (`blog_posts`), SEO settings
(`site_settings`) aur leads (`leads`). Ab website, Control Plane aur mobile —
teeno ek hi Neon database use karte hain. **Koi Supabase nahi bachta.**

> Order follow karein. Har step ka output/error mujhe bhej dein agar atke.

---

## Pehle samajh lein — kya badla

- **Admin login** ab Supabase Auth ki jagah Neon `admin_users` + ek httpOnly
  session cookie (`of_admin_session`) use karta hai. Password scrypt se hash
  hota hai. Purane Supabase passwords **portable nahi** (bcrypt ≠ scrypt), is
  liye ek **naya admin** bootstrap karna hota hai (Step 2 me).
- **CMS/blog/SEO/leads** wahi tables, ab Neon me. Data Supabase se copy hota
  hai (Step 2).
- **`/api/bot/*`** (purane website-hosted bot ke endpoints) ab **410 Gone**
  dete hain — bot ab Control Plane ke `/api/v1/connector/whatsapp/*` use karta
  hai. Website ke bot routes dead legacy the.
- **Lead "invite"** (client portal account banana) ab disabled hai — portal
  accounts Control Plane banata hai, website DB nahi. Button gracefully message
  dega.

Files jo badli (patcher in sab ko likh dega): `lib/db/neon.ts`,
`lib/db/auth.ts`, `lib/admin-actions.ts`, `lib/supabase/{server,service,client}.ts`,
`lib/{content,settings,blog}.ts`, `lib/bot-api.ts`, `app/actions/early-access.ts`,
`app/admin/login/page.tsx`, `app/admin/components/SignOutButton.tsx`,
`app/admin/(panel)/settings/PasswordForm.tsx`, `app/admin/(panel)/leads/actions.ts`,
`app/api/bot/{config,messages}/route.ts`, `proxy.ts`,
`lib/omniflow/session-constants.ts`, `package.json`, `.env.example`,
`db/website_neon.sql`.

---

## Step 0 — Patcher chalayein (code + SQL + docs website repo me laata hai)

Website repo root se (jis folder me `package.json` + `OmniFlow-Control-Plane/`
ho):

```
node PATCHERS_TO_RUN/website_neon_276.mjs
```

Ye har file backup ke saath likhta hai (`.pre_276.bak`), sha verify karta hai,
aur dobara chalane par "already correct" kehta hai. Output me
`applied / already / warnings` dekhein. `warnings: 0` hona chahiye.

Phir dependencies install karein (package.json se `@supabase/*` gaya, `pg`
aaya):

```
npm install
```

---

## Step 1 — Neon database me SQL apply karein

`db/website_neon.sql` idempotent hai (baar baar chalane par safe). Neon console
→ aap ka project → **SQL Editor** me poori file paste karke **Run**. Ya local
psql se:

```
psql "postgresql://USER:PASS@ep-<name>-pooler.<region>.aws.neon.tech/<db>?sslmode=require" -f db/website_neon.sql
```

Ye banata hai: `admin_users`, `admin_sessions`, `profiles` (VIEW),
`site_content`, `blog_posts`, `site_settings` (1 seed row), `leads`.

> **Note:** Ye wahi Neon project ho sakta hai jo Control Plane use karta hai
> (tables alag hain, koi takraav nahi) — ya ek alag Neon project. Dono chalega.
> Region wahi rakhein jo CP ka hai (speed ke liye).

---

## Step 2 — Purana data copy karein + naya admin banayein (EK dafa)

Ye script Supabase se CMS/blog/SEO/leads parh kar Neon me upsert karti hai, aur
ek naya website admin bootstrap karti hai. Repo root se:

```
SUPABASE_URL="https://<project>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
DATABASE_URL="postgresql://USER:PASS@ep-<name>-pooler.<region>.aws.neon.tech/<db>?sslmode=require" \
MIGRATE_ADMIN_EMAIL="owner@omniflow.pk" \
MIGRATE_ADMIN_PASSWORD="AapKaMazbootPassword!" \
node_modules/.bin/tsx tools/website-migrate/migrate-supabase-to-neon.ts
```

- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`: Supabase dashboard → Settings →
  API se (ye **sirf migration ke liye** hain; live site ko nahi chahiye).
- `MIGRATE_ADMIN_PASSWORD`: **8+ characters**. Yehi email/password Step 5 me
  `/admin/login` par use hoga.
- Script idempotent hai — dobara chalayein to same data upsert ho jata hai, admin
  password refresh ho jata hai.

Output me har table ki line dekhein (`+ site_content: N/N rows…`, `+ admin:
… ready`). Koi table Supabase me na ho to `X … skipped` aayega — baqi tables
chalti rehti hain.

---

## Step 3 — Vercel website env badlein (Supabase → Neon)

Vercel → **website** project → Settings → Environment Variables:

**HATA dein (Supabase):**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

**ADD karein (Neon):**
| Name | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (`...-pooler...?sslmode=require`) |

**Pehle se maujood (confirm, chherna nahi):**
`OMNIFLOW_CONTROL_PLANE_URL`, `OMNIFLOW_SERVICE_KEY`, `OF_ANALYTICS_SALT`,
`CRON_SECRET`. Optional: `OF_WEB_SESSION_TTL_DAYS` (default 30).

> Region: website project ka Function Region **wahi** rakhein jo Neon/CP ka hai.

---

## Step 4 — Website redeploy karein

Env badalne ke baad Vercel me website project → Deployments → latest → **••• →
Redeploy** (env changes sirf redeploy ke baad apply hote hain). Deploy complete
hone dein.

---

## Step 5 — Verify karein

1. `https://<website>/admin/login` → Step 2 wale **email + password** se sign in.
   Panel khulna chahiye.
2. Admin → Content → koi section (Hero/Footer) edit karke Save → public page par
   change dikhe (cache tag refresh hota hai).
3. `https://<website>/blog` → posts render hon (Neon se; na hon to seed fallback).
4. Public site par early-access form bharein → Admin → Leads me entry aaye.
5. Sign out → wapas `/admin/login`.

Sab chal gaya to **Supabase ke vars poori tarah hata chuke** hain — website ab
sirf Neon par hai.

---

## Rollback / safety

- Patcher ne har badli file ka `.pre_276.bak` backup rakha hai. Kuch galat lage
  to backup se wapas la sakte hain.
- Jab tak Step 3 me env switch nahi karte, purani Supabase deployment chalti
  rehti hai. Switch ek hi redeploy me hota hai.
- Migration script fail-soft hai: ek table na chale to baqi copy ho jati hain;
  dobara chalana safe hai.

## Chhote notes

- `profiles` ek **VIEW** hai `admin_users` par (purane code ko `role` milta
  rahe). Isme direct insert nahi hota.
- `site_settings` single-row table hai (`id = 1`, CHECK se guarded).
- Leads ka `email` UNIQUE hai — duplicate signup par friendly "already on the
  list" message aata hai (code 23505 handle hota hai).
