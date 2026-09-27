# OmniFlow — MASTER UPGRADE PROMPT vs EXISTING PROJECT
## Gap Analysis / Audit (Phase 0 — sirf parha gaya, kuch nahi banaya)

> Prompt: "OMNIFLOW — ULTIMATE MASTER UPGRADE & AI AUTOMATION PLATFORM" (76 sections, 32 engines)
> Compare kiya gaya: existing repo (website+portal+admin), CP ke 64 modules, connector, rig (132 suites / 4366+ checks).
> Status legend: ✅ = pehle se complete · 🟡 = mojood, upgrade chahiye · 🔴 = missing (naya banana hoga)

---

## 0. HEADLINE

- **Prompt ke Phase 0–1 (audit + stabilize) aur §2/§3 ki poori feature list PEHLE SE built hai** — website ke 20 pages, inbox ke 24 features, commerce, admin CMS, auth, tenant isolation: sab verified.
- **32 engines me se: ~3 ✅, ~18 🟡 (seeds exist, centralization/upgrade chahiye), ~11 🔴 (naya build).**
- Sab se bade gaps: **Action Engine (formal), Workflow Engine, Knowledge ingestion+embeddings, Customer Identity, Omnichannel adapters, Business Insights/Problem Detector, AI Cost/Quality/Observability, Admin AI Control Center, Prompt-Injection defense, Agent versioning.**
- Owner locks (§52) already respected: Invoices EXCLUDED · KB auto-publish LOCKED · AI-Assist-First · PK-only payments · channels honest "Coming". ✓

---

## 1. ENGINE-BY-ENGINE STATUS

### ✅ Already strong (rebuild NAHI karna)
| # | Engine | Kya mila |
|---|---|---|
| 14 | Revenue Recovery | abandoned checkout + negotiation (bounded) + followups — CP me live |
| 26 | Consent/Compliance | opt-outs, retention, memory purge ("Forget all"), audit rows |
| 32 | Security baseline | tenant isolation (client_id har jagah, session-derived), sameOrigin+safeJson, rate limits, request-security, admin auth, webhook validation |
| — | §2 Website (20 pages), §3 Inbox (24 features), §8 Commerce, §13 Admin CMS, §51 Multi-tenancy | sab complete + rig-tested |

### 🟡 Exists → upgrade/unify karna hai
| # | Engine | Kya hai abhi | Kya missing hai |
|---|---|---|---|
| 2 | Customer Memory | portal_memory: per-customer memory, purge, journey stages + explanations | confidence, source, timestamp/expiry, memory types (short/long/business/journey), owner-visible editing |
| 3 | Business Brain | portal_brain v1: persona, custom instructions, business profile, policy-checked prompts (refund/discount blocked) | structured context layer: policies/SOPs/pricing/refund+escalation rules as queryable data (giant prompts ki jagah) |
| 4 | Knowledge | portal_kb: Q&A pairs, gaps, owner-approved drafts | **file/URL ingestion (PDF/DOCX/TXT/CSV/website), chunking, EMBEDDINGS, retrieval, versioning, health, re-index** (embeddings: 0 hits — confirmed missing) |
| 5 | Intelligence | intent classifier + sentiment (lexicon/LLM switch) | **shared IntelligenceResult schema** (intent/sentiment/language/purchase_intent/urgency/confidence) — purchase_intent/urgency/confidence: 0 hits; centralization nahi |
| 7 | Action Engine | **portal_brain v1 tools = seed!** (tool_recent_messages, tool_customer_orders, tool_search_kb + policy + provenance) | formal registry: 35+ actions, input/output schemas, permissions per agent, risk levels (LOW/MED/HIGH), approval flow, idempotency, retry/timeout, unified audit |
| 8 | Policy/Rule | negotiation bounds, business hours, routing/listen rules, brain policy | generic executable rule engine (IF/AND/OR/branches/delays/escalation) |
| 10 | Sales Agent | reco + negotiation + checkout + catalog | dedicated agent: qualify, objections, compare, quotes, lead updates, follow-up loop |
| 11 | Support Agent | assist (intent/sentiment/reply/context) + CSAT | knowledge **citations/traceability**, complaint flows, escalation summary |
| 12 | Commerce Ops Agent | COD risk, address normalize, courier, restock, orders | policy-checked autonomous flows ("order cancel karna hai" → policy → permission → action) |
| 13 | Follow-up Agent | followup agent + sequences | context-aware stops (purchased? opt-out? human took over? duplicate?) — verify |
| 15 | Retention | winback + churn + sequences + segments | centralized retention system (reorder/loyalty/personalized offers) |
| 16 | Proactive AI | digest, order updates, restock alerts, winback triggers | formal event-driven proactive engine (business alerts: unavailable product demand, repeated complaints) |
| 19 | Journey Intelligence | journey stages + explanations | funnel/drop-off analytics (Visitor→…→VIP/Churn) with revenue linkage |
| 21 | Handoff | auto-assign, routing, needs-reply | **centralized escalation**: reason codes (low-confidence/angry/VIP/risk), human ko ready-made context summary |
| 22 | Voice Agent | inbound calls, voicemail recordings, outbound, video rooms (Twilio) | **speech conversation loop** (Gather/speech→intent→agent→response), voice actions, same brain/memory |
| 24 | Omnichannel | WhatsApp LIVE (Baileys→CP), baaki honest "Coming" | **channel adapter interface** (receiveMessage/sendMessage/…8 ops) + message normalizer + identity linking — AI layer channel-agnostic banana |
| 25 | Notifications | email (admin), WhatsApp, alerts module, desktop alerts, opt-outs | central engine: templates+variables, per-channel prefs, rate limits, delivery status |
| 27 | Audit Log | per-module audit rows (events) | unified AI-action audit: who/what/why/agent/model/input/decision/approval |
| 29 | Evaluation | 132 suites / 4366+ checks (structural+API) | **AI behavioral tests**: knowledge accuracy, tool-calling correctness, permission enforcement, workflow execution, injection defense, channel normalization |
| 31 | Observability | portal_obs: trace-id + slow-request JSON logs | agent execution traces: conversation→agent→tool→result→decision→response |
| 64 | Analytics split | analytics/revenue/service/one-reply/CSAT | AI quadrant (agent usage, confidence, cost, tool calls) + automation quadrant (workflow executions) |

