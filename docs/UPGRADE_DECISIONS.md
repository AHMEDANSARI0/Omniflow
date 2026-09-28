# OmniFlow Master Upgrade — LOCKED DECISIONS (owner-approved)
> Source: owner answers on the gap-analysis questions (docs/MASTER_UPGRADE_GAP_ANALYSIS.md).
> Ye document implementation batches ki single source of truth hai. Production ko touch nahi kiya.

## D1 — KB Embeddings: DEFERRED
- Vector/embeddings abhi NAHI. Knowledge retrieval pehle keyword/search-based rahega.
- Jab KB Sources/ingestion batch aaye, tab dobara evaluate hoga (owner approval ke saath).

## D2 — Admin AI/API Keys Panel ✅ DELIVERED (STT gap filled)
- Raj: platform_settings mechanism pehle se DB-backed + live tha (email/llm/voice/video/flags). Gap sirf STT ka tha — ab stt group + panel card + portal_media DB-first resolve. Courier keys workspace-scoped by design (portal Settings > Courier). SERVICE/ADMIN/DB keys env-only (lock-out risk).
- Rig: test_admin_keys.py 12 checks; sweep 133/133, 4379 PASS.
- Maqsad: owner ko code/env edit kar ke push na karna pade — **key admin panel me paste → save → live** (bina redeploy).
- Scope (platform-level keys, DB-backed settings me encrypted-at-rest; env fallback jab DB value na ho — kabhi break nahi hoga):
  - **AI**: OF_LLM_API_KEY (Gemini), OMNIFLOW_STT_API_KEY (speech-to-text/transcribe)
  - **Voice/SMS**: Twilio Account SID + Auth Token
  - **Email**: SMTP_HOST / PORT / USER / PASSWORD / FROM
  - **Courier**: Leopards api_key + password; TCS credentials (jo hon)
  - Panel me ye sirf DISPLAY-note rahega (env-only, editable NAHI): OMNIFLOW_SERVICE_KEY, OMNIFLOW_ADMIN_API_KEY, DB_*
- Save per key (masked input, "saved ✓ live" feedback), audit row per change.
- Workspace-level keys (JazzCash/Easypaisa etc.) pehle se portal Settings me hain — wo system waisa hi rahega.
- Ye standing "provider keys admin inputs" batch-item ko bhi absorb karta hai.

## D3 — Approvals: Portal Inbox + WhatsApp 1/0 flow ✅ DELIVERED
- portal_approvals CP module + ingest hooks (claim-first 1/0 loop + keyword producer) + portal APIs + Approvals page + sidebar. Rig: test_approvals.py 33 checks; sweep 134/134, 4412 PASS.
- HIGH-risk actions ke liye **Approval Inbox** (portal me) + **WhatsApp approval**:
  - Approval request → owner ke WhatsApp par message: customer ka **name + basic details + asli query** + kya action maanga gaya + short ref code.
  - Owner **"1" reply = approve, "0" = reject** (buttons bhi ho sakte hain jab channel support kare).
  - Reply matching: sender (approver jid) + ref code; agar ek se zyada pending hon to code zaroori. Stale/expired requests ka clear state.
  - Reject hone par AI customer ko polite hold-message bhejta hai (jaise "aapki request owner se tasdeeq ke liye bheji gayi hai").
  - Sab approvals ka audit log (kaun, kab, kaise — portal/WhatsApp).
- Design detail (mine): request message me ref code hoga; 1/0 simple path multiple-pending case me code maangega.

## D4 — Industry Templates: Ecommerce + Local Business pehle ✅ DELIVERED (§196)
- Config/template architecture (koi per-industry hardcoded system NAHI). Baqi industries baad me.
- Delivered: V2 B15 VERTICAL_PACKS (ecommerce/salon/clinic/restaurant/real_estate/education) ab workflow drafts bhi seed karte hain (portal_workflows.WORKFLOW_TEMPLATES 21, vertical-tagged data, `seed_templates` = drafts only, savepoint fail-soft); Workflows page ka template picker applied pack ke hisaab se group hota he. Koi parallel template system nahi.

## D5 — Voice AI loop + Vision: DEFERRED (this round)
- Voice speech-loop (Gather/speech→intent→agent) aur Vision dono substantial hain — agli rounds ke liye.
- Existing voice infra (inbound, voicemail recordings, outbound, video) waisa hi chalta rahega.

