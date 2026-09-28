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
| 4 | Knowledge | ✅ §198 portal_knowledge: sources (paste/TXT-MD-CSV-JSON-HTML upload/website URL) + versions/rollback + heading-aware chunking + ranked keyword retrieval (entries + published sections, ONE query) + health/re-index + owner tester; drafts until owner publishes | EMBEDDINGS (D1 deferred; retrieve() contract ready), PDF/DOCX parsing, scheduled re-fetch |
| 5 | Intelligence | intent classifier + sentiment (lexicon/LLM switch) | **shared IntelligenceResult schema** (intent/sentiment/language/purchase_intent/urgency/confidence) — purchase_intent/urgency/confidence: 0 hits; centralization nahi |
| 7 | Action Engine | portal_actions registry (risk levels, approvals, audit) + ✅ §201 per-agent permissions enforced (allowed_actions / max_risk / can_auto_reply → `denied` before the approval gate; brain tools + workflow steps pass their persona) | idempotency keys, retry/timeout budget, more actions |
| 8 | Policy/Rule | negotiation bounds, business hours, routing/listen rules, brain policy | generic executable rule engine (IF/AND/OR/branches/delays/escalation) |
| 10 | Sales Agent | reco + negotiation + checkout + catalog | dedicated agent: qualify, objections, compare, quotes, lead updates, follow-up loop |
| 11 | Support Agent | assist (intent/sentiment/reply/context) + CSAT + knowledge citations in brain trace (§198) | complaint flows, escalation summary |
| 12 | Commerce Ops Agent | COD risk, address normalize, courier, restock, orders | policy-checked autonomous flows ("order cancel karna hai" → policy → permission → action) |
| 13 | Follow-up Agent | followup agent + sequences | context-aware stops (purchased? opt-out? human took over? duplicate?) — verify |
| 15 | Retention | winback + churn + sequences + segments | centralized retention system (reorder/loyalty/personalized offers) |
| 16 | Proactive AI | digest, order updates, restock alerts, winback triggers | formal event-driven proactive engine (business alerts: unavailable product demand, repeated complaints) |
| 19 | Journey Intelligence | journey stages + explanations | funnel/drop-off analytics (Visitor→…→VIP/Churn) with revenue linkage |
| 21 | Handoff | ✅ §199 portal_escalation: one `escalate()` for brain (needs_human/low_confidence/policy), workflows, knowledge gaps, owner; reason codes + severity, persona escalation target, one open per chat, ledger + audit + owner notify, Handoffs card | ready-made context summary for the human (BI batch), auto-resolve on human reply |
| 22 | Voice Agent | inbound calls, voicemail recordings, outbound, video rooms (Twilio) | **speech conversation loop** (Gather/speech→intent→agent→response), voice actions, same brain/memory |
| 24 | Omnichannel | WhatsApp LIVE (Baileys→CP), baaki honest "Coming" | **channel adapter interface** (receiveMessage/sendMessage/…8 ops) + message normalizer + identity linking — AI layer channel-agnostic banana |
| 25 | Notifications | ✅ §199 portal_notify: bell + tenant opt-in email + ledger with delivery status, per-kind prefs + severity threshold, test send; used by escalations/approvals/dead deliveries/failed runs | templates+variables, rate limits (dedupe covers floods today) |
| 27 | Audit Log | ✅ §199 portal_ai_audit read model over portal_action_log: categories registry, actor kinds, timeline + overview (approvals pending, handoffs open, usage) on Configure AI | per-row agent/model/input linkage (brain traces already carry grounding; join later in Control Center) |
| 29 | Evaluation | 132 suites / 4366+ checks (structural+API) | **AI behavioral tests**: knowledge accuracy, tool-calling correctness, permission enforcement, workflow execution, injection defense, channel normalization |
| 31 | Observability | portal_obs: trace-id + slow-request JSON logs | agent execution traces: conversation→agent→tool→result→decision→response |
| 64 | Analytics split | analytics/revenue/service/one-reply/CSAT | AI quadrant (agent usage, confidence, cost, tool calls) + automation quadrant (workflow executions) |