### 🔴 Missing entirely (naya build)
| # | Engine | Kya banana hai |
|---|---|---|
| 1 | Customer Identity | ✅ §197 portal_identity: cross-channel handles (whatsapp/phone/email/instagram/facebook/tiktok/web/other) normalised + confidence/source, `resolve()` adapters ke liye, duplicate detection (same_phone/same_name), SOFT reversible merge/split + audit; legacy links imported |
| 6 | Agent Router | centralized router (Support/Sales/Lead/Commerce/Order/Recovery/Retention/Followup/Ops) — isolated per-feature AI nahi |
| 9 | Workflow Engine | trigger→condition→AI decision→action→wait→goal — automations+sequences+recovery+winback+restock+followups unify (sab alag modules abhi) |
| 17 | Business Insights | conversation/order mining → actionable insights ("31% delivery time pooch rahe hain") — evidence-based |
| 18 | Problem Detector | knowledge gaps (seed hai) + sales bottlenecks, delivery problems, pricing objections, churn patterns → Problem/Evidence/Impact/Confidence/Action |
| 20 | AI Quality | resolution rate, escalation rate, latency, low-confidence answers, "ye sawal main nahi janta" reporting |
| 23 | Vision/Media | image understanding (damaged product, screenshots) — transcribe seed hai, vision nahi |
| 28 | AI Cost/Usage | tokens/cost/latency per workspace/agent/model/conversation (0 hits) — SaaS billing ke liye zaroori |
| 30 | Agent Versioning | draft/test/published/previous/rollback |
| 50 | Prompt-Injection Defense | customer message = untrusted content layer; system rules override-proof; injection test suite |

### Admin/UX upgrades (§53–57) — sab 🔴 (backend engines ke baad)
- **AI Control Center** page (agents/workflows/knowledge/actions/permissions/approvals/usage/cost)
- **Agent Configuration** UI (name/role/goal/tone/language/allowed-forbidden actions/hours)
- **AI Action Permissions** UI (Support: ✓read/send ✗refund — Action Engine se driven)
- **Workflow Builder** ✅ (§196: custom lightweight canvas — backend Workflow Engine ka representation, koi heavy lib nahi)
- **Industry Templates** ✅ (§196: VERTICAL_PACKS + 21 workflow templates, config-driven, hardcoded nahi; baqi industries = data add karna)

---

## 2. PHASES vs PROJECT (§67)

