# OmniFlow V2 — Implementation Roadmap

> Serial order approved by the owner. Each batch ships complete (patcher,
> tests, docs, verification) in one delivery. Priorities: **P0** correctness/
> security, **P1** AI backbone, **P2** market differentiators, **P3** scale.
> Principles: lightweight · zero hard-coding · flexible adapters ·
> handover-ready code (see V2_ARCHITECTURE header).

## Day-0 ops findings (owner update, 2026-09-21)

- The website is hosted on **Vercel**; the Control Plane runs on the owner's
  laptop. The 3–4 s portal latency is therefore dominated by (a) Vercel
  serverless cold starts and (b) every BFF call making a cross-network round
  trip to the laptop CP (Growth fires 20 calls per visit). Gunicorn sizing on
  the laptop still matters (use `-w 2 --threads 8`). The durable fixes are
  B4's aggregate endpoints + rollups + TTL cache; a medium-term option is
  hosting the CP in the same region as the Vercel functions.
- Status: B1-B11 are DONE (B11 = media library + WhatsApp media send + voice transcription, env-driven go-live). B12 DONE (speed pack: hot DB indexes + live Performance card on Settings; the B12 patcher add_batch_1131_1140_perf.mjs also repairs the drifted-bridge send_media anchors from B11 - HANDOFF \u00a7173). B13 DONE (instant navigation: loading skeletons on the heavy pages + portal error boundary - HANDOFF \u00a7174). **V2 ROADMAP COMPLETE (B1..B13).** Remaining optional: #2 Invoices (excluded by user), further polish strictly on request.

## Day-0 ops fixes (no code, owner runs on laptop — do FIRST)

1. Serve the website from a production build: `npm run build && npm start`
   (or pm2). Dev-mode compiling is the most likely cause of the 3–4 s clicks.
