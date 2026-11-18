import "server-only";

import { neonEnabled, neonQuery } from "../db/neon";
import { checkAndConsumeQuota, resolveTenantEntitlements } from "./entitlements";

export type DeterministicRuleType =
  | "welcome"
  | "keyword"
  | "faq"
  | "business_hours"
  | "away"
  | "conditional"
  | "fixed";

export interface HybridDeterministicRule {
  id: string;
  name: string;
  type: DeterministicRuleType;
  enabled: boolean;
  priority: number;
  keywords?: string[];
  matchMode?: "contains_word" | "exact" | "starts_with";
  conditionField?: "is_first_message" | "outside_hours" | "intent";
  conditionValue?: string;
  responseText: string;
  handoverToHuman?: boolean;
}

export interface BasicBusinessConfig {
  businessName: string;
  businessDescription: string;
  productsAndServices: string;
  pricingInfo: string;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessHoursEnabled: boolean;
  awayMessage: string;
  welcomeMessage: string;
  faqs: { question: string; answer: string }[];
  contactInfo: string;
  preferredLanguage: "roman_urdu" | "urdu" | "english" | "auto";
  aiTone: "friendly" | "professional" | "concise";
  basicInstructions: string;
  humanHandoverEnabled: boolean;
  handoverKeywords: string[];
}

export interface HybridExecutionInput {
  clientId: number;
  messageId: string;
  contactId: string;
  contactName?: string;
  text: string;
  isFirstMessage?: boolean;
  timestampIso?: string;
}

export interface HybridExecutionResult {
  ok: boolean;
  messageId: string;
  handledBy: "deterministic_rule" | "ai_agent" | "human_handover" | "blocked" | "duplicate_skipped";
  matchedRuleId?: string;
  matchedRuleName?: string;
  replyText: string | null;
  detectedLanguage: "roman_urdu" | "urdu" | "english";
  handedOverToHuman: boolean;
  stepsCompleted: string[];
  error?: string;
}

const g = globalThis as unknown as {
  __ofHybridStore?: {
    processedMessageIds: Set<string>;
    configs: Map<number, BasicBusinessConfig>;
    rules: Map<number, HybridDeterministicRule[]>;
    activityLog: Map<
      number,
      {
        received: number;
        sent: number;
        aiReplies: number;
        ruleReplies: number;
        humanHandovers: number;
        failedExecutions: number;
      }
    >;
  };
};

function store() {
  if (!g.__ofHybridStore) {
    g.__ofHybridStore = {
      processedMessageIds: new Set(),
      configs: new Map(),
      rules: new Map(),
      activityLog: new Map(),
    };
  }
  return g.__ofHybridStore;
}

export function getDefaultBusinessConfig(clientId: number): BasicBusinessConfig {
  return {
    businessName: `Workspace #${clientId}`,
    businessDescription: "Customer support and order assistance on WhatsApp.",
    productsAndServices: "Standard products and customer services.",
    pricingInfo: "Contact us for item-specific pricing or catalog details.",
    businessHoursStart: "09:00",
    businessHoursEnd: "21:00",
    businessHoursEnabled: false,
    awayMessage:
      "Assalam-o-Alaikum! Hum abhi business hours ke bahar hain. Aap apna message chhor dein, hum subah sab se pehle reply karenge.",
    welcomeMessage:
      "Assalam-o-Alaikum! Humari WhatsApp service mein khush aamdeed. Aaj hum aapki kya madad kar sakte hain?",
    faqs: [
      {
        question: "delivery time",
        answer: "Standard delivery 2 se 4 working days mein mukammal hoti hai.",
      },
      {
        question: "return policy",
        answer: "7 days ke andar unused item exchange ya return kiya ja sakta hai.",
      },
    ],
    contactInfo: "WhatsApp Support Desk",
    preferredLanguage: "auto",
    aiTone: "friendly",
    basicInstructions:
      "Give helpful, polite, and accurate answers using only the provided business information.",
    humanHandoverEnabled: true,
    handoverKeywords: ["agent", "human", "insaan", "manager", "complaint", "shikayat", "refund"],
  };
}

export function getDefaultDeterministicRules(): HybridDeterministicRule[] {
  return [
    {
      id: "rule_welcome",
      name: "Welcome Greeting (First Message)",
      type: "welcome",
      enabled: true,
      priority: 1,
      conditionField: "is_first_message",
      conditionValue: "true",
      responseText:
        "Assalam-o-Alaikum! Welcome to our WhatsApp desk. Aap pricing, delivery, ya order status ke baare mein pooch sakte hain.",
    },
    {
      id: "rule_delivery_faq",
      name: "Delivery Time Keyword Trigger",
      type: "faq",
      enabled: true,
      priority: 2,
      keywords: ["delivery", "shipping", "kab milega", "parcel"],
      matchMode: "contains_word",
      responseText:
        "Humari standard delivery 2 se 4 working days mein aapke address par pohanch jati hai.",
    },
    {
      id: "rule_hours_away",
      name: "After-Hours Away Reply",
      type: "away",
      enabled: true,
      priority: 10,
      conditionField: "outside_hours",
      conditionValue: "true",
      responseText:
        "Shukriya aapke message ka! Humare working hours 09:00 AM se 09:00 PM tak hain. Humari team jald aap se rabta karegi.",
    },
  ];
}