| Phase | Status |
|---|---|
| 0 Audit | YE document |
| 1 Stabilize | 🟡 lagbhag stable (4366 checks green); bache: laptop pe connector E2E, weekly report send-now, provider-keys admin inputs (purani batch list) |
| 2 Core Engines | 🟡 Identity ✅ (§197), Memory 🟡, Business Brain 🟡, Intelligence 🟡, Router 🔴, **Action 🟡(formalize)**, Policy 🟡 |
| 3 Workflow | 🔴 (seeds: sequences/automations/recovery/followups/winback/restock) |
| 4 Agents | 🟡 (capabilities hain; "agents" as configs+router nahi) |
| 5 Actions wiring | 🟡 (sab target APIs already hain — catalog/orders/payments/courier/CRM; Action Engine me wrap karna hai) |
| 6 Omnichannel | 🔴 (WA live; IG→Messenger→Email→TG→TikTok→SMS order) |
| 7 Proactive | 🟡 upgrade |
| 8 BI | 🔴 (data collected hai — events/rollups/analytics; insight generation nahi) |
| 9 AI Workforce UI | 🔴 |
| 10 Voice/Vision | 🟡 / 🔴 |

---

## 3. RECOMMENDED ORDER (dependency-based, §68 ke mutabiq)

1. **Phase-1 leftovers** (connector E2E laptop, weekly trigger, provider keys UI)
2. **Intelligence Engine** — shared IntelligenceResult schema; insights/intents ko consolidate (kam risk, sab kuch isi pe kharega)
3. **Action Engine v1** — portal_brain ke existing 3 tools ko formal registry me le aao; phir read-only actions → MEDIUM (lead/tag/followup) → HIGH (refund/cancel/campaign) **+ approval inbox + audit + idempotency**
4. **Policy/Rule Engine** — bounds/business-hours/routing ko ek executable engine me
5. **Business Brain v2** — structured business context (policies/SOP/pricing) jo prompts ko feed kare
6. **Memory Engine upgrade** — confidence/source/expiry/types
7. **Agent Router + Agents** — Support/Sales/Commerce/Recovery/Retention/Followup = router ke upar configs (naya AI system nahi)
8. **Workflow Engine v1** ✅ (§195) — existing automations/sequences ko workflow records me lift; trigger+action library
9. **Identity Engine** ✅ (§197) — cross-channel ki tayari (adapters se pehle zaroori)
10. **Knowledge Engine** — ingestion pipeline + embeddings + retrieval + versioning (owner-approval law qayam)
11. **Handoff + Notifications + Audit + Cost/Usage + Observability** (platform services)
12. **BI layer** — Insights + Problem Detector + AI Quality + Journey funnel
13. **Omnichannel adapters** (IG pehle) — Workflow/Identity/Action engines ready hone ke BAAD
14. **Voice Agent loop + Vision**
15. **Admin AI Control Center + Agent Config + Permissions UI** + ~~Workflow Builder + Templates~~ ✅ (§196)
16. **Eval expansion + Agent versioning/rollback**

---

## 4. ZAROORI DATABASE / API / UI CHANGES (andaza)

**DB (CP lazy-DDL convention):** customer_identities (+merge audit), memory cols (confidence/source/expires), kb_sources/kb_chunks/kb_embeddings, actions registry + action_audits, approvals, workflows/workflow_steps/workflow_runs, rules, agent_configs (+versions), insights, ai_usage, notifications_prefs, channel_accounts, intelligence cache.

**API (CP):** /portal/workflows (CRUD+runs), /portal/agents (config+permissions), /portal/actions (catalog+invoke), /portal/approvals, /portal/insights, /portal/ai/usage, /portal/identity (merge), /portal/kb/sources, /admin/ai/… (control center), per-channel webhooks.

**UI (portal/admin):** AI Control Center, My AI Workforce, Workflows list+builder, Approvals inbox, Insights page, Identity merge UI, KB Sources UI, Usage/Cost card, Agent permissions editor.

---

## 5. OPEN QUESTIONS (confusion — jawab chahiye)

1. **KB embeddings**: Gemini embeddings use karein? (cost/keys) — ya pehle sirf keyword-search retrieval?
2. **HIGH-risk approvals**: portal me "Approval inbox" (owner ek click me approve/reject) — theek hai?
3. **Templates**: kaunsi industries pehle? (meri suggestion: Ecommerce + Local Business — PK focus)
4. **Voice AI loop + Vision**: is upgrade round me ya baad me? (Gemini multimodal chahiye hoga)
5. **Workflow Builder visual canvas**: ~~Phase-3 me simple list-based UI kaafi hai ya shuru se drag-drop canvas chahiye?~~ → D6 custom canvas delivered (§196)

---

*Ye audit sirf parhne/compare se bana hai — koi code nahi likha gaya. Implementation sirf aapke GO ke baad, isi order se, har engine ke saath rig suites + patcher law follow karte hue.*