2. Size the CP: `gunicorn -w 2 --threads 8 -b 127.0.0.1:8000 application`
   (confirm the laptop's current command; defaults serialize all requests).
3. Re-check: Growth and Analytics should feel instant; whatever still lags
   becomes B4's measured target.

## B0 — Audit & plan docs (this delivery) — P0

- Objective: repository-verified audit + matrix + architecture + roadmap.
- Files: `OMNIFLOW_CURRENT_STATE.md`, `OMNIFLOW_FEATURE_MATRIX.md`,
  `OMNIFLOW_V2_ARCHITECTURE.md`, `OMNIFLOW_V2_ROADMAP.md`.
- DB/API/FE: none. Tests: n/a (docs). Rollback: delete docs.
- Status: **DONE** (this commit).

## B1 — Event core v1 + housekeeping — P0 — **DONE** (commit 0a9c5d6; patcher add_batch_1011_1030_events.mjs; HANDOFF §161)

- Objective: idempotent inbound events; reliable outbound commands (status
  machine, retries + exponential backoff, dead-letter, replay protection);
  keep the bridge protocol unchanged.
- Modules: `portal_db` (DDL), NEW `portal_events.py` (worker thread, claim/
  retry/dead logic), `connector_api` (ingest writes events; ack upgrades
  command status), bridge (ack carries provider ids when available).
- DB: `portal_events`, `portal_commands` + idempotency/status/backoff columns
  (lazy DDL). API: `POST /api/v1/connector/events` (alias), dead-letter list/
  replay owner endpoints. FE: Settings → "Deliveries" card (dead + retries,
  replay button). Tests: duplicate-ingest dedupe, retry/backoff math, dead
  after N attempts, replay, cross-tenant isolation. Rollback: worker thread
  disabled by env; tables inert.
- Housekeeping: patcher scripts → `tools/patchers/` (references updated), the
  13 unused-import cleanups.

## B2 — One-reply law + security pack — P0 — **DONE** (patcher add_batch_1031_1040_onereply_rate.mjs; HANDOFF §162; sweep 105/3206/0)

- Objective: one inbound message → at most one automated reply (claimed-flag
  short-circuit, non-exclusive hooks opt in); claim logging; tenant-aware rate
  limits (login, public checkout, connector, AI endpoints); checkout attack
  suite (replay, negative/huge quantities, concurrent applies, cross-tenant
  tokens).
- Modules: NEW `portal_pipeline.py` (named stages + claim), `connector_api`,
  `portal_auth`/`portal_checkout` (limits), NEW `portal_ratelimit.py`
  (Postgres token bucket — no Redis).
- Tests: hook-conflict test (COD+KB both match → exactly one reply), rate
  limit matrices, attack pack. Rollback: claim law behind a settings flag
  (default ON), rate limits per-route toggleable.

## B3 — Roman-Urdu LLM intent (COD first) — **DONE** (patcher add_batch_1041_1050_intents.mjs; HANDOFF §163; sweep 106/3241/0)

- Objective: COD confirm gains an LLM fallback classifier
  (CONFIRM/CANCEL/UNCLEAR) used only when regex misses; UNCLEAR → staff flag
  + weekly metric; intent taxonomy table seeded for the B6 brain.
- Modules: NEW `ai/llm.py` (OpenAI-compatible, env-keyed, budget+timeout+
  fallback), `portal_cod`, NEW `portal_intents.py`. FE: COD page shows the
  UNCLEAR rate + flagged items. Tests: 30+ real Roman-Urdu phrases fixture,
  graceful no-key fallback (rules only), budget/timeout paths. Rollback:
  remove env key → pure regex behavior.

## B4 — Analytics rollups + observability — P1 — **DONE** (patcher add_batch_1051_1060_growth_speed.mjs; Growth 14 calls -> 1 cached bundle; X-Of-Trace-Id + slow-request JSON logs; HANDOFF §164)

- Objective: hourly/daily rollup tables (revenue, products, customers, tiers,
  languages) + nightly refresh; dashboards read rollups with on-request
  fallback for today; aggregate endpoints for Growth (20 calls → 2–3);
  short-TTL cache; structured logs (request_id/trace_id/tenant/duration).
- Modules: NEW `portal_rollups.py`, `portal_analytics`, `portal_insights`,
  Growth BFF routes, NEW `portal_obs.py`. Tests: rollup correctness vs
  on-request (fixture deltas), cache TTL, log fields. Rollback: env flag
  returns dashboards to live compute.

## B5 — Failure alerting + AI Daily Brief v2 — P1 — **DONE** (patcher add_batch_1061_1070_alerts.mjs; bell + badge + needs-attention/recommended blocks; HANDOFF §165)

- Objective: revenue-critical delivery failures (COD confirms, checkout
  sends) raise in-app alerts (bell + badge, optional email) instead of only
  thread notes; Daily Brief gains "Needs attention" + "Recommended actions"
  blocks from rollups + dead-letter + escalations.
- Modules: `portal_digest`, NEW `portal_alerts.py`, bridge ack paths, inbox
  top bar. Tests: forced failure → alert row + badge; brief blocks render.
  Rollback: alerts toggle per tenant.

## B6 — AI Brain v1: tools, policy, grounding — P1 — **DONE** (patcher add_batch_1071_1080_brain.mjs; read-only tools, policy vetoes, traces, off/suggest/auto autonomy, Settings AI Brain card; HANDOFF §166)

- Objective: intent-driven agent with the tool registry (read-only first:
  get/search customer, orders, products, inventory, conversation; then
  create_checkout, apply_coupon, send_template, escalate_to_human), policy
  engine (AUTO/ASK/NEVER + thresholds per tenant), confidence thresholds with
  clarify/escalate fallbacks, provenance on answers, full `ai.action` audit.
- Modules: NEW `ai/tools.py`, `ai/policy.py`, `ai/reasoner.py`, `portal_ai.py`
  (endpoints + config), Settings → "AI permissions" card, inbox explain cards.
  Tests: tool schema validation, tenant isolation inside tools, policy matrix,
  no-key fallback, injection probes, budget/iteration caps. Rollback: autonomy
  level 0 = AI suggests only.

## B7 — Memory + journey + explainability — P1 — **DONE** (patcher add_batch_1081_1090_memory.mjs; memory CRUD + purge, journey stages + paid-auto-advance, explain card; HANDOFF §167)

- Objective: structured customer memory (editable/deletable, surfaced in
  Customer 360), configurable journey stages + transitions-as-events, data
  safety extended to memory; explain cards populated from audit.
- Tests: memory CRUD + purge, journey transitions drive automations, safety
  integration. Rollback: tables inert without AI enabled.

## B8 — Revenue recovery + negotiation v2 + AI copy-gen — P1 — **DONE** (patcher add_batch_1091_1100_recovery.mjs - includes the laptop repair that unblocks the Vercel build; recovery scan + follow-ups, bounded negotiation, copy-gen with fallback; HANDOFF §168)

- Objective: recovery detections (abandoned checkout/conversation, price
  objection, unconfirmed COD, inactive high-value) → recommended or executed
  (policy-bound) follow-ups; negotiation agent bounded by owner-set
  min-price/max-discount with full round logging; broadcast copy generation
  (ur/roman/en variants) with owner edit-before-send.
- Tests: recovery triggers on fixtures, negotiation never crosses bounds,
  copy-gen fallback copy when no key. Rollback: autonomy gate.

## B9 — COD intelligence + address intelligence — P2 — **DONE** (patcher add_batch_1101_1110_risk.mjs; RTO score + WHY factors + threshold staff tasks (advisory default), address normalize + ask flow; HANDOFF §169)

- Objective: 0–100 RTO score (customer history, city rate, order value,
  time-to-confirm) with WHY-explanation and configurable thresholds (staff
  task above N); address normalization/missing-detection ask flow.
- Tests: score math fixtures, threshold actions, address prompts. Rollback:
  scoring advisory-only by default.

## B10 — Courier loop (booking → tracking → RTO analytics) — P2 — **DONE** — patcher add_batch_1111_1120_courier.mjs; credentials-ready connector: owner pastes Leopards/TCS keys in the new Courier page -> Save -> Test -> live (HANDOFF §171)

- Objective: adapter interface + TCS + Leopards (PostEx next); COD-YES →
  auto booking; tracking updates pushed into thread + customer; delivery/RTO
  outcome recorded into order analytics; per-courier performance view.
- Needs: owner-provided API credentials; contract tests run against sandbox
  endpoints where providers offer them. Rollback: booking step toggleable.

## B11 — Media + voice (multimodal v1) — P2 — **DONE** — patcher add_batch_1121_1130_media.mjs; media library, WhatsApp image/PDF/audio send (bridge send_media -> Cloud media API), voice-to-text via OMNIFLOW_STT_* env (HANDOFF §172)

- Objective: outbound image/PDF (catalog PDF) via command media payload +
  storage adapter (local disk first); inbound voice-note transcription
  (ur/roman/en) feeding the same KB/AI pipeline; media table with
  tenant/owner/mime/checksum/retention.
- Rollback: media off per tenant; text behavior unchanged.

## B12 — Conversational commerce + workflow generator + command bar — P2

- Objective: natural shopping conversation → search → recommend (cards) →
  checkout → order, inside policy; NL automation generator with preview +
  explicit activation; dashboard AI command bar (safe queries/actions).
- Rollback: all three behind autonomy + per-feature flags.

## B13 — Multi-number/multi-brand + omnichannel prep — P3

- Objective: brands under one tenant (per-brand number, persona, KB, catalog,
  staff routing) with central customer identity; channel-adapter interface
  generalized from the Telegram + WhatsApp adapters.
- Rollback: single-brand tenants unchanged.

## B14 — DONE (user-driven, batch 1161): professional-English UI, AI Brain page, operations analytics, portal speed pack, dynamic courier providers + hybrid booking (auto | draft → human confirm). See HANDOFF §176. The planned template/entitlement B14 below continues as B15.

## B15 — DONE (batch 1181): six vertical template packs + one-click setup wizard with full preview + plans/entitlements layer (legacy-unlimited default, live usage, check() helper for future enforcement). See HANDOFF §178. Vertical template packs shipped: ecommerce, salon, clinic, restaurant, real estate, education (pure data - new verticals are one entry each).

## B16 — DONE (batch 1191): one-way catalog sync from WooCommerce/Shopify (settings + sync-now, upsert by external id, manual items protected) + link-level advance-COD (advance_percent 0-90, public split advance_due/cod_balance). See HANDOFF §179.

## B17 — DONE (batch 1201): plan enforcement live at the capped CREATE endpoints (KB entries, keyword alerts, immediate broadcasts, courier companies — 409 plan_limit, fail-open, legacy untouched) + AI-engine dedupe (Configure AI hosts autonomy/tone; AI Brain page redirects) + grouped sidebar + Overview plan/usage + COD cards + checkout split confirmations (advance receipts + COD balance on progress messages) + era-gap repairs (sequences enroll POST + cancel route, bridge followups/away). See HANDOFF §180.

## B18 — Multi-brand prep + next candidates — P3


- Objective: (next direction discussed with the owner before any build).
- Rollback: entitlement layer defaults to "unlimited" for existing tenants.

## B15 — Catalog sync (Shopify/Woo) + partial advance-COD — P3

- Objective: one-way scheduled catalog pull (name/price/image/stock) +
  sync-now button; checkout option "X% advance + COD balance" with split
  amounts in confirmations and order records.
- Rollback: features off per tenant.

## Batch rules (every batch, no exceptions)

1. Small, safe, reversible; existing features keep working (full sweep green).
2. No hard-coded behavior — settings/config tables + env where sensible.
3. Adapters for anything provider-shaped; core never imports a provider.
4. Tests land with the feature (unit + the batch's acceptance checks).
5. HANDOFF section + USER_CHECKLIST section + rollback notes per batch.
6. Verification before delivery: fresh-apply → idempotent rerun → identity →
   full sweep → tsc → esbuild.
7. AI features degrade gracefully without keys — the laptop must never break
   because a vendor is down or a key expired.
