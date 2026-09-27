# OmniFlow vs "Next-Level" Feature Checklist — Honest Gap Analysis
_Dated: 2026-09-16 · Verified against the real codebase (chains 67-310 shipped)_

Scale used: ✅ BUILT · 🟡 PARTIAL (foundation exists, work left) · ❌ NOT BUILT

---

## 1. Omnichannel & Inbox

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 1.1 | Unified inbox (WhatsApp/Telegram/Insta/FB/TikTok) | 🟡 | Inbox, assignment, bulk actions, star/pin, unread filter, thread search, mobile UI — all built. But the **connector is WhatsApp-only**. The conversations schema already carries a `channel` column and every query is channel-safe, so the data layer is ready; the four other platform connectors do not exist. |
| 1.2 | Cross-channel customer memory (same person recognized everywhere) | 🟡 | Customers are keyed by `contact_id` per channel. A `channel` field exists and Customer-360 shows it. **Missing:** identity stitching (same phone across WhatsApp + Instagram). One mapping table + merge flow gets 70% there. |
| 1.3 | Multi-turn context handling | ✅ | The laptop AI bot runs with full thread context (messages table + connector history), step conditions use reply-awareness, auto-pause on customer reply. Fine-grained slot-filling (remember "size = M" across turns) is not modeled. |
| 1.4 | Business-hours based routing | ✅ | Business hours per workspace, away replies when closed, quiet hours, auto-close idle. This one is genuinely done. |

## 2. Understanding & Replies

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 2.1 | FAQ auto-answering from knowledge base | ✅ | KB entries (CRUD, search, reindex) + the bot answers from them. KB **gaps** are logged when the bot can't answer and can be resolved into new entries. |
| 2.2 | Intent recognition + entity extraction | 🟡 | Purchase-intent scoring exists (drives hot/warm/cold leads and the COD auto-ask). Keyword-trigger automations are exact-match (deterministic). **Missing:** a proper multi-intent classifier with entities (dates, order numbers, product names). |
| 2.3 | Sentiment analysis (text mood) | ❌ | Lead temperature is a purchase-signal proxy, not sentiment. No angry/happy/frustrated detection. |
| 2.4 | Multilingual (Urdu / Roman Urdu / English) | 🟡 | The COD YES/NO parser already understands English + Roman Urdu (HAAN/NAHI), and the LLM bot replies in the customer's language naturally. **Missing:** explicit language setting, script detection, per-language KB entries, language-tagged analytics. |
| 2.5 | Human handoff / escalation when the bot is lost | 🟡 | Manual takeover is solid: reply-pause (bot steps back), assignment, away mode, KB-gap logging as the "bot was confused" trail. **Missing:** automatic escalation on low confidence / negative sentiment / repeat confusion. |
| 2.6 | Canned / quick replies | ✅ | Saved replies with /shortcuts in the composer, picker in every thread, usage counts, last-used, full manager page with editing. |

## 3. Commerce & CRM

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 3.1 | Product catalog | ✅ | Catalog section in Business profile (items the bot cites). |
| 3.2 | Order status lookup | ✅ | Orders section + portal API; deterministic order answers. |
| 3.3 | Unified customer profile / mini-CRM | ✅ | Customer 360 (stats, tags, chats, COD trail, series, notes), customers list + import/export, segments with live audiences, pipeline kanban (New → Won/Lost), merge duplicates. This is the strongest area of the product. |
| 3.4 | Proactive messaging (order updates, cart reminders) | ✅ (deterministic) | Sequences Pro (delays, reply-aware pause, smart conditions, funnel), scheduled broadcasts with send_at materialization, segment broadcasts, COD confirmation asks. No *event-driven* triggers yet (e.g. fire when an order status changes in an external system). |
| 3.5 | In-chat checkout / conversational commerce | ❌ | COD confirmation is the closest cousin (order ask → YES/NO → confirmed). No payment gateway, no pay-link generation. |
| 3.6 | Personalized product recommendations | ❌ | Purchase/browsing history exists in the data; no recommender. |
| 3.7 | Dynamic discount / negotiation bot | ❌ | Not started. |

