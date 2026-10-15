# DB Connection — Detail Guide (Control Plane = NEON only)

> ⚠ PEHLE YEH SAMAJH LEIN — **Control Plane (CP) aur mobile apps sirf EK
> database use karte hain: NEON.** CP mein **koi Supabase NAHI** hai — na
> data ke liye, na login ke liye. Mobile **Admin app ka login bhi isi Neon
> database** se hota hai (nayi `mobile_admins` table).
>
> | Service | Kya rakhti hai | CP env | Status |
> |---|---|---|---|
> | **NEON** | Business DATA (users, conversations, billing, analytics) **+ mobile Admin login** (`mobile_admins`) | `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`PGSSLMODE` | ✅ already connected (portals chal rahe hain) |
>
> **Sab se aham:** CP ka database **Neon** hai aur **pehle se juda hua hai**
> (agar portals mein data aa raha hai to connection theek hai). Isliye
> `DB_HOST` waghera **BADALNE KI ZAROORAT NAHI**. Mobile Admin login ke liye
> **koi naya env var NAHI** chahiye — sirf ek **one-time bootstrap** command
> chalani hai (HISAA 2) jo Neon mein admin account bana deti hai.
>
> **Website ka admin panel / CMS** abhi bhi Supabase use karta hai — woh ek
> **alag system** hai aur usay chhedne ki zaroorat nahi. Yeh guide sirf
> **CP + mobile** ke liye hai (jo 100% Neon hain).

---

# HISAA 1 — NEON database connection (business data + admin login)

## Kya yeh already theek hai?

Agar aap ke customer portal / dashboard mein **data aa raha hai** (conversations,
contacts, billing), to CP ka Neon connection **pehle se sahi hai** — aap ko
HISAA 1 mein **kuch nahi karna**. Seedha HISAA 2 (admin bootstrap) par jayen.

Neeche wale steps sirf tab karein agar:
- portals khaali hain / "database unavailable" aata hai, ya
- aap nayi Vercel project bana rahe hain, ya
- DB password reset kiya hai.

## STEP 1 — Neon connection string nikalna

1. https://console.neon.tech kholein → login.
2. Apna **OmniFlow project** select karein.
3. Dashboard par **"Connect"** ya **"Connection Details"** / **"Connection
   string"** ka box milega.
4. Wahan 4 cheezein choose hoti hain:
   - **Branch**: `main` (default)
   - **Role**: jo role aap use karte hain (aksar `neondb_owner` ya custom)
   - **Database**: aksar `neondb`
   - **Pooled connection**: toggle
5. Connection string copy karein. Aisi dikhti hai:

```
postgresql://neondb_owner:MyPassword123@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
```

⚠ **Pooled vs Direct** (Neon mein `-pooler` suffix):
- CP **session advisory locks** use karta hai. Agar pooled (`-pooler`) string
  se koi lock/transaction error aaye, to Neon console mein **"Pooled
  connection" toggle OFF** kar ke **direct** string lein (host bina `-pooler`
  ke: `ep-cool-name-123456.us-east-2.aws.neon.tech`).
- Jo string aap ke CP mein **abhi chal rahi hai** wohi sab se behtar hai —
  usay badlein mat jab tak koi error na ho.

## STEP 2 — String ko 6 env vars mein todna

Formula: `postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require`

Upar wale example se:

| Env var | Value (example) | Kahan se |
|---|---|---|
| `DB_USER` | `neondb_owner` | `//` ke baad, `:` se pehle |
| `DB_PASSWORD` | `MyPassword123` | `:` ke baad, `@` se pehle |
| `DB_HOST` | `ep-cool-name-123456-pooler.us-east-2.aws.neon.tech` | `@` ke baad, `/` se pehle |
| `DB_NAME` | `neondb` | aakhri `/` ke baad, `?` se pehle |
| `DB_PORT` | `5432` | (Neon hamesha 5432; string mein aksar nahi dikhta) |
| `PGSSLMODE` | `require` | (Neon SSL zaroori karta hai — fixed) |

**Note:** Neon ka host lamba hota hai (`ep-....neon.tech`). Poora host copy
karein — `postgresql://` ya `/neondb?sslmode=require` hissa DB_HOST mein
NAHI jata.

## STEP 3 — Neon password (agar string mein hidden ho)

Neon console mein connection string ke paas password dikhta hai, ya:
1. Console → **Roles** → apna role → **Reset password**.
2. Naya password copy karein → `DB_PASSWORD` mein daalein.
⚠ Reset se purana password turant bekaar — agar kahin aur wahi chal raha
tha to wahan bhi update karein.

## STEP 4 — Vercel CP project mein daalna

1. https://vercel.com → **CP (omniflow-backend)** project (website wala NAHI).
2. **Settings → Environment Variables**.
3. Yeh 6 entries (Production + Preview + Development teeno tick):

```
DB_HOST      = ep-cool-name-123456-pooler.us-east-2.aws.neon.tech
DB_PORT      = 5432
DB_NAME      = neondb
DB_USER      = neondb_owner
DB_PASSWORD  = MyPassword123
PGSSLMODE    = require
```
(apni STEP 1–3 wali asal values.) Agar yeh pehle se maujood hain aur portals
chal rahe hain, to **chhedne ki zaroorat nahi** — sirf confirm karein ke
`DB_HOST` `*.neon.tech` hai.

⚠ **CP mein `SUPABASE_URL` / `SUPABASE_ANON_KEY` NAHI daalni.** CP 100% Neon
hai. (Yeh vars sirf **website** project mein rehti hain — alag system.)

4. **Save** → **Deployments → latest → ⋯ → Redeploy**.

---

# HISAA 2 — Mobile Admin account (Neon, one-time bootstrap)

