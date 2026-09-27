# OmniFlow V2 — Target Architecture

> Binding engineering principles (owner directives, apply to every batch):
> **lightweight** (no heavy dependencies, no always-on infra beyond Postgres),
> **zero hard-coding** (behavior comes from configuration tables/settings the
> owner can change), **flexible** (every new capability is an adapter/interface
> so providers can be swapped), and **handover-ready** (a professional
> developer must be able to read any module top-to-bottom and understand it —
> docstrings, typed contracts, no "AI-looking" one-letter soup, tests as
> documentation).

## 1. Component view (V2 adds 3 runtimes, changes none)

```
                    ┌─────────────────────────────────────────────┐
                    │  WEBSITE (Next.js)                          │
                    │  dashboard · public order page · admin CMS  │
                    └──────────────┬──────────────────────────────┘
                                   │ BFF (server handlers)
                    ┌──────────────▼──────────────────────────────┐
                    │  CONTROL PLANE (Flask + Postgres)           │
                    │  portal_* REST  ·  public_*  ·  connector_* │
                    │  ┌─────────────┐  ┌──────────────────────┐  │
                    │  │ EVENT CORE  │  │ AI ORCHESTRATOR      │  │
                    │  │ (B1)        │  │ intent·tools·policy  │  │
                    │  └─────────────┘  │ (B3/B6)              │  │
                    │  ┌─────────────┐  └──────────────────────┘  │
                    │  │ WORKER      │  job runner inside CP      │
                    │  │ loop (B1)   │  (same process, thread)    │
                    │  └─────────────┘                             │
                    └──────────────┬──────────────────────────────┘
                                   │ poll + ack (unchanged) → event push (B1)
                    ┌──────────────▼──────────────────────────────┐
                    │  CONNECTOR BRIDGE                           │
                    │  adapters: WhatsApp · WATI · Cloud · Telegram│
                    └──────────────┬──────────────────────────────┘
                                   │
                        CUSTOMERS (WhatsApp first)
```

Deliberately lightweight: no Redis, no Celery, no Kafka. The event core is
Postgres tables + a small worker thread inside the Control Plane process
(`SELECT … FOR UPDATE SKIP LOCKED`). When scale demands it, the worker can be
extracted to a standalone process with zero table changes.

## 2. Event core (B1) — the reliability backbone

Two tables (`portal_events`, `portal_commands` extension):

- **Inbound events** (`portal_events`): `event_id` (uuid), `idempotency_key`
  (provider message id or hash), `tenant_id`, `event_type`, `status`
  (`received → processing → done | failed | dead`), `attempts`, `next_attempt_at`,
  `error_code`, `error_message`, `payload jsonb`, timestamps. Unique index on
  `(tenant_id, idempotency_key)` makes every ingest idempotent — duplicate
  webhooks can no longer create duplicate messages/orders/replies.
- **Outbound commands** gain: `idempotency_key`, `status`
  (`queued → sent → delivered | failed | dead`), `attempts`, `next_attempt_at`,
  `provider_message_id`, `error_code/message`. The bridge ack upgrades status;
  a retry sweep re-queues failures with exponential backoff (max attempts →
  `dead`). Failed `dead` items are visible + replayable in the dashboard (B5
  adds alerting).
- Worker thread: every second, claims due events/commands with
  `FOR UPDATE SKIP LOCKED`, runs them, records outcome. The bridge keeps
  polling — **nothing breaks during migration**; commands simply get a
  reliability wrapper first, and hooks move onto events incrementally.
- Every consumer stays a plain function `(event, ctx) -> outcome` — easy to
  test, easy to hand over.

## 3. AI orchestration layer (B3 → B6 → B8)

```
inbound message ──► INTENT ENGINE ──► CONTEXT ASSEMBLER ──► REASONER ──► TOOL CALLS ──► POLICY CHECK ──► EXECUTE ──► VERIFY ──► REPLY
                     (B3)              memory+journey+KB      (B6)        (B6)          (B6)                        (B6)
```

- **Provider-agnostic LLM adapter** (`ai/llm.py`): OpenAI-compatible REST via
  env config (`OMNIFLOW_AI_BASE_URL`, `OMNIFLOW_AI_MODEL`, `OMNIFLOW_AI_KEY`).
  No SDK dependency (keeps it lightweight); timeouts + token budgets + circuit
  breaker; **graceful degradation** — with no key configured, every AI feature
  falls back to the current rule/keyword behavior (nothing breaks, laptop can
  enable AI by adding one env var).
