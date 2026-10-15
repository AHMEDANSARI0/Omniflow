# OmniFlow — Current State (repository-verified)

> Audit date: 2026-09-21 · Source of truth: this repository at commit
> `b88e597` (sections below) + the delivery log in `HANDOFF.md` for anything
> newer. Every claim was checked against the code, not copied from memory.
>
> **Update (B1+B2 shipped):** idempotent inbound + reliable command queue +
> Deliveries UI (§161), then the one-reply law (away -> cod -> kb, audited in
> `portal_events.claimed_by`) and tenant/token rate limits on the public
> surfaces via the fail-open PG limiter `portal_ratelimit.py` (§162). Both
> are single patchers; the website/bridge are unchanged since B1's card.

## 1. What OmniFlow is

A WhatsApp-first commerce and CRM platform for Pakistan-market businesses
(COD-heavy retail, boutiques, services). Owner signs up on the web dashboard,
connects WhatsApp, and gets a shared inbox, CRM, automations, checkout links,
coupons, COD confirmations, broadcasts/sequences, and analytics — all on the
owner's own WhatsApp number. Positioning for V2: an **AI customer-operations
agent**, not a chatbot bolted onto a CRM.

## 2. Architecture (4 runtimes + 1 database)

| Runtime | Stack | Entry point | Notes |
|---|---|---|---|
| Website | Next.js (App Router, TS) | `next build` / `next start` (`package.json`) | Owner portal `app/dashboard/(portal)`, public order page `app/c/[token]`, marketing site `app/(panel)`, admin CMS `app/admin` |
| Control Plane | Flask + psycopg2 | `application` = `_CompositeWsgi` in `omniflow-backend-patch/app.py` (Gunicorn entry) | Two Flask apps composed by URL prefix: main API + `aux_app` (portal extensions) |
| Connector bridge | Python | `connector-bridge/control_plane_bridge.py` | Runs beside WhatsApp; polls CP, delivers, ingests |
| Database | PostgreSQL | — | Single source of truth; lazy DDL via `portal_db` |

Flow: browser → Next.js server BFF route handler (`app/api/omniflow/**`,
attaches the portal access token) → Control Plane REST → Postgres. The bridge
polls `GET /api/v1/connector/commands` (~15 s), delivers outbound, and POSTs
inbound to `/api/v1/connector/ingest`. Provider template lists (WATI, Meta
Cloud API) are pushed into the CP every ~10 minutes by the bridge.

## 3. Control Plane modules (`omniflow-backend-patch/`)

43 Python modules. Core groups:

- **Platform**: `app` (composition root), `portal_db` (pool, lazy DDL, shared
  tables/indexes), `portal_auth` (sessions/refresh), `admin_users`,
  `auth_password_reset`, `portal_apikeys`, `portal_profile`, `portal_setup`,
  `portal_channels`, `portal_datasafety`, `portal_compliance`.
- **Conversations**: `portal_conversations` (list/thread/notes/star/assign/
  business-hours config), `connector_api` (ingest, commands, away hook, COD
  hook, status), `portal_routing`, `portal_listen`, `portal_bot` (bot config).
- **Commerce**: `portal_checkout` (links + public view), `portal_coupons`,
  `portal_catalog`, `portal_changes` (customer change requests), `portal_cod`,
  `portal_payments`, `portal_negotiation`, `portal_reco`, `portal_restock`.
- **Growth/automation**: `portal_growth` (broadcasts, schedules, follow-ups,
  `_send_command`), `portal_segments`, `portal_sequences`, `portal_winback`,
  `portal_pipeline`, `portal_value`.
- **AI (current)**: `portal_kb` (keyword+language matcher, gaps), `portal_cod`
  (regex YES/NO confirm), `portal_negotiation` (rule-based), revenue scoring
  via `lead_temp` in the ingest path, `portal_digest`, `portal_insights`.
- **Providers**: `portal_wati`, `portal_cloud` (Meta Cloud API template
  snapshot + queue), `portal_interactive`, `portal_webhooks` (signed outbound),
  `portal_telegram` (via bridge), `portal_fraud`, `portal_revenue`,
  `portal_analytics`, `portal_churn`, `portal_contacts`, `portal_customer360`-
  adjacent code in contacts/analytics.

Conventions: every table is tenant-scoped by `client_id`; writes append audit
rows; tables/columns are created lazily (`CREATE TABLE IF NOT EXISTS` +
`ADD COLUMN IF NOT EXISTS`) so upgrades need no migration step.

## 4. Website structure

- 23 sidebar sections (`DashSidebar.tsx`): Overview, WhatsApp setup, Configure
  AI, Conversations, Customers, Automations, Analytics, Business profile,
  Broadcasts, COD confirmations, Integrations, Compliance, Growth, Win-back,
  Sequences, Segments, Pipeline, Quick replies, Activity, Weekly, Team,
  Settings, Knowledge base.
- BFF pattern: ~60 route folders under `app/api/omniflow/**`. Handlers call
  `requirePortalAccessToken()` (reads session cookies — no extra round trip)
  then one portal client function from `lib/omniflow/portal.ts`.
- `lib/omniflow/portal.ts`: ~7,700 lines, all CP clients, hand-written
  response mapping (defensive `typeof` checks), no runtime schema validation.
- Public order page (`app/c/[token]`) calls `/api/v1/public/checkout/*`
  through server BFF routes too.

## 5. Database

Shared DDL in `portal_db.py` (~15 tables + indexes, e.g.
`idx_portal_conversations_list`, `idx_portal_messages_conv(_dir)`) plus
per-module lazy DDL (cod, coupons, catalog, changes, cloud templates, kb lang,
contact languages, stored languages, segment members, sequence enrollments…).
Indexes on the hot paths exist. No migration tool — schema drifts lazily at
first use. No table partitioning; no rollup/materialized tables (analytics are
computed on request).

