# OmniFlow — Feature & Capability Audit Brief

> Purpose: is document se koi bhi AI agent poore project ka audit kar sakta hai.
> Har section me feature + kahan check karna hai + expected behavior likha hai.
> Repo: AHMEDANSARI0/Omniflow (website + portal root) · AHMEDANSARI0/OmniFlow-Control-Plane (AI/CP backend, Flask)
> Architecture: **Website/Portal (Next.js)** ⇄ **Control Plane (Flask AI backend)** ⇄ **Connector (WhatsApp bridge, Baileys)** + **Supabase (Postgres)**

---

## 1. PUBLIC WEBSITE (marketing — root `/`)

Light-first design system (indigo #4F46E5 / violet AI / cyan flow, Inter + Sora).

| Page | Route | Check |
|---|---|---|
| Home (17 sections, WhatsApp workflow animation) | `/` | Hero "Your business, on autopilot." + Roman-Urdu bubble animation |
| About / Features / Use-cases / Integrations | `/about` `/features` `/use-cases` `/integrations` | Integrations: WhatsApp **Live**, IG/Messenger/Telegram/TikTok honest **"Coming"** |
| Pricing (coming-soon) | `/pricing` | |
| Security / Privacy / Terms / FAQ / Contact | `/security` `/privacy` `/terms` `/faq` `/contact` | FAQ = CMS-driven + FAQPage JSON-LD |
| **Blog (CMS)** | `/blog` + `/blog/[slug]` | Admin se publish → turant live; table na ho to 3 seed articles |
| Public checkout | `/c/[token]` | OTP verify, coupon, COD, PK payments |
| Brand storefront (public, no login) | `/store/[slug]` | Order → WhatsApp confirmation |
| Sitemap/robots/manifest | `/sitemap.xml` | Sab routes + published posts |

**Audit:** `/blog` open karo, koi article kholo, Admin > Content > Blog se post publish karke live dekho.

---

## 2. CUSTOMER WORKSPACE (portal — `/dashboard`)

Login: email + password + **Workspace ID** (CP-issued, OTP password-reset). Auth = CP session cookies, portal BFF (`app/api/omniflow/portal/*`) depth-law + sameOrigin + safeJson.

### Inbox & Conversations
- **Conversations inbox**: list, filters (unread/needs-reply/starred/VIP), search, day separators, bulk actions, keyboard nav, sound/desktop alerts, tags/notes/stars/pins, saved replies (variables ke saath), reply drafts (AI), jump-to-latest, load older, CSAT rating card
- **AI Agent Assist** (per conversation): intent, **sentiment (lexicon ya LLM — admin switch, "AI" tag LLM pe)**, suggested reply, next-best-action reco, customer context card (orders, memory, history), "Why this happened" explain
- **Voice**: inbound calls + **voicemail recordings** (Twilio; player + duration), outbound calls, **video rooms**
- **Interactive messages**: template-based interactive cards (list/buttons)
- **Team**: assignment (manual + **auto-assign** + **auto-close idle**), team performance/perf report, response-overdue

### AI Brain & Automation
- **AI Brain** (`/dashboard/ai-brain` + settings BrainCard): Gemini-powered; persona/custom instructions; business profile; **intents** (classifier + intent intelligence); **knowledge base** (Q&A pairs, gaps suggestions, auto-draft LOCKED by owner decision)
- **Automations**: welcome message, auto-replies, keyword rules, follow-up agent, restock alerts, listen rules (social listening) — har automation on/off + config
- **Sequences** (drip campaigns): enrollment, steps, add-to-sequence from conversation, sequence stats
- **Broadcasts**: bulk campaigns, **AI copy helper (CopyGen)**, segments targeting
- **Growth**: revenue recovery (abandoned checkout followups, **negotiation bounds — AI discount within owner limits**), winback, churn signals, digest (daily brief), order-updates, weekly report (admin send-now pending)
- **COD**: risk scoring ("COD risk check" on customers), confirmation flow, address normalize/check, deliveries card
- **Memory**: per-customer AI memory (CustomerMemoryCard + purge "Forget all"), journey stages with explanations

### Commerce
- **Catalog** (items, brands — multi-brand support, sync settings), **coupons**, **checkout links** (WhatsApp par shareable), **payments** (JazzCash + Easypaisa — PK-only by owner decision; Stripe dormant), **courier** (Leopards live API: book/track/bookings; TCS reachability test), **storefront** per brand
- **Pipeline** (sales kanban), **segments**, **customers 360** (profile, journey, LTV, notes, tags)

### Analytics & Ops
- Analytics dashboard, weekly report, activity feed, events, compliance (opt-outs), data safety (retention), media library (upload/send/**transcribe**), API keys, profile, **onboarding** wizard
- **Settings**: business hours, plan, API key, widget (website chat widget config + theme), WATi integration, perf, data safety, brands, payments, negotiation, coupons, catalog, deliveries

**Audit (sample):** login → conversation kholo → Agent Assist (intent/sentiment/reply) → ek checkout link banao → `/c/<token>` kholo → COD mark → Settings > Payments me JazzCash keys (sandbox) → storefront `/store/<slug>` se order → WhatsApp confirmation.

---

## 3. CONTROL PLANE (AI backend — Flask, `OmniFlow-Control-Plane`)

64 modules. Har module = portal feature ka API. Key AI pieces:
- `portal_brain` (Gemini orchestration), `portal_llm` (engine keys, admin-managed), `portal_kb` (KB + auto-draft), `portal_knowledge` (sources/versions/chunks + ranked retrieval, §198), `portal_escalation` + `portal_notify` + `portal_ai_usage` + `portal_ai_audit` (platform services, §199), `portal_bi` (insights / problem detector / AI quality / funnel read model, §200), `admin_ai` (platform AI Control Center overview + autonomy override; global kill switch / autonomy cap / daily call cap + guard mode via platform_settings group `ai`, §201), `portal_guard` + `portal_ai_eval` (prompt-injection trust boundary + deterministic behavior contracts, §203), `portal_intents` + `intent_classifier`, `portal_insights` (**analyze_sentiment_smart**: lexicon ya LLM), `portal_reco`, `portal_negotiation` (bounded discount agent), `portal_recovery`/`portal_winback`/`portal_churn`, `portal_sequences`, `portal_memory`, `portal_risk` (COD risk), `portal_listen`, `portal_fraud`
- Commerce: `portal_catalog` `portal_checkout` (OTP + hosted PK payments) `portal_payments` (JazzCash/Easypaisa builders + HMAC verify) `portal_courier` (Leopards/TCS adapters) `portal_brands` `portal_coupons`
- Platform: `portal_auth` `auth_password_reset` `admin_*` `platform_settings` `portal_webhooks` `portal_events` `portal_rollups` `portal_analytics` `portal_perf` `portal_ratelimit` `portal_datasafety` `portal_obs` `portal_voice` (Twilio) `portal_video` `portal_media` `portal_wati` `portal_widget` `portal_templates` `portal_interactive` `portal_plans` `portal_pipeline` `portal_revenue` `portal_value` `portal_digest` `portal_contacts` `portal_segments` `portal_team` `portal_profile` `portal_apikeys` `portal_cloud` `portal_alerts` `portal_changes` `portal_growth` `portal_cod` `portal_restock` `portal_routing` `portal_setup` `portal_db` (lazy DDL)

**Audit:** CP URL health-check; login API 401/200 behavior; `GET /api/v1/portal/conversations` shape.

---

## 4. CONNECTOR (WhatsApp bridge)

- Baileys session (laptop pe chalta hai), QR pair, heartbeat + auto-restart heal
- Inbound → CP webhook → AI draft/reply (assist ya auto per automation rules)
- Outbound send (text/media/interactive/template), delivery receipts
- Widget messages (website chat) bhi isi pipeline se

**Audit:** bot online? ek test message bhejo — inbox me aana chahiye; automation welcome naye contact ko.

---

## 5. ADMIN PANEL (platform owner — `/admin`)

- **Content CMS**: hero, features, how-it-works, problem-solution, AI-intelligence, multi-channel, use-cases, why-omniflow, trust, FAQ, final-CTA, footer, customer-memory + **Blog editor** (write/publish/delete) — sab website par live
- **Leads** (early-access), **Customers** (platform users), **SEO** editor, **Settings** (owner password), **Integrations**: AI engine key, email (test-send), **provider AI switches (true_sentiment LLM toggle)**, voice greeting, payments note (PK), weekly report

---

## 6. AI — KYA KAR SAKTA HAI (capability summary)

1. **Samajhna**: Roman Urdu/Urdu/English messages → intent + sentiment + language detect
2. **Soochna**: per-customer memory + journey + orders + KB se context-aware jawab
3. **Jawab dena**: Agent-Assist drafts (owner approve kare) ya auto-reply (automation on ho)
4. **Becho**: product recommendations, negotiation (bounded discount), abandoned-cart recovery, winback
5. **Bikri save karna**: COD risk flag, address check, followups
6. **Bikherna**: sequences, broadcasts (AI copy), segmentation
7. **Kaam agay barhana**: auto-assign, auto-close, followup agent, restock alerts, daily brief/weekly digest
8. **Sunna**: social/listen rules, voice inbound + voicemail transcribe (media transcribe)

### ⛔ Owner-locked limits (audit me ye "features" NAHI mane jayen)
- **#2 Invoices module: EXCLUDED** (scope se bahar — deliver nahi karna)
- KB auto-draft: **LOCKED** (owner decision — assist me draft dikh sakta hai, auto-publish nahi)
- Auto-send kabhi bina approval jab tak automation off ho — AI assist-first philosophy
- Payments: **Pakistan-only** (JazzCash/Easypaisa) — Stripe dormant
- Non-WhatsApp channels: code-side setup hai par UI me honest **"Coming"**

---

## 7. QUICK AUDIT CHECKLIST (AI agent ke liye)

- [ ] Website: homepage animation, /blog publish flow, sitemap
- [ ] Login + workspace isolation (do workspace → alag data)
- [ ] Inbox: message send/receive (connector live), AI assist card values
- [ ] Commerce: catalog → checkout link → OTP → JazzCash sandbox pay → paid
- [ ] Courier: Leopards keys → book test parcel → track
- [ ] Voice: call → voicemail → portal player
- [ ] Admin: content change → website turant; blog publish → /blog
- [ ] Rig: `tools/cp-testrig` 132 suites / 4366+ checks PASS (repo me `python3 tools/run_sweep.py`)
- [ ] Patcher law: koi bhi naya batch whole-file marker-guarded patcher + E2E mimic ke saath; LAYOUT LAW (§202): patcher website repo root (bot root) par chalta he, CP files `OmniFlow-Control-Plane/` (nested CP repo = Vercel deploy) + `omniflow-backend-patch/` (mirror) dono par - `tools/patchers/gen_batch.py` / `gen_cp_sync.mjs`

6g. Instagram-first omnichannel adapter ✅ (§204: shared `normalize_messages`/`ingest_messages_for_tenant` core; `portal_instagram` settings + signed Meta webhook + Graph dispatch; `ig:` contacts; channel-aware outbound queue; Settings card + Inbox filter; secrets DB-backed with masked GET). Facebook/TikTok adapters remain deferred.
