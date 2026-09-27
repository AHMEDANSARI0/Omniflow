# OmniFlow — Product & Architecture Audit Brief

> Purpose: hand this document (with the repo) to any AI or consultant to audit
> the product, spot gaps, and propose improvements. Everything below reflects
> the actual code in this repository.

## 1. What OmniFlow is

OmniFlow is a **WhatsApp-first commerce & CRM platform for small
Pakistan-market businesses** (COD-heavy retailers, boutiques, service
sellers). A business owner signs up on the web dashboard, connects their
WhatsApp, and gets: an AI-assisted shared inbox, customer CRM with language
tracking, no-code automations, checkout links with coupons, COD confirmation
flows, broadcasts/sequences, and revenue analytics — all running on the
owner's own WhatsApp number. The differentiating PK-market features are COD
confirmation for hot leads, Urdu/Roman-Urdu language-aware auto-replies, and
a self-serve order page that customers actually complete on their phone.

## 2. The four moving parts (deployment architecture)

```
                    ┌───────────────────────────────────────────────┐
                    │                 OWNERS / STAFF                │
                    └───────────────┬───────────────────────────────┘
                                    │ HTTPS
                    ┌───────────────▼───────────────┐
                    │  WEBSITE  (Next.js, this repo)│
                    │  • /dashboard  owner portal   │  ← server BFF route
                    │  • /c/<token>  public order   │    handlers call the
                    │  • /admin      marketing CMS  │    CP with short-lived
                    │  • /          marketing site  │    access tokens
                    └───────────────┬───────────────┘
                                    │ signed JSON (X-Omniflow-Key /
                                    │ bearer access tokens)
                    ┌───────────────▼───────────────┐
                    │ CONTROL PLANE (Flask + Postgres)│
                    │  omniflow-backend-patch/*.py    │
                    │  • portal_*    owner REST APIs  │
                    │  • /api/v1/public/* customer   │
                    │  • /api/v1/connector/* bot     │
                    │  • audits, row-level client_id │
                    └───────────────┬───────────────┘
                                    │ poll (~15s) + ack queue
                    ┌───────────────▼───────────────┐
                    │ CONNECTOR BRIDGE (Python)     │
                    │  connector-bridge/…bridge.py  │
                    │  WhatsApp account adapter     │
                    │  + WATI + Cloud API + Telegram│
                    └───────────────┬───────────────┘
                                    │
                              CUSTOMERS on WhatsApp
```

- **Website** (`app/`): Next.js App Router. Owner portal pages under
  `app/dashboard/(portal)/` never call the database — every read goes through
  a server-side BFF route handler (`app/api/omniflow/**`) which attaches the
  portal access token; secrets never reach the browser. The public order page
  is `app/c/<token>`; the marketing site + its Supabase-authed CMS live under
  `app/(panel)` and `app/admin`.
- **Control Plane** (`omniflow-backend-patch/`): Flask blueprint per domain
  (`portal_conversations`, `portal_growth`, …) mounted by `app.py`. Every
  table carries `client_id`; every endpoint re-scopes by the caller's client;
  write actions append to an audit table; a `portal_db` layer owns lazy DDL
  (tables/columns are added on demand, so upgrades are zero-migration).
- **Connector bridge** (`connector-bridge/control_plane_bridge.py`): runs next
  to the WhatsApp gateway, polls the CP for outbound commands
  (`send_message`, `send_interactive`, `send_template`, away acks), delivers
  via the adapter, and POSTs inbound messages back to
  `/api/v1/connector/ingest`. Also pushes provider template lists (WATI /
  Meta Cloud API) into the CP every ~10 minutes.
- **PostgreSQL**: single source of truth for tenants, contacts, conversations,
  orders/checkout links, automations, analytics rollups, audit log.

### Message lifecycle (the core loop)

1. Customer texts the business WhatsApp.
2. Bridge POSTs it to `/api/v1/connector/ingest` (X-Omniflow-Key authed,
   tenant resolved from the number).
3. CP runs the ingest hook chain: opt-out/compliance guard → business-hours
   away reply (language-aware ur/roman variants) → COD confirmation flow for
   hot leads → KB keyword auto-reply (language-aware matcher) → routing rules
   → listen rules → sequence enrollment → conversation row + audit.
4. Owner replies from the shared inbox (or an automation fires); CP queues a
   command row.
5. Bridge polls `GET /connector/commands` (~15s), sends via
   WhatsApp/WATI/Cloud API, acks success/failure (failures surface as notes
   on the thread row).

## 3. Security model (what an audit should check against)

- Portal auth: email/password sessions with refresh tokens issued by
  `portal_auth`; BFF handlers only; no CP token in the browser; role system
  (owner/staff) + per-owner API keys (`portal_apikeys`).
- Service-key guard (`secrets.compare_digest`) on every
  `/api/v1/connector/*` and `/api/v1/public/*` route; tenant resolution is
  explicit, never inferred from client input alone.
- Customer-facing checkout endpoints validate link ownership, expiry, status;
  totals are recomputed server-side (client never sets money values);
  coupons revert atomically on remove; previous-coupon never double-applies.
- Money guard: revenue-changing actions blocked unless the tenant is marked
  paid; payment gateway module reconciles.
- Data safety: contact export/delete + conversation purge endpoints, audit
  trail for every write, no secrets in the repo.

## 4. Client-facing feature catalog (what customers buy)