## 4. Analytics & Ops

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 4.1 | Analytics dashboard (response time, CSAT) | ✅ | Analytics page + CSAT ask/summary per conversation + weekly summary (7-day tiles, day-by-day bars) + activity log with CSV export. |
| 4.2 | Agent performance analytics | 🟡 | The audit log records actor_user_id per action and team/assignment exists, but there is **no per-agent scoreboard** (replies count, avg first-response, CSAT by agent). Data is already captured — it needs an aggregation endpoint + page. |
| 4.3 | Predictive staffing (chat volume forecast) | ❌ | Chat volume history exists (weekly endpoint proves the queries); no forecast. |
| 4.4 | Customer churn prediction | ❌ | Engagement patterns are stored; no churn model/score. |
| 4.5 | Social listening (mentions off-platform) | ❌ | Would need per-platform APIs; zero code today. |

## 5. Agentic AI

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 5.1 | Autonomous ticket resolution (refund, cancel, change order) | 🟡 (foundation only) | The **command queue** (bot-initiated actions delivered by the connector poll) is a real action-execution backbone — COD confirmations ride it today. But there is no refund/cancel/order-change action surface, and no approval guard-rail for money-moving actions. |
| 5.2 | Multi-agent orchestration (sales/support/billing bots handing off) | ❌ | One bot persona per workspace. No agent routing/roles. |
| 5.3 | Real-time agent-assist (AI suggests replies while human types) | ❌ | Not started. Data to ground it (KB + catalog + thread) already exists. |

## 6. Voice & Multimedia

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 6.1 | AI voice bot (inbound/outbound calls) | ❌ | WhatsApp voice notes are not handled either; no telephony integration. Needs an external voice provider. |
| 6.2 | Emotion detection from voice tone | ❌ | — |
| 6.3 | AI-generated personalized video replies | ❌ | Needs a video-generation provider; zero-cost constraint makes this unlikely short-term. |

## 7. Trust, Safety & Self-Improvement

| # | Feature | Status | Reality check |
|---|---------|--------|---------------|
| 7.1 | Fraud / spam detection in chats | ❌ | No message-risk scoring. Deterministic heuristics (link spam, OTP-phishing patterns, bot-like bursts) are buildable without any AI vendor. |
| 7.2 | Compliance auto-check (flag risky replies before send) | ❌ | Not started. A deterministic blocklist/claims checker on outbound drafts is feasible. |
| 7.3 | Self-improving KB (learn from resolved tickets) | 🟡 | The manual loop exists end-to-end: bot misses → gap logged → merchant resolves → becomes a KB entry. **Missing:** auto-drafting the KB entry from the resolved conversation (one deterministic LLM call when unlocked). |
| 7.4 | RLHF from real conversations | ❌ | No feedback capture or fine-tune loop. |

---

## Scorecard

- **✅ Built: 13** — inbox core, multi-turn context, business-hours routing, FAQ/KB auto-answer, quick replies, catalog, order lookup, mini-CRM (360 + segments + pipeline + merge), proactive messaging (deterministic), analytics + CSAT + weekly, team/multi-agent humans, webhooks, mobile/PWA.
- **🟡 Partial: 8** — omnichannel (schema ready, connectors missing), cross-channel identity, intents/entities, multilingual, auto-escalation, agent scoreboard, autonomous actions (command queue exists), self-improving KB (manual loop done).
- **❌ Not built: 14** — true sentiment, voice (3 features), video, in-chat checkout, recommendations, negotiation bot, churn prediction, staffing forecast, social listening, multi-agent orchestration, agent-assist, fraud detection, compliance check, RLHF.

## Suggested next batches (cheapest real value first, fits zero-cost + deterministic laws)

1. **296-batch candidate — Agent scoreboard + auto-escalation**: per-agent stats from the existing audit log + escalation rule (KB-gap repeat or negative keyword → assign human + pause bot). Pure deterministic, ~10 files.
2. **Fraud/heuristics + compliance flags**: outbound blocklist + risky-inbound patterns, all rule-based. ~8 files.
3. **Multilingual explicit**: language setting on BotForm, script detection (Arabic-script vs Roman), per-language KB field. ~8 files.
4. **Omnichannel phase 1 — Telegram**: one new connector module + channel-aware ingest (the schema is already channel-safe); identity stitching table afterward.
5. **Agent-assist v0**: on thread open, suggest the top-2 KB matches for the latest inbound (deterministic retrieval, no new AI).
6. **AI-dependent items** (sentiment, entity extraction, auto-KB drafting, RLHF): blocked behind the standing **"AI features locked"** decision — revisit when that unlocks, then they slot into the existing KB/lead-temp surfaces rather than new plumbing.
7. **External-provider items** (voice, video, payments, social listening): each needs a third-party account + keys; park until the user opts in.
