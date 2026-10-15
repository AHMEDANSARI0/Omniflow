# OmniFlow Feature Matrix (repository-verified)

Statuses: `BUILT` (implemented + tested), `PARTIAL` (works, missing depth),
`BROKEN` (suspected defect), `MISSING` (not started), `DEPRECATED`
(superseded, still present).
"Verified" = covered by the test rig and/or code inspection in this audit.
Priority uses the V2 roadmap (B-batches in `OMNIFLOW_V2_ROADMAP.md`).

| # | Feature | Status | Location | Verified | Problems / Risk | Required change | Priority |
|---|---------|--------|----------|----------|-----------------|-----------------|----------|
| 1 | Auth (sessions, refresh, reset) | BUILT | `portal_auth`, `auth_password_reset`, BFF auth routes | Yes | No rate limiting on login | Rate limit (B2) | P0 |
| 2 | Tenant isolation (`client_id` scoping) | BUILT | every module | Spot-checks in suites | No dedicated cross-tenant attack suite | Add explicit cross-tenant tests (B2) | P0 |
| 3 | Connector auth (service key) | BUILT | `connector_api._authorized` | Yes | None known | Keep; test replay (B1) | P0 |
| 4 | Public checkout (totals, address, status) | BUILT | `portal_checkout`, `app/c/[token]` | Yes | No rate limit; no idempotency on submit; token = capability | Idempotency + rate limit + attack tests (B1/B2) | P0 |
| 5 | Coupons (apply/remove/revert) | BUILT | `portal_coupons` | Yes (60 checks) | Race between two applies is serialized by row lock only by luck | Idempotency key per apply (B1) | P0 |
| 6 | Inbound message idempotency | PARTIAL | `connector_api.ingest_whatsapp_messages` | Yes | Dedupes on provider ids if supplied; no replay window guard | Event core with idempotency keys + DLQ (B1) | P0 |
| 7 | Outbound command queue | PARTIAL | `connector_api`, bridge | Yes | At-least-once without dedupe → double-send risk on retry; failure = note only | Idempotent dispatch + status machine + retries (B1), alerts (B5) | P0 |
| 8 | Ingest hook chain (away→COD→KB→routing→listen→sequences) | PARTIAL | `connector_api`, per-hook modules | Partially | Two hooks can both act on one message (no claimed-flag short-circuit) — contradictory replies possible | One-reply law + claim logging (B2) | P0 |
| 9 | COD confirm (regex) | PARTIAL | `portal_cod`, `connector_api` hook | Yes | Roman-Urdu variance missed; UNCLEAR silently dropped | LLM fallback + escalation + metric (B3), risk scoring (B9) | P0→P2 |
| 10 | KB auto-replies (keyword+language) | BUILT (fixed in 991-1010) | `portal_kb` | Yes (36 checks) | Was dead pre-991 (regex bug) — laptop regression test required; keyword-only understanding | LLM/RAG upgrade (B6); keep keyword fast-path | P1 |
| 11 | Interactive messages (buttons/lists) | BUILT | `portal_interactive` | Yes (49 checks) | — | — | — |
| 12 | WATI templates | BUILT | `portal_wati` | Yes (44 checks) | Provider-bound | — | — |
| 13 | Cloud API templates | BUILT (991-1010) | `portal_cloud`, bridge | Yes (34 checks) | Sync requires env keys; no webhook-based delivery status | Delivery statuses via events (B1) | P1 |
| 14 | Broadcasts + schedules | BUILT | `portal_growth` | Yes | Segment resolution at send is a full scan (fine at scale now) | Rollups (B4) | P1 |
| 15 | Sequences | BUILT | `portal_sequences` | Yes | — | — | — |
| 16 | Segments | BUILT | `portal_segments` | Yes (38 checks) | — | — | — |
| 17 | Negotiation | PARTIAL | `portal_negotiation` | Partially | Config only; no bounded price reasoning, no logging of rounds | Bounded negotiation agent (B8) | P1 |
| 18 | Checkout links + catalog chips | BUILT | `portal_checkout`, `portal_catalog` | Yes | — | Catalog sync (B15) | P2 |
| 19 | Change requests (address/cancel) | BUILT | `portal_changes` | Yes (40 checks) | — | — | — |
| 20 | Payments (gateway) | PARTIAL | `portal_payments` | Partially | Advance/partial-COD absent; webhook replay untested | Partial-COD (B15); replay tests (B2) | P2 |
| 21 | Analytics (revenue/products/customers/tiers/languages) | PARTIAL | `portal_analytics`, `portal_revenue`, `portal_insights` | Yes (16 checks) | On-request scans; slow at scale; causes portal latency | Rollups + TTL cache (B4) | P1 |
| 22 | Daily/weekly digest & brief | PARTIAL | `portal_digest` | Partially | No "needs attention"/recommended actions | AI brief v2 (B5) | P1 |
| 23 | Win-back / churn radar / restock / fraud / compliance | BUILT | `portal_winback`, `portal_churn`, `portal_restock`, `portal_fraud`, `portal_compliance` | Suites exist | Rule thresholds static | Tune via memory/journey (B7) | P2 |
| 24 | Customer language tracking | BUILT | `portal_contacts` (stored_language, portal_contact_lang) | Yes | — | Feeds AI personalization (B7) | — |
| 25 | Team roles + API keys | BUILT | `admin_users`, `portal_apikeys` | Partially | Fine-grained permissions absent | Entitlement layer (B14) | P3 |
| 26 | Webhooks (signed outbound) | BUILT | `portal_webhooks` | Yes (42 checks) | No retry backoff table visible | Reuse event core (B1) | P1 |
| 27 | Telegram bridge | BUILT | bridge + connector | Yes (23 checks) | — | Channel adapter model (B13) | P3 |
| 28 | PWA (manifest, shortcuts, offline shell) | BUILT | `app/manifest.ts`, `layout.tsx` | Yes (18 checks) | — | — | — |
| 29 | Data safety (export/delete/purge) | BUILT | `portal_datasafety` | Yes (17 checks) | AI-memory deletion will need adding when memory lands (B7) | Extend (B7) | P1 |
| 30 | Rich media send/receive | MISSING | — | — | Text/interactive/template only | Media pipeline + storage adapter (B11) | P2 |
| 31 | Voice transcription | MISSING | — | — | Voice notes not understood | STT → KB/AI pipeline (B11) | P2 |
| 32 | LLM intent engine / tools / policy | MISSING | — | — | The whole V2 AI layer | B3 (skeleton) → B6 (tools+policy) | P1 |
| 33 | Customer memory / journey | PARTIAL (raw data exists) | contacts/analytics | — | Data present (language, tiers, tags) but no unified memory/journey model | B7 | P1 |
| 34 | Couriers (booking/tracking/RTO loop) | MISSING | — | — | The single biggest PK-market differentiator gap | B9 (scoring) + B10 (adapters) | P2 |
| 35 | Multi-number / multi-brand | MISSING | one number per client | — | Blocks agencies/multi-brand owners | B13 | P3 |
| 36 | Omnichannel (IG/Messenger/web chat) | MISSING | — | — | Telegram only | B13 | P3 |
| 37 | Vertical templates / onboarding wizard | MISSING | — | — | Manual setup today | B14 | P3 |
| 38 | Billing/entitlements | PARTIAL (paid-status guard only) | `portal_payments` + money guard | Yes | Hard-coded flags, not a plan system | B14 | P3 |
| 39 | Rate limiting | MISSING | — | — | Login/checkout/connector/AI unprotected | B2 | P0 |
| 40 | Observability (structured logs, traces) | MISSING | — | — | printf logs; failures invisible | B4 | P1 |
| 41 | CI / staging / migrations | MISSING | — | — | Patcher-only delivery; no dry-run | Day-0 ops fixes + B1 housekeeping; CI in B4+ | P1 |
| 42 | Unused imports / portal.ts size (hygiene) | PARTIAL | 13 modules; `lib/omniflow/portal.ts` | Audit | Cosmetic debt; 7.7k-line client file | Cleanup + split with re-export barrel (B1/B7) | P2 |
| 43 | Invoices | DEPRECATED (excluded by owner) | — | — | Deliberate product decision | Out of scope unless owner reverses | — |

Summary: 27 BUILT · 9 PARTIAL · 6 MISSING · 1 DEPRECATED(excluded) across 43
tracked capabilities. No MOCKED and no DUPLICATE implementations found; one
true BROKEN-class bug (KB regex) was found and fixed during 991-1010 and its
laptop-side regression is still pending.