### A. WhatsApp inbox & conversations
- Shared team inbox: assignment, star/pin, unread filter, thread search,
  load-older pagination, day separators, read-all, bulk actions, desktop
  alerts, mobile nav, quiet hours, auto-pause.
- **Interactive messages**: owner-composed WhatsApp button/list messages
  (3 buttons × 20 chars, 10-row lists) — sent like a normal reply.
- **Provider templates**: WATI template cards AND Meta **Cloud API approved
  templates** (auto-synced from Meta every ~10 min; send with parameters from
  the chat thread; rejections surface as notes, no silent text fallback).
- Per-thread tool cards: saved replies, WATI + Cloud template send, add-to-
  sequence, negotiation nudges, COD actions.

### B. AI / automation
- **Knowledge base bot**: entries with keywords + language tag
  (auto/en/ur/roman); language-aware matcher answers customers in their
  stored language; KB gap detection ("questions we couldn't answer").
- **Configure AI**: bot persona/config, keyword triggers.
- **Sequences**: multi-step scheduled message series with per-step delays,
  pause/resume, enrollment management, stats, add-customer-to-sequence from
  the inbox.
- **Broadcasts**: one-off + **scheduled broadcasts** to list/segment
  audiences (segments resolved live at send time), preview, history.
- **Segments**: rule-based customer segments (spend, tier, language, …).
- **Automations page**: cart recovery, win-back, restock alerts, follow-ups,
  listen rules (keywords → actions), routing rules (assign by keyword),
  negotiation settings, business hours + language away-variants.

### C. Commerce & money
- **Checkout links**: public order page `/c/<token>` with server-computed
  totals, delivery address capture, customer **change requests** (address /
  cancel) with owner approve-decline + WhatsApp confirmation.
- **Coupons**: percent/fixed, min spend, usage limits, expiry, pause/resume;
  apply/remove on the public page; usage counts.
- **Saved catalog**: reusable product/service items that fill checkout rows.
- **COD confirmations**: hot leads get an automatic WhatsApp confirm ask;
  YES/NO replies (English + Roman Urdu regexes) flip request state; full
  trail page.
- **Payments**: gateway integration + paid-status guard.
- **Pipeline**: deal stages with a board UI.
- **Negotiation**: configurable auto-nudge sequences for price hagglers.

### D. Customers & insights
- **Customers CRM**: import, 360° view, tags, per-customer **stored language**
  (drives auto-reply language), language lookup endpoint, tiers/spend.
- **Analytics**: revenue, product analytics, customer analytics with tiers +
  repeat-share + **language distribution chips**, CSAT summaries, churn
  radar, win-back list, restock, fraud checks, compliance center, digests,
  Daily Brief, Weekly report, forecasts/staffing, growth suggestions.
- **Growth cockpit**: checkout link composer (catalog chips), change-request
  review, negotiation settings, insights pack, save/reuse presets.

### E. Platform
- Team management (owner/staff roles), API keys, activity log, integration
  webhooks (signed, with delivery log + retries), Telegram bridge channel,
  business profile + WhatsApp setup wizard, compliance/data-safety center,
  PWA (installable, app shortcuts, offline shell, push-ish desktop alerts),
  English-only professional UI.

## 5. Delivery & quality system (repo process)

- `HANDOFF.md` — 160 numbered section-docs; every feature ships with a
  laptop runbook + expected patcher output.
- `tools/USER_CHECKLIST.md` — client-side verification checklist per batch.
- `tools/cp-testrig/` — 100+ pytest-style suites (~3,200 checks) that run
  against a stubbed DB; every batch adds suites before it ships.
- **Patcher system**: features are generated as self-contained `add_batch_*.mjs`
  scripts (idempotent, backup + compile-guarded, identity-verified) so the
  production laptop can apply them without a full deploy pipeline.
- Current pending-for-laptop chain: `931 heal → 951 WATI → 971-990 →
  991-1010` (one command: `bash run_931_1010.sh`).

## 6. Known gaps / excluded scopes (seeds for the audit)

1. **Invoices module** was explicitly excluded by the owner (planned, not
   built). Everything invoice-like today is the COD + payments pair.
2. Outbound media is limited — the bridge sends **text**, interactive cards
   and templates; rich media (images/catalog PDFs) is not a first-class
   citizen yet.
3. One WhatsApp number per tenant (multi-number / multi-brand is not
   modeled).
4. The public order page is single-currency (PKR conventions hardcoded in
   copy).
5. Analytics are computed on-request (no materialized rollups); fine at
   current scale, worth auditing for larger tenants.
6. The patcher/repair workflow is powerful but unusual — an auditor may want
   a normal deploy pipeline (CI, migrations, staging) instead.
7. Test rig excludes a few stale-rig suites (documented in HANDOFF §159);
   CI does not run the sweep automatically.

## 7. Suggested audit prompts for the AI

- "Review the ingest hook chain for ordering/race bugs (away → COD → KB →
  routing → sequences)."
- "Threat-model the `/api/v1/public/checkout/<token>` surface: enumeration,
  replay, coupon math, address injection."
- "Review `portal_cloud.py` + `send_template_message` for provider-FAQ
  handling (rate limits, 24h window rules, template param limits)."
- "Propose a multi-tenant scale plan (indexes, rollups, command-queue
  backpressure)."
- "Suggest the next 5 highest-leverage client-facing features for the PK
  COD-commerce market, given the catalog in §4 and gap list in §6."
