# OmniFlow — Complete Deployment Checklist (§275, 2026-10-13)

Har phase order se karein. Har box ✅ karte jayen. Andaza: 45–60 minute.

> ⚠ **DB rule (FINAL):** **Control Plane (CP) + mobile = sirf NEON.** CP mein
> **koi Supabase NAHI** — na data, na login. Mobile **Admin app ka login bhi
> isi Neon** se hota hai (nayi `mobile_admins` table, jo CP **khud** bana leta
> hai). Neon CP se **pehle se juda hua hai** — portals chal rahe hain to `DB_*`
> env ko **chedna nahi**. Admin account banane ke liye sirf **ek one-time
> bootstrap command** chalani hai (PHASE 4-B). Poori tafseel:
> `docs/DB_CONNECTION_GUIDE.md`.
>
> **Website ka admin panel / CMS** abhi bhi Supabase use karta hai — woh ek
> **alag system** hai (PHASE 5). CP/mobile se uska koi talluq nahi.

---

## PHASE 0 — Values nikaal kar notepad mein rakh len

**A) NEON (database + admin login)** — sirf tab chahiye agar portals mein data
NAHI aa raha (varna already set hai, skip karein). Neon console → project →
Connection string se 6 values: `DB_HOST` (`ep-....neon.tech`), `DB_PORT`
(`5432`), `DB_NAME` (aksar `neondb`), `DB_USER` (Neon role), `DB_PASSWORD`, aur
`PGSSLMODE=require`. Detail: DB_CONNECTION_GUIDE HISAA 1.

**B) Service key (admin bootstrap ke liye):** CP Vercel env mein
`OMNIFLOW_SERVICE_KEY` (ya `OMNIFLOW_ADMIN_API_KEY`) ki value note karein. Yeh
pehle se maujood hai (doosre machine-facing routes isi ko use karte hain). Is
se aap **ek dafa** admin account banayen ge (PHASE 4-B).

> ❌ **CP ke liye `SUPABASE_URL` / `SUPABASE_ANON_KEY` ki ZAROORAT NAHI.**
> Yeh sirf **website** project mein rehte hain (PHASE 5). CP 100% Neon hai.

## PHASE 1 — Confirm (koi nayi cheez banani nahi, sirf check)

1. **Neon = data:** customer portal kholein — conversations/contacts/billing
   dikhein to Neon connection theek hai ✅ (kuch nahi karna).
2. **Service key maujood:** CP Vercel env mein `OMNIFLOW_SERVICE_KEY` (ya
   `OMNIFLOW_ADMIN_API_KEY`) set hai ✅ (PHASE 4-B mein lagegi).
3. Site-analytics tables (§260) Neon mein hain — optional check: portals ke
   analytics page par numbers aa rahe hon to theek.

## PHASE 2 — Office PC: patchers chalana (repo root se)

Order se, ek ke baad ek. Sab idempotent hain — jo already applied hai woh
"identical/skipped" dikha dega, dobara lagne wali cheez "replaced" dikhegi:

```
node PATCHERS_TO_RUN\finish_263.mjs
node PATCHERS_TO_RUN\github_clean_264.mjs
node PATCHERS_TO_RUN\site_analytics_265.mjs
node PATCHERS_TO_RUN\cp_race_fix_266.mjs
node PATCHERS_TO_RUN\portals_speed_267.mjs
node PATCHERS_TO_RUN\mobile_p1_275.mjs
```
Har ek ke baad output dekhein: **`0 failed`** hona chahiye.
(`python3`/`py` na hone wali note normal hai — "checks skipped" = theek; har
file sha256-verified hoti hai.)

> ⚠ **§275 chalayein, §272/§273/§274 NAHI.** Purane mobile patchers (§272
> broken, §273/§274 Supabase-based) **superseded** hain. §275 = Neon-only.

Confirm karein ke CP repo folder mein yeh files maujood hain:
```
dir OmniFlow-Control-Plane\app.py
dir OmniFlow-Control-Plane\portal_mobile_admin.py
dir OmniFlow-Control-Plane\portal_site_analytics.py
dir OmniFlow-Control-Plane\portal_billing.py
```

## PHASE 3 — CP repo push (Vercel CP deploy)

```
cd OmniFlow-Control-Plane
git add -A
git commit -m "mobile admin (Neon) + race fix + site analytics + speed shells"
git push
cd ..
```
Push ke baad Vercel CP project **auto-deploy** karega. Deploy complete hone ka
intezaar karein (PHASE 4-B bootstrap us ke baad).

## PHASE 4-A — Vercel: CP project (omniflow-backend) env + region

Vercel → CP project → **Settings → Environment Variables**.

**Database (NEON) — yeh pehle se set hain aur chal rahe hain. Sirf CONFIRM
karein, badlein mat (jab tak portals khaali na hon):**

| Name | Value | Status |
|---|---|---|
| `DB_HOST` | `ep-....neon.tech` (Neon host) | ✅ confirm Neon hai — **badalna NAHI** |
| `DB_PORT` | `5432` | ✅ confirm |
| `DB_NAME` | `neondb` (ya aap ka Neon db naam) | ✅ confirm |
| `DB_USER` | Neon role | ✅ confirm |
| `DB_PASSWORD` | Neon password | ✅ confirm |
| `PGSSLMODE` | `require` | ✅ confirm |
| `OMNIFLOW_SERVICE_KEY` | jo pehle se hai | ✅ confirm (bootstrap ke liye) |

> ❌ **CP mein `SUPABASE_URL` / `SUPABASE_ANON_KEY` NAHI daalni.** Agar pehle
> (galti se) daal di thi to **remove** kar dein. CP sirf Neon use karta hai.