### 🔴 Missing entirely (naya build)
| # | Engine | Kya banana hai |
|---|---|---|
| 1 | Customer Identity | ✅ §197 portal_identity: cross-channel handles (whatsapp/phone/email/instagram/facebook/tiktok/web/other) normalised + confidence/source, `resolve()` adapters ke liye, duplicate detection (same_phone/same_name), SOFT reversible merge/split + audit; legacy links imported |
| 6 | Agent Router | centralized router (Support/Sales/Lead/Commerce/Order/Recovery/Retention/Followup/Ops) — isolated per-feature AI nahi |
| 9 | Workflow Engine | trigger→condition→AI decision→action→wait→goal — automations+sequences+recovery+winback+restock+followups unify (sab alag modules abhi) |
| 17 | Business Insights | ✅ §200 portal_bi: topic lexicon over inbound messages (share/trend/real examples), sentiment/purchase-intent mix, gaps, COD/checkout/delivery/SLA/CSAT signals; /dashboard/insights |
| 18 | Problem Detector | ✅ §200 detect_problems: 16 env-tunable rules (gaps, delivery/price/complaint topics, negative tone, AI handoff/policy/engine, handoffs rising/unassigned, COD declines, unpaid checkouts, delivery failures, slow replies, CSAT, journey stall) → Problem/Evidence/Impact/Confidence/Action with deep links; churn patterns stay in portal_churn |
| 20 | AI Quality | ✅ §200 ai_quality: resolution rate (answered chats never escalated), handoff share + reasons, avg confidence, grounded/cited share, engine failures + latency, CSAT after AI, unanswered questions list |
| 23 | Vision/Media | image understanding (damaged product, screenshots) — transcribe seed hai, vision nahi |
| 28 | AI Cost/Usage | ✅ §199 portal_ai_usage: per-call tokens/latency/ok per workspace/feature/model via portal_llm.usage_scope; estimated cost from admin price table (honest "not configured" otherwise); usage card | per-agent/per-conversation split, billing hooks (plans) |
| 30 | Agent Versioning | ✅ §201 portal_agent_versions: append-only snapshot per save, list + rollback (restore = new version, history never rewritten) | draft/test states before publish, workflow rollback endpoint |
| 50 | Prompt-Injection Defense | customer message = untrusted content layer; system rules override-proof; injection test suite |

### Admin/UX upgrades (§53–57) — sab 🔴 (backend engines ke baad)
- **AI Control Center** page ✅ (§201 /admin/ai-control: global pause + autonomy cap + daily call cap, per-workspace AI table with autonomy override, pending approvals / open handoffs / usage + cost, recent AI activity)
- **Agent Configuration** UI ✅ (Team → Agents: name/role/goal/tone/language + §201 permissions + version history/restore; hours pending)
- **AI Action Permissions** UI ✅ (§201 registry checklist + max risk + auto-reply switch per agent — Action Engine se driven, enforced server-side)
- **Workflow Builder** ✅ (§196: custom lightweight canvas — backend Workflow Engine ka representation, koi heavy lib nahi)
- **Industry Templates** ✅ (§196: VERTICAL_PACKS + 21 workflow templates, config-driven, hardcoded nahi; baqi industries = data add karna)

---

## 2. PHASES vs PROJECT (§67)

| Phase | Status |
|---|---|
| 0 Audit | YE document |
| 1 Stabilize | 🟡 lagbhag stable (4366 checks green); bache: laptop pe connector E2E, weekly report send-now, provider-keys admin inputs (purani batch list) |
| 2 Core Engines | 🟡 Identity ✅ (§197), Knowledge ✅ (§198, embeddings deferred), Memory 🟡, Business Brain 🟡, Intelligence 🟡, Router 🔴, **Action 🟡(formalize)**, Policy 🟡 |
| 3 Workflow | 🔴 (seeds: sequences/automations/recovery/followups/winback/restock) |
| 4 Agents | 🟡 (capabilities hain; "agents" as configs+router nahi) |
| 5 Actions wiring | 🟡 (sab target APIs already hain — catalog/orders/payments/courier/CRM; Action Engine me wrap karna hai) |
| 6 Omnichannel | 🔴 (WA live; IG→Messenger→Email→TG→TikTok→SMS order) |
| 7 Proactive | 🟡 upgrade |
| 8 BI | ✅ §200 (portal_bi read model: insights + problems + AI quality + funnel; narrative summaries deferred) |
| 9 AI Workforce UI | 🟡 (agents editor + permissions + versions + Control Center ✅ §201; per-agent quality/cost split pending) |
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
10. **Knowledge Engine** ✅ (§198) — ingestion pipeline + keyword retrieval + versioning (owner-approval law qayam; embeddings D1 deferred)
11. **Handoff + Notifications + Audit + Cost/Usage + Observability** ✅ (§199 platform services; observability = usage ledger latency/failures + escalation summary; agent execution traces stay in brain traces)
12. **BI layer** ✅ (§200) — Insights + Problem Detector + AI Quality + Journey funnel
13. **Omnichannel adapters** (IG pehle) — Workflow/Identity/Action engines ready hone ke BAAD
14. **Voice Agent loop + Vision**
15. **Admin AI Control Center + Agent Config + Permissions UI** ✅ (§201) + ~~Workflow Builder + Templates~~ ✅ (§196)
16. **Eval expansion** (AI behavioral suite + injection defense) + ~~Agent versioning/rollback~~ ✅ (§201)

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