- **Intent engine (B3)**: rule fast-path (existing regex/keywords) → LLM
  classifier fallback with a fixed taxonomy (the ~27 intents from the V2
  directive) + custom business intents stored per tenant. Every UNCLEAR
  outcome is logged + flagged to staff (no silent drops).
- **Tools (B6)**: plain Python callables with a JSON-schema-ish signature,
  registered per capability (`get_customer`, `search_orders`, `create_checkout`,
  `apply_coupon`, `send_template`, `escalate_to_human`, …). Every tool call:
  schema validation → tenant check → policy check → execute → result
  verification → audit row (`ai.action` with prompt ref, tool, args, result,
  confidence, policy decision). Read-only tools ship first; write tools enable
  per owner policy; **money/refund tools are ALWAYS approval-gated**.
- **Policy engine (B6)**: per-tenant table `ai_policies` (AUTO / ASK / NEVER
  per tool + thresholds like max discount %, max refund). Owner-editable in
  Settings; defaults are conservative (NEVER for destructive actions).
- **Confidence & grounding (B6)**: reasoner must answer from retrieved
  context (business config → catalog → order/customer data → approved KB);
  below the confidence threshold it asks a clarifying question or escalates —
  never invents. Answers carry provenance (which source, when retrieved).
- **Autopilot levels (B8+)**: `ai_policies.autonomy` 1–4 mapping exactly to
  the directive (recommend → low-risk execute → sales/support workflows →
  defined operations), with a global pause switch per tenant.

## 4. Memory, journey, explainability (B7)

- `portal_customer_memory`: structured, editable, deletable rows per customer
  (language, interests, AOV, stage, next action, summary) — written by AI
  steps and automations, visible in Customer 360, purgeable via existing
  data-safety endpoints.
- `portal_journey`: configurable stage pipeline (default = the 13-stage
  lifecycle from the directive; owner can rename/add). Journey transitions are
  events → automations and analytics read the same truth.
- Every significant AI action renders an explain card in the inbox
  (WHAT/WHY/DATA/CONFIDENCE/ACTION/RESULT) — data comes straight from the
  audit row, so nothing is hand-waved.

## 5. Integration adapters (provider swap = config, not code)

| Adapter | Interface | Implementations |
|---|---|---|
| WhatsApp provider | `send_text / send_media / send_interactive / send_template / parse_webhook` | Legacy gateway, WATI, Meta Cloud API |
| LLM | `complete(messages, tools, budget)` | Any OpenAI-compatible endpoint |
| Courier | `create_booking / track / serviceability / cancel` | TCS, Leopards, PostEx (B10 starts with 2) |
| Storage | `put / get / delete` (media abstraction, B11) | Local disk first; S3-compatible later |
| Catalog source | `pull_products()` | Manual (today), Shopify, WooCommerce (B15) |

Each adapter = one small module behind an interface + config table row; new
providers never touch core logic.

## 6. Data flow after V2 (the unified loop)

```
customer msg → ingest → IDEMPOTENT event → pipeline stages (normalize → resolve →
language → intent → compliance → context → AI → policy → tool/automation → verify)
→ reply via provider adapter → provider ack → delivery status → memory/journey update
→ audit + analytics events → rollups → dashboards/brief/recovery recommendations
```

Every stage boundary writes an event status, so any message can be traced
end-to-end by `trace_id` (B4 adds structured logs carrying it).

## 7. Performance architecture (fixes the 3–4 s portal)

- **Day-0 ops** (documented in CURRENT_STATE §9): production Next build + a
  properly sized Gunicorn (`-w 2 --threads 8` to start).
- **B4**: aggregate endpoints for heavy pages (Growth 20 calls → 2–3),
  hourly/daily rollup tables + a nightly refresh job, short-TTL response
  cache for dashboards, structured request logs with durations.
- **B7+**: journey/memory reads are indexed single-row lookups; conversation
  pagination stays cursor-based (already bounded).
- Budget: owner-facing pages should render from cached/rolled-up data in
  <300 ms server time; a synthetic 50k-conversation tenant benchmark lands in
  B4's test suite.

## 8. Migration strategy (nothing breaks, ever)

1. Event core wraps the existing command queue (B1) — behavior identical,
   reliability added.
2. Ingest pipeline refactors into named stages (B2) — same hooks, same order,
   one-reply law added.
3. AI features ship **behind env-key availability** with rule fallbacks —
   owners opt in by adding keys, never by upgrading code.
4. portal.ts split happens behind a re-export barrel — call sites unchanged.
5. Rollups/caching are additive; on-request compute stays as fallback.
6. Every batch keeps the existing discipline: patcher, idempotency, backup +
   compile guard, identity checks, full sweep, tsc/esbuild, HANDOFF + checklist
   + rollback notes.