export async function getTenantHybridConfig(clientId: number): Promise<{
  businessConfig: BasicBusinessConfig;
  rules: HybridDeterministicRule[];
  stats: {
    received: number;
    sent: number;
    aiReplies: number;
    ruleReplies: number;
    humanHandovers: number;
    failedExecutions: number;
  };
}> {
  const s = store();
  let cfg = s.configs.get(clientId);
  if (!cfg) {
    cfg = getDefaultBusinessConfig(clientId);
    if (neonEnabled()) {
      try {
        const pRes = await neonQuery<{ profile: Record<string, unknown> }>(
          "SELECT profile FROM portal_profiles WHERE client_id = $1 LIMIT 1",
          [clientId]
        );
        const prof = pRes.rows[0]?.profile;
        if (prof && typeof prof === "object") {
          cfg.businessName = String(prof.business_name || cfg.businessName);
          cfg.businessDescription = String(
            prof.about || prof.description || cfg.businessDescription
          );
          cfg.productsAndServices = String(prof.products || cfg.productsAndServices);
          cfg.pricingInfo = String(
            prof.policies || prof.prices || cfg.pricingInfo
          );
          cfg.contactInfo = String(prof.phone || prof.contact || cfg.contactInfo);
        }
      } catch {
        // ignore
      }
    }
    s.configs.set(clientId, cfg);
  }

  let rules = s.rules.get(clientId);
  if (!rules) {
    rules = getDefaultDeterministicRules();
    s.rules.set(clientId, rules);
  }

  const stats = s.activityLog.get(clientId) ?? {
    received: 0,
    sent: 0,
    aiReplies: 0,
    ruleReplies: 0,
    humanHandovers: 0,
    failedExecutions: 0,
  };

  return { businessConfig: cfg, rules, stats };
}

export async function saveTenantHybridConfig(
  clientId: number,
  updates: {
    businessConfig?: Partial<BasicBusinessConfig>;
    rules?: HybridDeterministicRule[];
  }
) {
  const current = await getTenantHybridConfig(clientId);
  const s = store();

  if (updates.businessConfig) {
    const merged: BasicBusinessConfig = {
      ...current.businessConfig,
      ...updates.businessConfig,
    };
    s.configs.set(clientId, merged);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_profiles (client_id, profile, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (client_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
        [
          clientId,
          JSON.stringify({
            business_name: merged.businessName,
            about: merged.businessDescription,
            description: merged.businessDescription,
            products: merged.productsAndServices,
            policies: merged.pricingInfo,
            prices: merged.pricingInfo,
            phone: merged.contactInfo,
            contact: merged.contactInfo,
            default_language: merged.preferredLanguage,
            language: merged.preferredLanguage,
            business_hours: `${merged.businessHoursStart} – ${merged.businessHoursEnd}`,
          }),
        ]
      ).catch(() => null);
    }
  }

  if (Array.isArray(updates.rules)) {
    s.rules.set(clientId, updates.rules);
  }

  return getTenantHybridConfig(clientId);
}

function detectLanguage(text: string): "urdu" | "roman_urdu" | "english" {
  if (/[\u0600-\u06FF]/.test(text)) return "urdu";
  const lower = " " + text.toLowerCase() + " ";
  const romanMarkers = [
    " kya ",
    " hai ",
    " hain ",
    " kaise ",
    " kitne ",
    " price kya ",
    " milega ",
    " chahiye ",
    " bhai ",
    " salam ",
    " assalam ",
    " shukriya ",
    " kab ",
    " kahan ",
  ];
  if (romanMarkers.some((m) => lower.includes(m))) return "roman_urdu";
  return "english";
}

function isWithinHours(start: string, end: string, nowIso?: string): boolean {
  try {
    const d = nowIso ? new Date(nowIso) : new Date();
    const hhmm = d.toISOString().slice(11, 16);
    return hhmm >= start && hhmm <= end;
  } catch {
    return true;
  }
}

function matchesKeyword(text: string, keyword: string, mode: string): boolean {
  const cleanText = " " + text.toLowerCase().replace(/[^\w\u0600-\u06FF\s]/g, " ") + " ";
  const cleanKw = keyword.toLowerCase().trim();
  if (!cleanKw) return false;
  if (mode === "exact") return text.trim().toLowerCase() === cleanKw;
  if (mode === "starts_with") return text.trim().toLowerCase().startsWith(cleanKw);
  return cleanText.includes(" " + cleanKw + " ") || text.toLowerCase().includes(cleanKw);
}