## D6 — Workflow Builder: shuru se professional, custom lightweight canvas ✅ DELIVERED (§196)
- **Koi heavy drag-drop library NAHI** (bundle weight) — custom minimal canvas (SVG/DOM + pointer events).
- Hard rules owner-set: lightweight code · site extremely fast/responsive · simple minimal animations · professional enterprise UI.
- Nodes (initial): Trigger, Condition, AI Decision, Action, Wait, Branch, Approval, Human Handoff, Goal/Stop.
- Delivered: workflow-model.ts (pure model, rig-tested against the CP's own templates) + WorkflowCanvas (DOM nodes + SVG edges, pointer-capture drag, keyboard, zoom, reachability/issue overlays) + StepInspector; zero new dependencies (rig pins package.json). Runner/step model unchanged.

## D7 — Website UI polish pass (PENDING owner answer)
- Owner ne purani UI me "box aur text ka color same / ajeeb structure / unprofessional" ka zikr kiya.
- Confirm chahiye: ye current naye light-redesign ke masle hain ya purani wali ki baat? Agar current ho to ek **UI-polish batch** add hoga: contrast audit (sab text/bg pairs), spacing/hierarchy system, structure cleanup — "professional developer" standard.

## D7-UPDATE — UI polish batch CONFIRMED
- Owner: masle NAYI light site me bhi hain (box/text same color, structure). Ek UI-polish batch hoga:
  contrast audit (sab text/bg pairs), spacing/hierarchy scale, structure cleanup — professional standard.
- Voice/Vision (D5) deferred rehta hai (substantial work).

## Build order (owner ke faislon ke mutabiq)
1. **Admin Keys Panel** (D2) — **GO mil gaya (owner)** — pehla batch, AB shuru
1b. **UI-polish batch** (D7) — keys ke baad
2. **Approvals: Inbox + WhatsApp 1/0** (D3)
3. Intelligence Engine (shared schema) ✅ + Action Engine v1 ✅ (D3 approvals ke saath wired)
   - portal_intelligence (16 checks) + portal_actions (20 checks); HIGH-risk = approval-gated; approvals fix (blueprint registration) included.
3b. Policy/Rule Hub ✅ (engine 8): portal_policy shared evaluator + rule_fired unified audit + Rules hub page (7 families, deep links, dry-run tester); routing/listen ab unified audit likhte hain. test_policy 32 checks.
   - portal_intelligence (16 checks) + portal_actions (20 checks); HIGH-risk = approval-gated; approvals fix (blueprint registration) included.
4. Business Brain v2 ✅ (structured business context): portal_brain_facts (policy|sop|pricing|refund|escalation|hours) + tool_business_facts (reasoner ka 5th tool) + facts CRUD API (soft delete) + FactsCard on Configure AI. test_brain 87 checks.
5. Memory upgrade ✅: portal_customer_memory + mtype (short|long|business|journey) / source / confidence / expires_at (lazy ALTER, data preserved), journey-type auto-notes on stage moves, brain ka 6th read-only tool (tool_customer_memory, expiry-aware), Memory card type+expiry controls. test_memory 103 + test_brain 92.
5b. Router + Agents ✅: portal_agents (AI personas - tone/instructions/escalation, versioned, soft-archive, human-only) + routing rules target_type (user|agent) + agent_id (lazy ALTER); agent rules assign conversations to a persona; brain answers in that persona (agent_persona grounding + tone override). test_agents 41 + test_brain 96.
5c. Workflow Engine v1 ✅: portal_workflows (5 tables lazy DDL, versioned, tenant-scoped) rides the poll loop (no worker); 8 triggers (ingest + portal_action_log stream with loop guard) x 9 step kinds (condition/branch via portal_policy.evaluate, ai_decision via chat_json, action via portal_actions.execute incl. HIGH -> approval gate, wait, approval, handoff, goal, stop); +5 MEDIUM registry actions; 4 catalog templates; /dashboard/workflows list + form-based step editor + runs timeline. test_workflows 134.
   - Next: Workflow Builder canvas (D6) on top of the same step model
5. Workflow Engine v1 ✅ → Workflow Builder UI (D6) ✅ + Templates (D4) ✅ (§196)
6. Identity Engine ✅ (§197: portal_identity - normalised handles + confidence/source, resolve() for adapters, duplicate hints, SOFT reversible merge/split with audit; legacy /contacts/link imported + kept in sync; hard /customers/merge untouched)
6b. Knowledge Engine ✅ (§198: portal_knowledge - sources text|file|url + versions/rollback + heading-aware chunking + ONE ranked keyword retrieval over entries + published sections, SSRF-guarded URL fetch, health/re-index, owner-approval law: drafts until published; brain citations in trace; D1 embeddings deferred - same retrieval contract)
6c. Platform services ✅ (§199: portal_escalation - ONE handoff path for brain/workflows/kb gaps with persona target + ledger + audit; portal_notify - bell + tenant opt-in email + ledger, reused by escalations/approvals/dead deliveries/failed runs; portal_ai_usage - per-call tokens/latency/cost via portal_llm.usage_scope, admin price table; portal_ai_audit - unified AI activity read model + overview)
6d. BI layer ✅ (§200: portal_bi read model - topic lexicon insights with evidence + trend, Problem Detector 16 rules -> Problem/Evidence/Impact/Confidence/Action, AI quality from brain traces + escalations + usage, journey funnel from portal_memory events; zero LLM cost; /dashboard/insights)
6e. Admin AI Control Center + agent permissions + versioning/rollback ✅ (§201: platform_settings group ai kill switch / autonomy cap / daily call cap enforced in portal_llm gate + brain effective autonomy; per-agent allowed_actions / max_risk / can_auto_reply enforced in portal_actions.execute + brain draft-only; portal_agent_versions append-only history + rollback; admin_ai overview + per-workspace autonomy override with owner notification)
6f. Prompt-injection defense + AI behavioral evaluation ✅ (§203: `portal_guard` detects English/Roman-Urdu/role-marker/encoded manipulation, sanitises untrusted context, blocks output leaks, records `ai.guard_blocked`, and supports DB/env-backed `guard_mode` off|standard|strict; `portal_ai_eval` runs 17 deterministic zero-LLM contracts across injection, grounding, knowledge, permissions, workflows and channels; Admin > AI Control Center exposes the score and each case). Live provider quality sampling, human-labelled answer sets and agent cost split remain deferred.
6g. **Omnichannel adapters** (next: IG first - identity.resolve() + workflows + escalation ready)
7. BI layer (Insights + Problem Detector + AI Quality + Journey funnel)
8. Omnichannel adapters → (baad me) Voice loop + Vision (D5)
9. UI polish batch (D7 — jawab ke mutabiq)