## 6. AI capability today (honest baseline)

| Capability | State |
|---|---|
| KB auto-reply | Keyword scorer (3/keyword, min 3) + language tiers (want-lang > auto > other); stored per-customer language drives variant choice. **Was silently broken until batch 991-1010 fixed a double-escaped regex in `_normalize_text` — related features must be regression-tested on the laptop.** |
| COD confirmation | English + Roman-Urdu regex YES/NO; unclear → nothing happens (no escalation, no metric) |
| Negotiation | Static business config (enable, max steps); no price-bound reasoning |
| Lead scoring | Purchase-intent → `lead_temp='hot'` (drives COD + winback) |
| Digests/brief | Rule-aggregated daily/weekly emails + dashboard widgets |
| No LLM anywhere | Zero model calls in the codebase. No intent engine, no tools, no RAG, no memory. |

## 7. Testing

`tools/cp-testrig/` — 105 suites, ~3,170 checks, Flask test clients against a
stubbed DB layer (`test_lib.install_db_stub`) + static pins on TS files.
Current: 103 suites green (3,134 checks) in the maintained sweep; 5 excluded
suites are stale rig-lineage artifacts documented in HANDOFF §159 (they pin
files/bridge functions that never existed in the reconstructed repo tree; the
laptop got those features through their own batch patchers).
No CI. Type-check (`tsc --noEmit`) and esbuild smoke are run manually per batch.

## 8. Deployment

- Development/history is delivered to the production laptop through
  self-contained patcher scripts `add_batch_*.mjs` (idempotent, backup +
  `py_compile` guard, identity-verified). ~120 patchers live at the repo root.
- Pending laptop chain: 931 heal → 951 WATI → 971-990 → 991-1010
  (`bash run_931_1010.sh`; runbook `RUNBOOK_931_1010.md`).
- CP serving: Gunicorn is the documented entry (`application`), but the
  worker/thread count used on the laptop is not recorded anywhere in the repo.
- Website serving: no documented production start; the repo only proves
  `next build`/`next start` exist in `package.json`.
- No CI, no staging environment, no migration tool, no rollback scripts.

## 9. Performance findings — why the portal feels slow (3–4 s per click)

Verified in code, ordered by likely impact:

1. **The website is hosted on Vercel** (owner update, 2026-09-21). Latency
   comes from serverless cold starts plus every BFF call making a
   cross-network round trip to the laptop-hosted Control Plane — a page that
   fans out 20 BFF calls pays that 20 times. B4 consolidates fan-outs and
   adds caching; hosting the CP closer to the Vercel region is the
   architectural option.
2. **Control Plane concurrency is unconfigured.** The composite WSGI app is a
   Gunicorn entry, but with the default single sync worker every parallel BFF
   call serializes inside Flask + psycopg2. Pages that fire parallel fetches
   (Growth fires **20** BFF calls in one `Promise.all`) then wait for each
   other. **Day-0 fix**: run Gunicorn with a small worker pool and threads
   (I/O-bound workload): `gunicorn -w 2 --threads 8 -b 127.0.0.1:8000
   application` (exact counts to be confirmed on the laptop), and verify
   psycopg2 pool sizing matches.
3. **Heavy pages fan out widely.** Growth = 20 parallel BFF calls; each BFF
   call is a separate HTTP hop with its own auth+query work. Consolidating
   Growth into 2–3 aggregate endpoints (overview, insights, ops) removes most
   of the fan-out. (Planned: B4.)
4. **Nothing is cached.** Every BFF fetch is `cache: "no-store"` and every
   CP response is served with no-store headers; dashboards recompute
   analytics on every visit. Short-TTL server-side caching for analytics and
   overview endpoints + rollup tables fix this. (Planned: B4.)
5. **Analytics are computed on request** — revenue/tier/language scans run on
   the order/contact/message tables at click time. Rollups (B4) turn these
   into cheap precomputed reads.
6. DB hot-path indexes exist; message pagination is bounded (`LIMIT`), so the
   database itself is not the first suspect at current scale.

Quick wins (1) and (2) alone should take most pages from seconds to
sub-second; they are laptop-side operational changes, not code.

## 10. Code health (handover readiness)

- Naming, structure, and docstrings are consistent; modules are small and
  single-purpose; zero TODO/FIXME markers; strict TS passes.
- 13 modules carry unused imports (cosmetic; listed in the feature matrix;
  cleanup folds into the next routine batch).
- The ~120 patcher scripts at the repo root are history, not living code — a
  new developer should read `HANDOFF.md` §160 + `RUNBOOK_931_1010.md` first,
  and the patchers should be archived into `tools/patchers/` (planned
  housekeeping in B1; no references may break when moved).
- `lib/omniflow/portal.ts` at ~7,700 lines is the largest maintainability risk;
  it should be split by domain during V2 without changing call sites
  (re-export barrel keeps imports stable).
- Docs: `HANDOFF.md` (160 numbered delivery sections), `tools/USER_CHECKLIST.md`,
  `AUDIT_BRIEF.md`, this document set.

## 11. Known gaps (beyond the matrix)

- No LLM/AI layer (see §6). No event system — correctness depends on the
  15 s poll loop and per-hook guards. No media pipeline (text/interactive/
  template only). One WhatsApp number per tenant. PKR-only copy. No
  observability stack (printf-style logs). No rate limiting middleware.
  Invoices module deliberately excluded (owner decision, 971-990 round).