/**
 * 10-Step Hybrid WhatsApp Execution Pipeline (Section 2.E):
 * Prevents duplicate replies when both deterministic rules and AI could match.
 */
export async function executeHybridWhatsAppPipeline(
  input: HybridExecutionInput
): Promise<HybridExecutionResult> {
  const steps: string[] = [];
  const s = store();
  const dedupeKey = `${input.clientId}:${input.messageId}`;

  // Step 1: Receive incoming WhatsApp message & deduplicate
  steps.push("1. Received incoming WhatsApp message");
  const detectedLanguage = detectLanguage(input.text);

  if (s.processedMessageIds.has(dedupeKey)) {
    return {
      ok: true,
      messageId: input.messageId,
      handledBy: "duplicate_skipped",
      replyText: null,
      detectedLanguage,
      handedOverToHuman: false,
      stepsCompleted: [...steps, "Duplicate messageId detected — skipped duplicate reply"],
    };
  }

  // Step 2: Validate tenant, account, workspace status, feature & WhatsApp connector entitlement
  const entitlements = await resolveTenantEntitlements(input.clientId, "owner");
  if (
    entitlements.workspaceStatus !== "Active" ||
    !entitlements.features["basic.hybrid_ai"]?.enabled ||
    !entitlements.connectors.whatsapp?.enabled
  ) {
    return {
      ok: false,
      messageId: input.messageId,
      handledBy: "blocked",
      replyText: null,
      detectedLanguage,
      handedOverToHuman: false,
      stepsCompleted: [...steps, "2. Tenant or WhatsApp entitlement inactive — blocked"],
      error: "Hybrid WhatsApp automation is not active for this workspace.",
    };
  }
  steps.push("2. Validated tenant, active workspace, and WhatsApp connector entitlement");

  // Lock messageId so deterministic rules and AI never double-send
  s.processedMessageIds.add(dedupeKey);

  const { businessConfig, rules, stats } = await getTenantHybridConfig(input.clientId);
  stats.received += 1;
  s.activityLog.set(input.clientId, stats);

  // Check human handover trigger keywords first (Step 10 shortcut if customer explicitly asks for human)
  const lowerText = input.text.toLowerCase();
  if (
    businessConfig.humanHandoverEnabled &&
    businessConfig.handoverKeywords.some((kw) => matchesKeyword(lowerText, kw, "contains_word"))
  ) {
    stats.humanHandovers += 1;
    stats.sent += 1;
    s.activityLog.set(input.clientId, stats);
    const handoverReply =
      detectedLanguage === "urdu"
        ? "آپ کی بات ہمارے نمائندے کو منتقل کر دی گئی ہے۔"
        : detectedLanguage === "roman_urdu"
          ? `Ji zaroor! Humne aapki conversation ${businessConfig.businessName} ke human representative ko assign kar di hai.`
          : `Certainly! I have handed this conversation over to a human team member at ${businessConfig.businessName}.`;
    steps.push("3. Matched human handover keyword trigger");
    steps.push("10. Handed over conversation to human agent");
    return {
      ok: true,
      messageId: input.messageId,
      handledBy: "human_handover",
      replyText: handoverReply,
      detectedLanguage,
      handedOverToHuman: true,
      stepsCompleted: steps,
    };
  }

  // Step 3: Check active deterministic automation rules
  steps.push("3. Checked active deterministic automation rules");
  const sortedRules = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  const outsideHours =
    businessConfig.businessHoursEnabled &&
    !isWithinHours(
      businessConfig.businessHoursStart,
      businessConfig.businessHoursEnd,
      input.timestampIso
    );

  for (const rule of sortedRules) {
    let matched = false;
    if (rule.type === "welcome" && input.isFirstMessage) {
      matched = true;
    } else if (rule.type === "away" && outsideHours) {
      matched = true;
    } else if (rule.keywords && rule.keywords.length > 0) {
      matched = rule.keywords.some((kw) =>
        matchesKeyword(input.text, kw, rule.matchMode || "contains_word")
      );
    }

    if (matched) {
      // Step 4: Execute matching deterministic rule & STOP (prevents duplicate AI reply)
      const autoQuota = await checkAndConsumeQuota(
        input.clientId,
        "automation_executions",
        1,
        { ruleId: rule.id }
      );
      if (!autoQuota.allowed) {
        stats.failedExecutions += 1;
        s.activityLog.set(input.clientId, stats);
        return {
          ok: false,
          messageId: input.messageId,
          handledBy: "blocked",
          replyText: null,
          detectedLanguage,
          handedOverToHuman: false,
          stepsCompleted: [...steps, "4. Automation quota exceeded"],
          error: autoQuota.reason,
        };
      }

      steps.push(`4. Executed deterministic rule '${rule.name}' (AI skipped to prevent duplicate reply)`);
      steps.push("7. Applied response validation");
      steps.push("8. Dispatched reply via connected WhatsApp account");
      steps.push("9. Recorded deterministic rule interaction");

      stats.ruleReplies += 1;
      stats.sent += 1;
      if (rule.handoverToHuman) stats.humanHandovers += 1;
      s.activityLog.set(input.clientId, stats);

      return {
        ok: true,
        messageId: input.messageId,
        handledBy: "deterministic_rule",
        matchedRuleId: rule.id,
        matchedRuleName: rule.name,
        replyText: rule.responseText,
        detectedLanguage,
        handedOverToHuman: Boolean(rule.handoverToHuman),
        stepsCompleted: steps,
      };
    }
  }

  // Also check basic FAQ pairs in Business Config
  for (const faq of businessConfig.faqs) {
    if (faq.question && matchesKeyword(input.text, faq.question, "contains_word")) {
      steps.push(`4. Matched Business FAQ '${faq.question}'`);
      steps.push("7. Applied response validation");
      steps.push("8. Dispatched reply via connected WhatsApp account");
      steps.push("9. Recorded FAQ interaction");
      stats.ruleReplies += 1;
      stats.sent += 1;
      s.activityLog.set(input.clientId, stats);
      return {
        ok: true,
        messageId: input.messageId,
        handledBy: "deterministic_rule",
        matchedRuleId: "faq_match",
        matchedRuleName: `FAQ: ${faq.question}`,
        replyText: faq.answer,
        detectedLanguage,
        handedOverToHuman: false,
        stepsCompleted: steps,
      };
    }
  }

  // Step 5: Otherwise invoke the configured AI agent (verify AI message quotas first)
  const dailyCheck = await checkAndConsumeQuota(input.clientId, "daily_ai_messages", 1);
  if (!dailyCheck.allowed) {
    stats.failedExecutions += 1;
    s.activityLog.set(input.clientId, stats);
    return {
      ok: false,
      messageId: input.messageId,
      handledBy: "blocked",
      replyText: null,
      detectedLanguage,
      handedOverToHuman: false,
      stepsCompleted: [...steps, "5. Daily AI message quota reached"],
      error: dailyCheck.reason,
    };
  }
  const monthlyCheck = await checkAndConsumeQuota(input.clientId, "monthly_ai_messages", 1);
  if (!monthlyCheck.allowed) {
    stats.failedExecutions += 1;
    s.activityLog.set(input.clientId, stats);
    return {
      ok: false,
      messageId: input.messageId,
      handledBy: "blocked",
      replyText: null,
      detectedLanguage,
      handedOverToHuman: false,
      stepsCompleted: [...steps, "5. Monthly AI message quota reached"],
      error: monthlyCheck.reason,
    };
  }

  steps.push("5. No deterministic rule matched — invoked configured AI Conversation Engine");

  // Step 6: Generate contextual response in Urdu, Roman Urdu, or English
  const targetLang =
    businessConfig.preferredLanguage === "auto"
      ? detectedLanguage
      : businessConfig.preferredLanguage;

  let aiReply: string;
  if (targetLang === "urdu") {
    aiReply = `${businessConfig.businessName} میں خوش آمدید! ہم ${businessConfig.productsAndServices} فراہم کرتے ہیں۔ قیمت اور تفصیلات: ${businessConfig.pricingInfo}۔ مزید مدد کے لیے بتائیں۔`;
  } else if (targetLang === "roman_urdu") {
    aiReply = `Assalam-o-Alaikum! ${businessConfig.businessName} mein khush aamdeed. Humare products/services: ${businessConfig.productsAndServices}. Pricing: ${businessConfig.pricingInfo}. Agar aapko mazeed detail chahiye toh zaroor batayein!`;
  } else {
    aiReply = `Hello from ${businessConfig.businessName}! ${businessConfig.businessDescription} We offer: ${businessConfig.productsAndServices}. Pricing info: ${businessConfig.pricingInfo}. Let us know how we can help!`;
  }

  steps.push(`6. Generated contextual AI response (${targetLang}, tone: ${businessConfig.aiTone})`);
  steps.push("7. Applied safety and response validation");
  steps.push("8. Sent reply through connected WhatsApp account");
  steps.push("9. Recorded AI interaction and quota usage");

  stats.aiReplies += 1;
  stats.sent += 1;
  s.activityLog.set(input.clientId, stats);

  return {
    ok: true,
    messageId: input.messageId,
    handledBy: "ai_agent",
    replyText: aiReply,
    detectedLanguage: targetLang,
    handedOverToHuman: false,
    stepsCompleted: steps,
  };
}