Mobile **Admin app** ka login **isi Neon database** se hota hai. Is ke liye
**koi naya env var NAHI** chahiye aur **koi SQL manually NAHI** chalana —
CP pehli call par `mobile_admins` / `mobile_admin_sessions` tables **khud
bana leta hai** (lazy DDL). Aap ko sirf **ek admin account** banana hai, aur
woh bhi **ek dafa** ek **bootstrap** command se (kyun ke password server par
hash hona chahiye — plaintext kahin nahi jata).

Bootstrap endpoint aap ke **service key** (`OMNIFLOW_SERVICE_KEY`, jo CP mein
pehle se hai) se protected hai. **Yeh command app kabhi NAHI chalata** — sirf
aap, ek dafa, apne terminal se.

## STEP 5 — CP ka base URL + service key note karein

- **CP base URL**: `https://omniflow-backend.vercel.app` (apna asal CP domain).
- **Service key**: CP Vercel env mein `OMNIFLOW_SERVICE_KEY` (ya
  `OMNIFLOW_ADMIN_API_KEY`) ki value. Yeh wahi key hai jo doosre machine-facing
  routes use karte hain.

## STEP 6 — Bootstrap command chalayein (EK DAFA)

Apne terminal mein (email + ek **mazboot 8+ character** password daalein):

```bash
curl -X POST https://omniflow-backend.vercel.app/api/v1/mobile/admin/bootstrap \
  -H "X-Omniflow-Key: APNI_OMNIFLOW_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@omniflow.pk","password":"AapKaMazbootPassword!","name":"Owner"}'
```

Kamyab jawan: `{"ok": true, "email": "owner@omniflow.pk"}`.

- Yeh Neon mein `mobile_admins` row bana deta hai (password server-side hash).
- Tables pehli call par **khud** ban jati hain — alag se SQL ki zaroorat nahi.
- **Dobara chalane ki zaroorat nahi.** Agar dobara chalaen to wahi email
  upsert ho jata hai (naya password set), purane sessions bekaar nahi hote.

> Optional: agar aap tables **khud** dekhna/banana chahein to repo mein
> `db/mobile_admin.sql` maujood hai (same schema). Lekin yeh **zaroori nahi**
> — CP lazy DDL se khud bana leta hai. Account **hamesha** bootstrap se hi
> bane (plaintext password SQL mein na daalein).

## STEP 7 — Mobile Admin app mein login

Admin app kholein → STEP 6 wala **email + password** daalein → login. App
`/api/v1/mobile/admin/login` par jata hai (Neon-backed), token milta hai, aur
Overview/Users isi Neon se aate hain. **Koi Supabase involvement nahi.**

---

# Test

1. **CP zinda:** browser mein `https://omniflow-backend.vercel.app/api/v1/mobile/config`
   → JSON aaye (flags/versions) = CP up ✅.
2. **Neon data:** customer portal mein conversations dikhein = Neon connected ✅.
3. **Admin login:** mobile **Admin app → login** (STEP 6 wale creds) → Overview
   par green **"Database connected"** + users count aaye = admin auth + Neon theek ✅.

Agar `psql` install ho to Neon direct test:
```
psql "postgresql://neondb_owner:MyPassword123@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
```

---

# Common errors

| Error | Wajah | Hal |
|---|---|---|
| `password authentication failed` | Neon DB_PASSWORD ghalat/reset ke baad purana | STEP 3 → Vercel update → Redeploy |
| `connection refused`/timeout | DB_HOST ghalat ya adhoora | Poora `ep-....neon.tech` host, port 5432 |
| `database "neondb" does not exist` | DB_NAME ghalat | Neon string ke `/` ke baad wala exact naam |
| `role "..." does not exist` | DB_USER ghalat | Neon role ka exact naam |
| advisory-lock / transaction error | pooled (`-pooler`) string session locks ke sath | Neon console mein Pooled OFF → **direct** string |
| Bootstrap `403 Service key required` | `X-Omniflow-Key` missing/ghalat | CP env `OMNIFLOW_SERVICE_KEY` ki sahi value header mein |
| Mobile Admin login `401` | Bootstrap nahi kiya, ya ghalat email/password | STEP 6 bootstrap chalayein, phir sahi creds se login |
| Admin `503 Database unavailable` | Neon DB_* env missing/ghalat | HISAA 1 STEP 4 → Redeploy |
| Env ke baad bhi purana | Redeploy nahi kiya | Deployments → Redeploy |

---

# Cheat sheet

```
NEON (EK hi database = business data + mobile admin login):
postgresql://neondb_owner:PASS@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
              └─ DB_USER ─┘ └PASS┘ └──────────── DB_HOST ────────────┘ └DB_NAME┘

  Vercel CP env (sirf yeh 6 — koi SUPABASE_URL/ANON_KEY NAHI):
    DB_HOST=ep-cool-123-pooler.us-east-2.aws.neon.tech  DB_PORT=5432
    DB_NAME=neondb  DB_USER=neondb_owner  DB_PASSWORD=PASS  PGSSLMODE=require
  → Save → Deployments → Redeploy

MOBILE ADMIN ACCOUNT (ek dafa, terminal se — app kabhi nahi):
  curl -X POST https://omniflow-backend.vercel.app/api/v1/mobile/admin/bootstrap \
    -H "X-Omniflow-Key: <OMNIFLOW_SERVICE_KEY>" -H "Content-Type: application/json" \
    -d '{"email":"owner@omniflow.pk","password":"<8+ strong>","name":"Owner"}'
  → tables khud ban jati hain; Admin app mein isi email/password se login.

WEBSITE admin panel/CMS = Supabase (ALAG system, CP se unrelated) — chhedna nahi.
```