Optional (mobile remote config — abhi zaroorat nahi, jab chahiye tab):
`OF_MOBILE_FLAGS` (e.g. `inbox=true`), `OF_MOBILE_MIN_VERSION`,
`OF_MOBILE_MAINTENANCE`, `OF_MOBILE_ANNOUNCEMENT`.

Region: **Settings → General → Function Region** = wahi region jo **Neon**
project ka hai (e.g. `us-east-2` / `ap-south-1`) — taake CP aur DB qareeb
rahen, speed behtar ho.

Phir: **Deployments → latest → ⋯ (3 dots) → Redeploy** ✅ (env changes sirf
redeploy ke baad apply hote hain). Deploy complete hone dein.

## PHASE 4-B — Mobile Admin account banaen (EK DAFA, Neon)

CP deploy ho jane ke baad, **ek dafa** yeh command chalayein (apna CP URL,
service key, email, aur ek **mazboot 8+ character** password). Tables CP khud
bana leta hai — koi SQL manually nahi chalana:

```bash
curl -X POST https://omniflow-backend.vercel.app/api/v1/mobile/admin/bootstrap \
  -H "X-Omniflow-Key: APNI_OMNIFLOW_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@omniflow.pk","password":"AapKaMazbootPassword!","name":"Owner"}'
```

Kamyab jawan: `{"ok": true, "email": "owner@omniflow.pk"}`. Yeh email/password
PHASE 9 mein Admin app login ke liye use hoga. **App yeh command kabhi nahi
chalata** — sirf aap, ek dafa, terminal se. (Dobara chalane ki zaroorat nahi.)

> Optional: `db/mobile_admin.sql` repo mein hai (same schema) agar aap tables
> khud dekhna chahein — lekin zaroori nahi (lazy DDL khud bana deta hai).
> Account **hamesha** bootstrap se bane (plaintext password SQL mein na daalein).

## PHASE 5 — Website repo push + Vercel website env (Supabase — ALAG system)

Yeh **website ka admin panel / CMS** hai — CP/mobile se unrelated. Isay chalta
rehne dein (Supabase yahan theek hai).

1. Website repo root se:
   ```
   git add -A
   git commit -m "portals speed shells + analytics + mobile workspace"
   git push
   ```
   (Push se Vercel auto-deploy chalega.)
2. Vercel → **website** project → Settings → Environment Variables:

| Name | Value | Status |
|---|---|---|
| `OF_ANALYTICS_SALT` | random 64-hex (neeche command) | **NAYA** |
| `CRON_SECRET` | random 64-hex | **NAYA** |
| `OMNIFLOW_CONTROL_PLANE_URL` | `https://omniflow-backend.vercel.app` | ✅ confirm |
| `NEXT_PUBLIC_SUPABASE_URL` | website ka Supabase URL | ✅ confirm (pehle se hai) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | website ka anon key | ✅ confirm (pehle se hai) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → service_role | ✅ confirm (website ke paas pehle se) |

Random values banane ka command (office PC, kisi bhi folder se):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
(do baar chalao — ek SALT ke liye, ek CRON_SECRET ke liye)

3. Region: website project ka Function Region bhi **wahi** jo CP ka (Phase 4-A).
4. Env dalne ke baad website project mein bhi **Redeploy** ✅.

## PHASE 6 — WhatsApp bot

Bot wale PC par `.env` update karein (CP URL + service key wahi jo Phase 4-A
mein hai) aur channel chalayein:
```
python run_channel.py
```
(PC jo on rehta hai wahi par.)

## PHASE 7 — GitHub: repo PRIVATE

GitHub → website repo → Settings → sab se neeche **Change visibility →
Private**. (CP repo bhi private hi rehna chahiye — confirm.)

## PHASE 8 — Speed: UptimeRobot (free)

uptimerobot.com → 2 monitors, interval **5 minutes**:
1. `https://omniflow-backend.vercel.app/api/v1/mobile/config` (CP warm ping — halka public endpoint)
2. Website ka home URL

Is se Vercel functions + DB connection garam rehte hain — portals ki 5–6s
wali der bohat kam hogi.

## PHASE 9 — Mobile apps

```
cd mobile
npm install
npm run typecheck
npm test          → sab pass hona chahiye
npm start
```
- **Client app** QR: Expo Go se scan. Phone aur PC same WiFi + Windows
  Firewall mein Node.js allow. WiFi isolation ho to: `npx expo start --tunnel`
  aur tunnel wala QR scan. Fallback: `w` press → browser preview.
- **Admin app**: `OMNIFLOW_APP_VARIANT=admin npx expo start --tunnel` (Windows
  PowerShell mein: `$env:OMNIFLOW_APP_VARIANT="admin"; npx expo start --tunnel`)
- **Client login** = portal wale account se (CP `/api/v1/auth/*`).
- **Admin login** = PHASE 4-B wale **bootstrap kiye gaye Neon account** se
  (email + password). ⚠ Admin login tab hi chalega jab PHASE 4-A redeploy +
  PHASE 4-B bootstrap ho chuka ho. (Koi Supabase involvement nahi.)

## PHASE 10 — Final visual checks

1. Website analytics page: numbers aa rahe hain (SALT lagne ke baad fresh
   counting shuru hogi).
2. Billing page: amounts **PKR** mein.
3. Portals: 3–4 pages click kar ke speed dekhein (pehle se tez hona chahiye;
   loading shells §267 view aayenge).
4. Mobile Client app: login → Home → "Control Plane: Connected" green dot.
5. Mobile Admin app: login (PHASE 4-B creds) → Overview → green "Database
   connected" + users count (Neon se).

---

**Koi step atke to:** us step ka poora output/error mujhe bhej dein — main
wahin se fix karunga. Order skip na karein (env pehle, redeploy, bootstrap baad
mein).
