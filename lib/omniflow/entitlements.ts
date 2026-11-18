import "server-only";

import { neonEnabled, neonQuery } from "../db/neon";

// ============================================================================
// 1. FEATURE, CONNECTOR, PERMISSION, ROLE & QUOTA TYPES
// ============================================================================

export type ActionPermission =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "approve"
  | "publish"
  | "export";

export const ALL_ACTION_PERMISSIONS: ActionPermission[] = [
  "read",
  "create",
  "update",
  "delete",
  "execute",
  "approve",
  "publish",
  "export",
];

export type FeatureCategory =
  | "basic_whatsapp"
  | "sales"
  | "marketing"
  | "automation"
  | "content"
  | "insights"
  | "ai"
  | "workspace";

export type FeatureKey =
  // Default Basic WhatsApp Automation (enabled by default for every new client)
  | "basic.dashboard"
  | "basic.whatsapp_connect"
  | "basic.inbox"
  | "basic.customers"
  | "basic.hybrid_ai"
  | "basic.business_config"
  | "basic.quick_replies"
  | "basic.activity_reports"
  // Sales (disabled by default)
  | "sales.sales_desk"
  | "sales.advanced_crm"
  | "sales.pipeline"
  | "sales.cod"
  | "sales.courier"
  | "sales.winback"
  | "sales.retention"
  // Marketing (disabled by default)
  | "marketing.broadcasts"
  | "marketing.sequences"
  | "marketing.segments"
  | "marketing.growth"
  | "marketing.advanced_automation"
  // Automation (disabled by default)
  | "automation.advanced_builder"
  | "automation.workflows"
  | "automation.custom_rules"
  | "automation.multistep"
  | "automation.scheduled"
  // Content (disabled by default)
  | "content.knowledge_base"
  | "content.website_analyzer"
  | "content.media"
  // Insights (disabled by default)
  | "insights.business_insights"
  | "insights.advanced_analytics"
  | "insights.weekly_reports"
  | "insights.advanced_activity"
  // AI (disabled by default)
  | "ai.advanced_config"
  | "ai.model_selection"
  | "ai.sandbox"
  | "ai.custom_agent"
  | "ai.advanced_tools"
  | "ai.setup_report"
  // Workspace (disabled by default)
  | "workspace.instagram_connector"
  | "workspace.facebook_connector"
  | "workspace.messenger_connector"
  | "workspace.multi_whatsapp"
  | "workspace.external_api"
  | "workspace.custom_webhooks"
  | "workspace.advanced_team"
  | "workspace.compliance"
  | "workspace.approvals";

export type ConnectorId =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "messenger"
  | "whatsapp_multi"
  | "external_api"
  | "custom_webhooks"
  | "tiktok"
  | "linkedin"
  | "x"
  | "youtube"
  | "telegram_user";

export type WorkspaceRoleId =
  | "owner"
  | "admin"
  | "manager"
  | "agent"
  | "viewer"
  | string;

export type QuotaMetricKey =
  | "monthly_ai_messages"
  | "daily_ai_messages"
  | "automation_executions"
  | "workflow_executions"
  | "whatsapp_accounts"
  | "connected_channels"
  | "team_members"
  | "storage_mb"
  | "api_requests"
  | "broadcast_recipients"
  | "advanced_ai_calls";

export interface FeatureDefinition {
  key: FeatureKey;
  label: string;
  category: FeatureCategory;
  parentKey?: FeatureKey;
  defaultEnabled: boolean;
  routes: string[];
  apiPrefixes: string[];
  dependsOn?: FeatureKey[];
  requiredConnector?: ConnectorId;
  description: string;
}

export interface ConnectorCatalogItem {
  id: ConnectorId;
  label: string;
  defaultEnabled: boolean;
  defaultMaxAccounts: number;
  description: string;
}

export interface FeatureGrant {
  featureKey: FeatureKey;
  enabled: boolean;
  permissions: ActionPermission[];
  expiresAt: string | null;
  complimentary?: boolean;
  source: "platform_restriction" | "workspace_status" | "client_override" | "plan_default" | "basic_default";
}

export interface ConnectorGrant {
  connectorId: ConnectorId;
  enabled: boolean;
  maxAccounts: number;
  rateLimitPerMinute: number;
  permissions: ActionPermission[];
  expiresAt: string | null;
  source: "platform_restriction" | "workspace_status" | "client_override" | "plan_default" | "basic_default";
}

export interface QuotaConfig {
  metric: QuotaMetricKey;
  label: string;
  limitValue: number | null; // null = unlimited
  enforcement: "hard" | "soft" | "unlimited";
  warningThresholdPct: number;
  usedValue: number;
  resetPeriod: "daily" | "monthly" | "none";
  lastResetAt: string;
}

export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  enabledFeatures: FeatureKey[];
  enabledConnectors: ConnectorId[];
  quotas: Record<QuotaMetricKey, { limit: number | null; enforcement: "hard" | "soft" | "unlimited" }>;
}

export interface RoleDefinition {
  id: WorkspaceRoleId;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: ActionPermission[];
  allowedCategories: FeatureCategory[];
}

export interface AccessAuditEntry {
  id: number;
  adminEmail: string;
  clientId: number;
  action: string;
  targetType: "feature" | "connector" | "plan" | "quota" | "role" | "status" | "platform";
  targetKey: string;
  previousValue: unknown;
  newValue: unknown;
  reason: string;
  createdAt: string;
}

export interface ResolvedTenantEntitlements {
  clientId: number;
  workspaceStatus: "Active" | "Suspended" | "Locked";
  planId: string;
  planName: string;
  role: WorkspaceRoleId;
  rolePermissions: ActionPermission[];
  features: Record<FeatureKey, FeatureGrant>;
  connectors: Record<ConnectorId, ConnectorGrant>;
  quotas: Record<QuotaMetricKey, QuotaConfig>;
  allowedRoutes: string[];
  resolvedAt: string;
}

// ============================================================================
// 2. MASTER FEATURE & CONNECTOR CATALOG (Sections 2, 4, 5)
// ============================================================================

export const FEATURE_CATALOG: FeatureDefinition[] = [
  // --- DEFAULT BASIC WHATSAPP AUTOMATION (Enabled by default) ---
  {
    key: "basic.dashboard",
    label: "Basic Overview Dashboard",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard"],
    apiPrefixes: ["/api/omniflow/portal/overview"],
    description: "Lightweight overview of WhatsApp status, messages, AI vs human replies, and recent conversations.",
  },
  {
    key: "basic.whatsapp_connect",
    label: "WhatsApp Connection (QR & Pairing)",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/channels/whatsapp"],
    apiPrefixes: ["/api/omniflow/portal/channels/whatsapp"],
    requiredConnector: "whatsapp",
    description: "Single WhatsApp connection via QR or 8-digit pairing code, status health, reconnect, and disconnect.",
  },
  {
    key: "basic.inbox",
    label: "Inbox & Conversations",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/conversations"],
    apiPrefixes: ["/api/omniflow/portal/conversations"],
    description: "Incoming/outgoing WhatsApp messages, manual replies, AI reply visibility, human takeover, and return to AI.",
  },
  {
    key: "basic.customers",
    label: "Customers & Contacts",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/customers"],
    apiPrefixes: ["/api/omniflow/portal/customers", "/api/omniflow/portal/contacts"],
    description: "Customer WhatsApp numbers, conversation history, search, filtering, and basic tags.",
  },
  {
    key: "basic.hybrid_ai",
    label: "Hybrid WhatsApp Automation (Rules + AI)",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/bot", "/dashboard/rules"],
    apiPrefixes: ["/api/omniflow/portal/bot", "/api/omniflow/portal/hybrid-automation", "/api/omniflow/portal/policy"],
    description: "Deterministic rules (welcome, keywords, FAQs, business hours, away) combined with contextual AI in Urdu, Roman Urdu & English.",
  },
  {
    key: "basic.business_config",
    label: "Basic Business Configuration",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/profile", "/dashboard/settings", "/dashboard/onboarding"],
    apiPrefixes: ["/api/omniflow/portal/profile", "/api/omniflow/portal/hours"],
    description: "Business name, description, products/services, basic pricing, hours, FAQs, language, tone, and handover.",
  },
  {
    key: "basic.quick_replies",
    label: "Basic Quick Replies",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/saved-replies"],
    apiPrefixes: ["/api/omniflow/portal/templates"],
    description: "Create, edit, delete, and insert saved quick replies in conversations.",
  },
  {
    key: "basic.activity_reports",
    label: "Basic Activity & Reports",
    category: "basic_whatsapp",
    defaultEnabled: true,
    routes: ["/dashboard/activity"],
    apiPrefixes: ["/api/omniflow/portal/activity"],
    description: "Messages received/sent, AI replies, rule-based replies, human-handled chats, and failed executions.",
  },

  // --- SALES (Disabled by default) ---
  {
    key: "sales.sales_desk",
    label: "Sales Desk",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/sales"],
    apiPrefixes: ["/api/omniflow/portal/sales", "/api/omniflow/portal/catalog", "/api/omniflow/portal/orders"],
    description: "Order capture, product catalog, and commercial sales desk.",
  },
  {
    key: "sales.advanced_crm",
    label: "Advanced CRM & Customer 360",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/customers/profile"],
    apiPrefixes: ["/api/omniflow/portal/contacts/merge", "/api/omniflow/portal/identity"],
    description: "Deep customer 360 timeline, duplicate merging, lead scoring, and revenue attribution.",
  },
  {
    key: "sales.pipeline",
    label: "Pipeline Management",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/pipeline"],
    apiPrefixes: ["/api/omniflow/portal/pipeline"],
    description: "Kanban deal pipeline and stage progression tracking.",
  },
  {
    key: "sales.cod",
    label: "COD Confirmations",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/cod"],
    apiPrefixes: ["/api/omniflow/portal/cod"],
    description: "Automated Cash-on-Delivery order verification and fraud risk scoring.",
  },
  {
    key: "sales.courier",
    label: "Courier Management",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/courier"],
    apiPrefixes: ["/api/omniflow/portal/courier"],
    description: "Courier booking, tracking, and delivery status automation.",
  },
  {
    key: "sales.winback",
    label: "Win-back Campaigns",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/winback"],
    apiPrefixes: ["/api/omniflow/portal/winback"],
    description: "Automated dormant customer re-engagement workflows.",
  },
  {
    key: "sales.retention",
    label: "Advanced Retention",
    category: "sales",
    defaultEnabled: false,
    routes: ["/dashboard/retention"],
    apiPrefixes: ["/api/omniflow/portal/retention", "/api/omniflow/portal/churn"],
    description: "Churn prediction, reorder reminders, and loyalty retention tools.",
  },

  // --- MARKETING (Disabled by default) ---
  {
    key: "marketing.broadcasts",
    label: "Broadcasts",
    category: "marketing",
    defaultEnabled: false,
    routes: ["/dashboard/broadcasts"],
    apiPrefixes: ["/api/omniflow/portal/broadcasts"],
    description: "Bulk template and promotional broadcasts with audience targeting.",
  },
  {
    key: "marketing.sequences",
    label: "Campaign Sequences",
    category: "marketing",
    defaultEnabled: false,
    routes: ["/dashboard/sequences"],
    apiPrefixes: ["/api/omniflow/portal/sequences"],
    description: "Multi-day drip sequences and automated follow-up campaigns.",
  },
  {
    key: "marketing.segments",
    label: "Customer Segmentation",
    category: "marketing",
    defaultEnabled: false,
    routes: ["/dashboard/segments"],
    apiPrefixes: ["/api/omniflow/portal/segments"],
    description: "Dynamic behavioral and tag-based customer segments.",
  },
  {
    key: "marketing.growth",
    label: "Growth Tools",
    category: "marketing",
    defaultEnabled: false,
    routes: ["/dashboard/growth"],
    apiPrefixes: ["/api/omniflow/portal/growth", "/api/omniflow/portal/coupons"],
    description: "QR links, click-to-WhatsApp widgets, coupons, and referral growth tools.",
  },
  {
    key: "marketing.advanced_automation",
    label: "Advanced Marketing Automation",
    category: "marketing",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/ab-tests", "/api/omniflow/portal/proactive"],
    description: "A/B testing, proactive outreach, and cross-channel social publishing.",
  },

  // --- AUTOMATION (Disabled by default) ---
  {
    key: "automation.advanced_builder",
    label: "Advanced Automation Builder",
    category: "automation",
    defaultEnabled: false,
    routes: ["/dashboard/automations"],
    apiPrefixes: ["/api/omniflow/portal/ai-automation"],
    description: "Event-driven automation recipes and AI trigger actions.",
  },
  {
    key: "automation.workflows",
    label: "Workflow Builder",
    category: "automation",
    defaultEnabled: false,
    routes: ["/dashboard/workflows"],
    apiPrefixes: ["/api/omniflow/portal/workflows"],
    description: "Visual branching workflow builder with webhook and CRM actions.",
  },
  {
    key: "automation.custom_rules",
    label: "Custom Rules Engine",
    category: "automation",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/routing", "/api/omniflow/portal/negotiation"],
    description: "Advanced routing, sentiment gates, and price negotiation rules.",
  },
  {
    key: "automation.multistep",
    label: "Multi-step Workflows",
    category: "automation",
    parentKey: "automation.workflows",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: [],
    dependsOn: ["automation.workflows"],
    description: "Multi-stage conditional state machines across channels.",
  },
  {
    key: "automation.scheduled",
    label: "Scheduled Advanced Workflows",
    category: "automation",
    parentKey: "automation.workflows",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: [],
    dependsOn: ["automation.workflows"],
    description: "Time-delayed and cron-scheduled workflow executions.",
  },

  // --- CONTENT (Disabled by default) ---
  {
    key: "content.knowledge_base",
    label: "Advanced Knowledge Base",
    category: "content",
    defaultEnabled: false,
    routes: ["/dashboard/knowledge-base"],
    apiPrefixes: ["/api/omniflow/portal/kb", "/api/omniflow/portal/knowledge"],
    description: "Vector semantic search, document ingestion, and multi-source RAG knowledge base.",
  },
  {
    key: "content.website_analyzer",
    label: "Website Analyzer",
    category: "content",
    defaultEnabled: false,
    routes: ["/dashboard/website-analyzer"],
    apiPrefixes: ["/api/omniflow/portal/site-analyzer"],
    description: "Automated website crawler to extract FAQs, products, and policies.",
  },
  {
    key: "content.media",
    label: "Advanced Media Management",
    category: "content",
    defaultEnabled: false,
    routes: ["/dashboard/media"],
    apiPrefixes: ["/api/omniflow/portal/media", "/api/omniflow/portal/voice", "/api/omniflow/portal/video"],
    description: "Media library, voice-note transcription, and vision image understanding.",
  },

  // --- INSIGHTS (Disabled by default) ---
  {
    key: "insights.business_insights",
    label: "Business Insights",
    category: "insights",
    defaultEnabled: false,
    routes: ["/dashboard/insights"],
    apiPrefixes: ["/api/omniflow/portal/insights", "/api/omniflow/portal/bi"],
    description: "Executive BI alerts, anomaly detection, and revenue intelligence.",
  },
  {
    key: "insights.advanced_analytics",
    label: "Advanced Analytics",
    category: "insights",
    defaultEnabled: false,
    routes: ["/dashboard/analytics"],
    apiPrefixes: ["/api/omniflow/portal/analytics", "/api/omniflow/portal/nl-analytics"],
    description: "Deep funnel analytics, cohort charts, and natural-language analytics queries.",
  },
  {
    key: "insights.weekly_reports",
    label: "Weekly Reports",
    category: "insights",
    defaultEnabled: false,
    routes: ["/dashboard/weekly"],
    apiPrefixes: ["/api/omniflow/portal/weekly", "/api/omniflow/portal/digest"],
    description: "Automated weekly executive digests and problem summaries.",
  },
  {
    key: "insights.advanced_activity",
    label: "Advanced Activity Analysis",
    category: "insights",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/obs", "/api/omniflow/portal/perf"],
    description: "Latency traces, SLA heatmaps, and agent performance telemetry.",
  },

  // --- AI (Disabled by default) ---
  {
    key: "ai.advanced_config",
    label: "Advanced AI Configuration",
    category: "ai",
    defaultEnabled: false,
    routes: ["/dashboard/ai-brain"],
    apiPrefixes: ["/api/omniflow/portal/brain"],
    description: "Autonomy levels, guardrails, memory facts, and advanced AI brain parameters.",
  },
  {
    key: "ai.model_selection",
    label: "Advanced Model Selection",
    category: "ai",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/model-router"],
    description: "Custom LLM provider routing and model tier selection.",
  },
  {
    key: "ai.sandbox",
    label: "AI Sandbox",
    category: "ai",
    defaultEnabled: false,
    routes: ["/dashboard/sandbox"],
    apiPrefixes: ["/api/omniflow/portal/sandbox"],
    description: "Interactive simulator for testing prompts, rules, and edge-case conversations.",
  },
  {
    key: "ai.custom_agent",
    label: "Custom Agent Configuration",
    category: "ai",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/agents"],
    description: "Multi-agent personas and specialized sub-agents.",
  },
  {
    key: "ai.advanced_tools",
    label: "Advanced AI Tools & Ask Omni",
    category: "ai",
    defaultEnabled: false,
    routes: ["/dashboard/assistant"],
    apiPrefixes: ["/api/omniflow/portal/assistant", "/api/omniflow/portal/actions"],
    description: "Internal Ask Omni copilot and autonomous tool execution.",
  },
  {
    key: "ai.setup_report",
    label: "AI Setup & Quality Report",
    category: "ai",
    defaultEnabled: false,
    routes: ["/dashboard/ai-report"],
    apiPrefixes: ["/api/omniflow/portal/ai-report", "/api/omniflow/portal/ai-quality"],
    description: "AI readiness grading, hallucination checks, and evaluation traces.",
  },

  // --- WORKSPACE & CONNECTORS (Disabled by default) ---
  {
    key: "workspace.instagram_connector",
    label: "Instagram Connector",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/channels"],
    apiPrefixes: ["/api/omniflow/portal/instagram"],
    requiredConnector: "instagram",
    description: "Connect Instagram Business account for DMs and comment automation.",
  },
  {
    key: "workspace.facebook_connector",
    label: "Facebook Connector",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/channels"],
    apiPrefixes: ["/api/omniflow/portal/channels/social"],
    requiredConnector: "facebook",
    description: "Connect Facebook Pages for post comments and lead capture.",
  },
  {
    key: "workspace.messenger_connector",
    label: "Messenger Connector",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/channels"],
    apiPrefixes: ["/api/omniflow/portal/instagram"],
    requiredConnector: "messenger",
    description: "Connect Facebook Messenger inbox for automated and human replies.",
  },
  {
    key: "workspace.multi_whatsapp",
    label: "Additional WhatsApp Accounts & WATI",
    category: "workspace",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/wati"],
    requiredConnector: "whatsapp_multi",
    description: "Manage multiple WhatsApp numbers and WATI BSP templates.",
  },
  {
    key: "workspace.external_api",
    label: "External API Integrations",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/integrations"],
    apiPrefixes: ["/api/omniflow/portal/apikeys", "/api/omniflow/portal/integrations"],
    requiredConnector: "external_api",
    description: "Programmatic REST API keys and third-party store integrations.",
  },
  {
    key: "workspace.custom_webhooks",
    label: "Custom Webhooks",
    category: "workspace",
    defaultEnabled: false,
    routes: [],
    apiPrefixes: ["/api/omniflow/portal/webhooks"],
    requiredConnector: "custom_webhooks",
    description: "Outbound signed webhook subscriptions and delivery logs.",
  },
  {
    key: "workspace.advanced_team",
    label: "Advanced Team Management",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/team"],
    apiPrefixes: ["/api/omniflow/portal/team"],
    description: "Multi-agent team seats, shift routing, and custom role assignment.",
  },
  {
    key: "workspace.compliance",
    label: "Advanced Compliance Tools",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/compliance"],
    apiPrefixes: ["/api/omniflow/portal/compliance", "/api/omniflow/portal/datasafety"],
    description: "GDPR/PDPA data retention, PII redaction, and audit exports.",
  },
  {
    key: "workspace.approvals",
    label: "High-Risk Action Approvals",
    category: "workspace",
    defaultEnabled: false,
    routes: ["/dashboard/approvals"],
    apiPrefixes: ["/api/omniflow/portal/approvals"],
    description: "Human-in-the-loop approval queue for refunds, discounts, and bulk actions.",
  },
];

export const CONNECTOR_CATALOG: ConnectorCatalogItem[] = [
  {
    id: "whatsapp",
    label: "WhatsApp (Primary Bridge)",
    defaultEnabled: true,
    defaultMaxAccounts: 1,
    description: "Default single WhatsApp QR / Pairing Code connection.",
  },
  {
    id: "instagram",
    label: "Instagram Business",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "Instagram Graph API & DM/comment bridge.",
  },
  {
    id: "facebook",
    label: "Facebook Page",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "Facebook Page comments and lead forms.",
  },
  {
    id: "messenger",
    label: "Facebook Messenger",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "Facebook Messenger inbox integration.",
  },
  {
    id: "whatsapp_multi",
    label: "Additional WhatsApp Numbers / WATI",
    defaultEnabled: false,
    defaultMaxAccounts: 5,
    description: "Multiple WhatsApp lines and official WATI Cloud API.",
  },
  {
    id: "external_api",
    label: "External REST API Access",
    defaultEnabled: false,
    defaultMaxAccounts: 5,
    description: "Tenant API keys for external ERP/CRM integration.",
  },
  {
    id: "custom_webhooks",
    label: "Custom Outbound Webhooks",
    defaultEnabled: false,
    defaultMaxAccounts: 10,
    description: "Signed outbound webhook endpoints.",
  },
  {
    id: "tiktok",
    label: "TikTok Business",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "TikTok DM and comment connector.",
  },
  {
    id: "linkedin",
    label: "LinkedIn Organization",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "LinkedIn company page messaging & posts.",
  },
  {
    id: "x",
    label: "X (Twitter)",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "X DM and mention automation.",
  },
  {
    id: "youtube",
    label: "YouTube Channel",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "YouTube comment ingestion and auto-reply.",
  },
  {
    id: "telegram_user",
    label: "Telegram MTProto Bridge",
    defaultEnabled: false,
    defaultMaxAccounts: 1,
    description: "Telegram user/business chat connector.",
  },
];

export const DEFAULT_BASIC_FEATURES: FeatureKey[] = FEATURE_CATALOG.filter(
  (f) => f.defaultEnabled
).map((f) => f.key);

// ============================================================================
// 3. QUOTA METRICS & REUSABLE PLAN TEMPLATES (Sections 7, 9)
// ============================================================================

export const QUOTA_METRICS_META: {
  metric: QuotaMetricKey;
  label: string;
  resetPeriod: "daily" | "monthly" | "none";
  basicDefault: number | null;
}[] = [
  { metric: "monthly_ai_messages", label: "Monthly AI Messages", resetPeriod: "monthly", basicDefault: 1000 },
  { metric: "daily_ai_messages", label: "Daily AI Messages", resetPeriod: "daily", basicDefault: 100 },
  { metric: "automation_executions", label: "Automation Executions / Mo", resetPeriod: "monthly", basicDefault: 2500 },
  { metric: "workflow_executions", label: "Workflow Executions / Mo", resetPeriod: "monthly", basicDefault: 0 },
  { metric: "whatsapp_accounts", label: "WhatsApp Accounts", resetPeriod: "none", basicDefault: 1 },
  { metric: "connected_channels", label: "Connected Channels", resetPeriod: "none", basicDefault: 1 },
  { metric: "team_members", label: "Team Members", resetPeriod: "none", basicDefault: 1 },
  { metric: "storage_mb", label: "Storage (MB)", resetPeriod: "none", basicDefault: 250 },
  { metric: "api_requests", label: "External API Requests / Mo", resetPeriod: "monthly", basicDefault: 0 },
  { metric: "broadcast_recipients", label: "Broadcast Recipients / Mo", resetPeriod: "monthly", basicDefault: 0 },
  { metric: "advanced_ai_calls", label: "Advanced AI Model Calls / Mo", resetPeriod: "monthly", basicDefault: 0 },
];

export const SYSTEM_PLAN_TEMPLATES: Record<string, PlanTemplate> = {
  basic_whatsapp: {
    id: "basic_whatsapp",
    name: "Basic WhatsApp",
    description: "Default simple hybrid WhatsApp automation for every new client.",
    isSystem: true,
    enabledFeatures: [...DEFAULT_BASIC_FEATURES],
    enabledConnectors: ["whatsapp"],
    quotas: {
      monthly_ai_messages: { limit: 1000, enforcement: "hard" },
      daily_ai_messages: { limit: 100, enforcement: "hard" },
      automation_executions: { limit: 2500, enforcement: "hard" },
      workflow_executions: { limit: 0, enforcement: "hard" },
      whatsapp_accounts: { limit: 1, enforcement: "hard" },
      connected_channels: { limit: 1, enforcement: "hard" },
      team_members: { limit: 1, enforcement: "hard" },
      storage_mb: { limit: 250, enforcement: "hard" },
      api_requests: { limit: 0, enforcement: "hard" },
      broadcast_recipients: { limit: 0, enforcement: "hard" },
      advanced_ai_calls: { limit: 0, enforcement: "hard" },
    },
  },
  whatsapp_ai_plus: {
    id: "whatsapp_ai_plus",
    name: "WhatsApp AI Plus",
    description: "Basic WhatsApp + Advanced AI Configuration, Knowledge Base, Sandbox & AI Quality.",
    isSystem: true,
    enabledFeatures: [
      ...DEFAULT_BASIC_FEATURES,
      "ai.advanced_config",
      "ai.sandbox",
      "ai.setup_report",
      "content.knowledge_base",
    ],
    enabledConnectors: ["whatsapp"],
    quotas: {
      monthly_ai_messages: { limit: 5000, enforcement: "hard" },
      daily_ai_messages: { limit: 400, enforcement: "soft" },
      automation_executions: { limit: 10000, enforcement: "soft" },
      workflow_executions: { limit: 500, enforcement: "hard" },
      whatsapp_accounts: { limit: 1, enforcement: "hard" },
      connected_channels: { limit: 2, enforcement: "hard" },
      team_members: { limit: 3, enforcement: "hard" },
      storage_mb: { limit: 1024, enforcement: "hard" },
      api_requests: { limit: 1000, enforcement: "hard" },
      broadcast_recipients: { limit: 500, enforcement: "hard" },
      advanced_ai_calls: { limit: 2000, enforcement: "hard" },
    },
  },
  ecommerce_automation: {
    id: "ecommerce_automation",
    name: "E-commerce Automation",
    description: "WhatsApp + Sales Desk, COD Confirmations, Courier Management & Win-back.",
    isSystem: true,
    enabledFeatures: [
      ...DEFAULT_BASIC_FEATURES,
      "sales.sales_desk",
      "sales.advanced_crm",
      "sales.cod",
      "sales.courier",
      "sales.winback",
      "sales.retention",
    ],
    enabledConnectors: ["whatsapp", "instagram"],
    quotas: {
      monthly_ai_messages: { limit: 10000, enforcement: "soft" },
      daily_ai_messages: { limit: 800, enforcement: "soft" },
      automation_executions: { limit: 25000, enforcement: "soft" },
      workflow_executions: { limit: 5000, enforcement: "hard" },
      whatsapp_accounts: { limit: 2, enforcement: "hard" },
      connected_channels: { limit: 3, enforcement: "hard" },
      team_members: { limit: 5, enforcement: "hard" },
      storage_mb: { limit: 2048, enforcement: "hard" },
      api_requests: { limit: 10000, enforcement: "soft" },
      broadcast_recipients: { limit: 5000, enforcement: "hard" },
      advanced_ai_calls: { limit: 3000, enforcement: "hard" },
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    description: "Multi-channel Instagram/Facebook + Marketing Broadcasts, Sequences, Segments & Analytics.",
    isSystem: true,
    enabledFeatures: [
      ...DEFAULT_BASIC_FEATURES,
      "sales.sales_desk",
      "sales.pipeline",
      "marketing.broadcasts",
      "marketing.sequences",
      "marketing.segments",
      "marketing.growth",
      "insights.advanced_analytics",
      "insights.weekly_reports",
      "workspace.instagram_connector",
      "workspace.facebook_connector",
      "workspace.messenger_connector",
      "workspace.advanced_team",
    ],
    enabledConnectors: ["whatsapp", "instagram", "facebook", "messenger"],
    quotas: {
      monthly_ai_messages: { limit: 20000, enforcement: "soft" },
      daily_ai_messages: { limit: 1500, enforcement: "soft" },
      automation_executions: { limit: 50000, enforcement: "soft" },
      workflow_executions: { limit: 10000, enforcement: "soft" },
      whatsapp_accounts: { limit: 2, enforcement: "hard" },
      connected_channels: { limit: 5, enforcement: "hard" },
      team_members: { limit: 10, enforcement: "hard" },
      storage_mb: { limit: 5120, enforcement: "soft" },
      api_requests: { limit: 25000, enforcement: "soft" },
      broadcast_recipients: { limit: 15000, enforcement: "hard" },
      advanced_ai_calls: { limit: 5000, enforcement: "soft" },
    },
  },
  advanced_automation: {
    id: "advanced_automation",
    name: "Advanced Automation",
    description: "Full Workflow Builder, Custom Rules, Multi-step & Scheduled Workflows, AI Sandbox & API.",
    isSystem: true,
    enabledFeatures: [
      ...DEFAULT_BASIC_FEATURES,
      "sales.sales_desk",
      "sales.advanced_crm",
      "sales.pipeline",
      "automation.advanced_builder",
      "automation.workflows",
      "automation.custom_rules",
      "automation.multistep",
      "automation.scheduled",
      "content.knowledge_base",
      "content.website_analyzer",
      "insights.advanced_analytics",
      "ai.advanced_config",
      "ai.sandbox",
      "workspace.external_api",
      "workspace.custom_webhooks",
    ],
    enabledConnectors: ["whatsapp", "instagram", "external_api", "custom_webhooks"],
    quotas: {
      monthly_ai_messages: { limit: 50000, enforcement: "soft" },
      daily_ai_messages: { limit: 3000, enforcement: "soft" },
      automation_executions: { limit: 100000, enforcement: "soft" },
      workflow_executions: { limit: 50000, enforcement: "soft" },
      whatsapp_accounts: { limit: 5, enforcement: "hard" },
      connected_channels: { limit: 8, enforcement: "hard" },
      team_members: { limit: 20, enforcement: "hard" },
      storage_mb: { limit: 10240, enforcement: "soft" },
      api_requests: { limit: 100000, enforcement: "soft" },
      broadcast_recipients: { limit: 50000, enforcement: "soft" },
      advanced_ai_calls: { limit: 15000, enforcement: "soft" },
    },
  },
  custom_enterprise: {
    id: "custom_enterprise",
    name: "Custom Enterprise",
    description: "All modules, connectors, compliance, multi-WhatsApp and unlimited quotas.",
    isSystem: true,
    enabledFeatures: FEATURE_CATALOG.map((f) => f.key),
    enabledConnectors: CONNECTOR_CATALOG.map((c) => c.id),
    quotas: {
      monthly_ai_messages: { limit: null, enforcement: "unlimited" },
      daily_ai_messages: { limit: null, enforcement: "unlimited" },
      automation_executions: { limit: null, enforcement: "unlimited" },
      workflow_executions: { limit: null, enforcement: "unlimited" },
      whatsapp_accounts: { limit: 10, enforcement: "soft" },
      connected_channels: { limit: 12, enforcement: "soft" },
      team_members: { limit: null, enforcement: "unlimited" },
      storage_mb: { limit: null, enforcement: "unlimited" },
      api_requests: { limit: null, enforcement: "unlimited" },
      broadcast_recipients: { limit: null, enforcement: "unlimited" },
      advanced_ai_calls: { limit: null, enforcement: "unlimited" },
    },
  },
};

// ============================================================================
// 4. ROLE-BASED ACCESS CONTROL DEFINITIONS (Section 8)
// ============================================================================

export const SYSTEM_ROLES: Record<string, RoleDefinition> = {
  owner: {
    id: "owner",
    name: "Owner",
    description: "Full control within the workspace's enabled entitlements.",
    isSystem: true,
    permissions: [...ALL_ACTION_PERMISSIONS],
    allowedCategories: [
      "basic_whatsapp",
      "sales",
      "marketing",
      "automation",
      "content",
      "insights",
      "ai",
      "workspace",
    ],
  },
  admin: {
    id: "admin",
    name: "Admin",
    description: "Can configure channels, automation, and team within enabled workspace features.",
    isSystem: true,
    permissions: ["read", "create", "update", "delete", "execute", "approve", "publish", "export"],
    allowedCategories: [
      "basic_whatsapp",
      "sales",
      "marketing",
      "automation",
      "content",
      "insights",
      "ai",
      "workspace",
    ],
  },
  manager: {
    id: "manager",
    name: "Manager",
    description: "Can manage conversations, customers, sales, marketing, and approve actions.",
    isSystem: true,
    permissions: ["read", "create", "update", "execute", "approve", "publish", "export"],
    allowedCategories: [
      "basic_whatsapp",
      "sales",
      "marketing",
      "automation",
      "content",
      "insights",
    ],
  },
  agent: {
    id: "agent",
    name: "Agent",
    description: "Can handle inbox conversations, customers, quick replies, and human takeover.",
    isSystem: true,
    permissions: ["read", "create", "update", "execute"],
    allowedCategories: ["basic_whatsapp", "sales"],
  },
  viewer: {
    id: "viewer",
    name: "Viewer",
    description: "Read-only access to enabled workspace views and reports.",
    isSystem: true,
    permissions: ["read"],
    allowedCategories: ["basic_whatsapp", "sales", "marketing", "insights"],
  },
};

// ============================================================================
// 5. DATABASE DDL & IN-MEMORY FALLBACK STORE (Section 13)
// ============================================================================

interface MemoryTenantState {
  planId: string;
  workspaceStatus: "Active" | "Suspended" | "Locked";
  featureOverrides: Record<
    string,
    {
      enabled: boolean;
      permissions: ActionPermission[];
      expiresAt: string | null;
      complimentary?: boolean;
    }
  >;
  connectorOverrides: Record<
    string,
    {
      enabled: boolean;
      maxAccounts: number;
      rateLimitPerMinute: number;
      permissions: ActionPermission[];
      expiresAt: string | null;
    }
  >;
  quotaOverrides: Record<
    string,
    {
      limitValue: number | null;
      enforcement: "hard" | "soft" | "unlimited";
      warningThresholdPct: number;
      usedValue: number;
      lastResetAt: string;
    }
  >;
  memberRoles: Record<number, WorkspaceRoleId>;
}

const g = globalThis as unknown as {
  __ofEntitlementMemory?: {
    tenants: Map<number, MemoryTenantState>;
    platformDisabledFeatures: Set<FeatureKey>;
    platformDisabledConnectors: Set<ConnectorId>;
    customPlans: Map<string, PlanTemplate>;
    customRoles: Map<string, RoleDefinition>;
    auditLogs: AccessAuditEntry[];
    cache: Map<string, { data: ResolvedTenantEntitlements; expiresAt: number }>;
  };
};

function getMem() {
  if (!g.__ofEntitlementMemory) {
    g.__ofEntitlementMemory = {
      tenants: new Map(),
      platformDisabledFeatures: new Set(),
      platformDisabledConnectors: new Set(),
      customPlans: new Map(),
      customRoles: new Map(),
      auditLogs: [],
      cache: new Map(),
    };
  }
  return g.__ofEntitlementMemory;
}

let ddlReady = false;

export async function ensureEntitlementSchema(): Promise<boolean> {
  if (!neonEnabled()) return false;
  if (ddlReady) return true;
  try {
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS of_tenant_plans (
        client_id BIGINT PRIMARY KEY,
        plan_id TEXT NOT NULL DEFAULT 'basic_whatsapp',
        workspace_status TEXT NOT NULL DEFAULT 'Active',
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS of_tenant_entitlements (
        client_id BIGINT NOT NULL,
        feature_key TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        permissions JSONB NOT NULL DEFAULT '["read","create","update","delete","execute"]'::jsonb,
        complimentary BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMPTZ,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (client_id, feature_key)
      );
      CREATE TABLE IF NOT EXISTS of_connector_entitlements (
        client_id BIGINT NOT NULL,
        connector_id TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        max_accounts INT NOT NULL DEFAULT 1,
        rate_limit_rpm INT NOT NULL DEFAULT 60,
        permissions JSONB NOT NULL DEFAULT '["read","create","update","execute"]'::jsonb,
        expires_at TIMESTAMPTZ,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (client_id, connector_id)
      );
      CREATE TABLE IF NOT EXISTS of_usage_quotas (
        client_id BIGINT NOT NULL,
        metric TEXT NOT NULL,
        limit_value BIGINT,
        enforcement TEXT NOT NULL DEFAULT 'hard',
        warning_pct INT NOT NULL DEFAULT 80,
        used_value BIGINT NOT NULL DEFAULT 0,
        last_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (client_id, metric)
      );
      CREATE TABLE IF NOT EXISTS of_usage_events (
        id BIGSERIAL PRIMARY KEY,
        client_id BIGINT NOT NULL,
        metric TEXT NOT NULL,
        delta INT NOT NULL DEFAULT 1,
        context JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS of_custom_plans (
        plan_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled_features JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled_connectors JSONB NOT NULL DEFAULT '[]'::jsonb,
        quotas JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS of_custom_roles (
        role_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        permissions JSONB NOT NULL DEFAULT '["read"]'::jsonb,
        allowed_categories JSONB NOT NULL DEFAULT '["basic_whatsapp"]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS of_platform_restrictions (
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        disabled BOOLEAN NOT NULL DEFAULT TRUE,
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (target_type, target_key)
      );
      CREATE TABLE IF NOT EXISTS of_access_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        admin_email TEXT NOT NULL,
        client_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        previous_value JSONB,
        new_value JSONB,
        reason TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_of_audit_client ON of_access_audit_logs (client_id, created_at DESC);
    `);
    ddlReady = true;
    return true;
  } catch {
    return false;
  }
}

function ensureMemTenant(clientId: number): MemoryTenantState {
  const mem = getMem();
  let state = mem.tenants.get(clientId);
  if (!state) {
    state = {
      planId: "basic_whatsapp",
      workspaceStatus: "Active",
      featureOverrides: {},
      connectorOverrides: {},
      quotaOverrides: {},
      memberRoles: {},
    };
    mem.tenants.set(clientId, state);
  }
  return state;
}

export function invalidateEntitlementCache(clientId?: number): void {
  const mem = getMem();
  if (clientId === undefined) {
    mem.cache.clear();
    return;
  }
  for (const key of mem.cache.keys()) {
    if (key.startsWith(clientId + ":")) {
      mem.cache.delete(key);
    }
  }
}

// ============================================================================
// 6. DEFAULT PROVISIONING FOR NEW CLIENTS (Section 2 & 13)
// ============================================================================

export async function provisionDefaultWhatsAppEntitlements(
  clientId: number,
  adminEmail = "system"
): Promise<void> {
  const memState = ensureMemTenant(clientId);
  memState.planId = "basic_whatsapp";
  memState.workspaceStatus = "Active";

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_tenant_plans (client_id, plan_id, workspace_status, updated_by, updated_at)
       VALUES ($1, 'basic_whatsapp', 'Active', $2, NOW())
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, adminEmail]
    ).catch(() => null);
  }

  invalidateEntitlementCache(clientId);
}

// ============================================================================
// 7. 5-LAYER PRIORITY ENTITLEMENT RESOLUTION ENGINE (Section 14)
// ============================================================================

export async function getAllPlans(): Promise<Record<string, PlanTemplate>> {
  const mem = getMem();
  const plans: Record<string, PlanTemplate> = { ...SYSTEM_PLAN_TEMPLATES };
  for (const [id, p] of mem.customPlans.entries()) {
    plans[id] = p;
  }
  if (await ensureEntitlementSchema()) {
    try {
      const res = await neonQuery<{
        plan_id: string;
        name: string;
        description: string;
        enabled_features: FeatureKey[];
        enabled_connectors: ConnectorId[];
        quotas: PlanTemplate["quotas"];
      }>("SELECT plan_id, name, description, enabled_features, enabled_connectors, quotas FROM of_custom_plans");
      for (const row of res.rows) {
        plans[row.plan_id] = {
          id: row.plan_id,
          name: row.name,
          description: row.description,
          isSystem: false,
          enabledFeatures: Array.isArray(row.enabled_features) ? row.enabled_features : [],
          enabledConnectors: Array.isArray(row.enabled_connectors) ? row.enabled_connectors : [],
          quotas: row.quotas || SYSTEM_PLAN_TEMPLATES.basic_whatsapp.quotas,
        };
      }
    } catch {
      // ignore
    }
  }
  return plans;
}

export async function getAllRoles(): Promise<Record<string, RoleDefinition>> {
  const mem = getMem();
  const roles: Record<string, RoleDefinition> = { ...SYSTEM_ROLES };
  for (const [id, r] of mem.customRoles.entries()) {
    roles[id] = r;
  }
  if (await ensureEntitlementSchema()) {
    try {
      const res = await neonQuery<{
        role_id: string;
        name: string;
        description: string;
        permissions: ActionPermission[];
        allowed_categories: FeatureCategory[];
      }>("SELECT role_id, name, description, permissions, allowed_categories FROM of_custom_roles");
      for (const row of res.rows) {
        roles[row.role_id] = {
          id: row.role_id,
          name: row.name,
          description: row.description,
          isSystem: false,
          permissions: Array.isArray(row.permissions) ? row.permissions : ["read"],
          allowedCategories: Array.isArray(row.allowed_categories)
            ? row.allowed_categories
            : ["basic_whatsapp"],
        };
      }
    } catch {
      // ignore
    }
  }
  return roles;
}

export async function resolveTenantEntitlements(
  clientId: number,
  roleInput: WorkspaceRoleId = "owner",
  bypassCache = false
): Promise<ResolvedTenantEntitlements> {
  const mem = getMem();
  const normalizedRole = (roleInput || "owner").toLowerCase();
  const cacheKey = clientId + ":" + normalizedRole;
  const now = Date.now();

  if (!bypassCache) {
    const hit = mem.cache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return hit.data;
    }
  }

  const memState = ensureMemTenant(clientId);
  let planId = memState.planId || "basic_whatsapp";
  let workspaceStatus: "Active" | "Suspended" | "Locked" = memState.workspaceStatus || "Active";

  const dbFeatureOverrides: MemoryTenantState["featureOverrides"] = {
    ...memState.featureOverrides,
  };
  const dbConnectorOverrides: MemoryTenantState["connectorOverrides"] = {
    ...memState.connectorOverrides,
  };
  const dbQuotaOverrides: MemoryTenantState["quotaOverrides"] = {
    ...memState.quotaOverrides,
  };
  const platformDisabledFeatures = new Set<FeatureKey>(mem.platformDisabledFeatures);
  const platformDisabledConnectors = new Set<ConnectorId>(mem.platformDisabledConnectors);

  if (await ensureEntitlementSchema()) {
    try {
      const planRes = await neonQuery<{ plan_id: string; workspace_status: string }>(
        "SELECT plan_id, workspace_status FROM of_tenant_plans WHERE client_id = $1 LIMIT 1",
        [clientId]
      );
      if (planRes.rows[0]) {
        planId = planRes.rows[0].plan_id || planId;
        const st = planRes.rows[0].workspace_status;
        if (st === "Suspended" || st === "Locked" || st === "Active") {
          workspaceStatus = st;
        }
      }

      const userStatusRes = await neonQuery<{ status: string | null }>(
        "SELECT status FROM platform_users WHERE id = $1 LIMIT 1",
        [clientId]
      ).catch(() => ({ rows: [] as { status: string | null }[] }));
      if (
        userStatusRes.rows[0]?.status &&
        userStatusRes.rows[0].status.toLowerCase() === "suspended"
      ) {
        workspaceStatus = "Suspended";
      }

      const fRes = await neonQuery<{
        feature_key: string;
        enabled: boolean;
        permissions: ActionPermission[];
        complimentary: boolean;
        expires_at: string | null;
      }>(
        "SELECT feature_key, enabled, permissions, complimentary, expires_at FROM of_tenant_entitlements WHERE client_id = $1",
        [clientId]
      );
      for (const r of fRes.rows) {
        dbFeatureOverrides[r.feature_key] = {
          enabled: Boolean(r.enabled),
          permissions: Array.isArray(r.permissions)
            ? r.permissions
            : ["read", "create", "update", "delete", "execute"],
          complimentary: Boolean(r.complimentary),
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        };
      }

      const cRes = await neonQuery<{
        connector_id: string;
        enabled: boolean;
        max_accounts: number;
        rate_limit_rpm: number;
        permissions: ActionPermission[];
        expires_at: string | null;
      }>(
        "SELECT connector_id, enabled, max_accounts, rate_limit_rpm, permissions, expires_at FROM of_connector_entitlements WHERE client_id = $1",
        [clientId]
      );
      for (const r of cRes.rows) {
        dbConnectorOverrides[r.connector_id] = {
          enabled: Boolean(r.enabled),
          maxAccounts: Number(r.max_accounts || 1),
          rateLimitPerMinute: Number(r.rate_limit_rpm || 60),
          permissions: Array.isArray(r.permissions)
            ? r.permissions
            : ["read", "create", "update", "execute"],
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        };
      }

      const qRes = await neonQuery<{
        metric: string;
        limit_value: string | number | null;
        enforcement: string;
        warning_pct: number;
        used_value: string | number;
        last_reset_at: string;
      }>(
        "SELECT metric, limit_value, enforcement, warning_pct, used_value, last_reset_at FROM of_usage_quotas WHERE client_id = $1",
        [clientId]
      );
      for (const r of qRes.rows) {
        dbQuotaOverrides[r.metric] = {
          limitValue: r.limit_value === null ? null : Number(r.limit_value),
          enforcement:
            r.enforcement === "soft" || r.enforcement === "unlimited"
              ? r.enforcement
              : "hard",
          warningThresholdPct: Number(r.warning_pct || 80),
          usedValue: Number(r.used_value || 0),
          lastResetAt: r.last_reset_at
            ? new Date(r.last_reset_at).toISOString()
            : new Date(now).toISOString(),
        };
      }

      const pRes = await neonQuery<{
        target_type: string;
        target_key: string;
        disabled: boolean;
      }>("SELECT target_type, target_key, disabled FROM of_platform_restrictions WHERE disabled = TRUE");
      for (const r of pRes.rows) {
        if (r.target_type === "feature") {
          platformDisabledFeatures.add(r.target_key as FeatureKey);
        } else if (r.target_type === "connector") {
          platformDisabledConnectors.add(r.target_key as ConnectorId);
        }
      }
    } catch {
      // fall back to in-memory state
    }
  }

  const allPlans = await getAllPlans();
  const plan = allPlans[planId] || SYSTEM_PLAN_TEMPLATES.basic_whatsapp;
  const planFeatureSet = new Set<FeatureKey>(plan.enabledFeatures);
  const planConnectorSet = new Set<ConnectorId>(plan.enabledConnectors);

  const allRoles = await getAllRoles();
  const roleDef = allRoles[normalizedRole] || SYSTEM_ROLES.owner;
  const rolePermissions = roleDef.permissions;
  const roleCategories = new Set<FeatureCategory>(roleDef.allowedCategories);

  const workspaceBlocked = workspaceStatus !== "Active";

  // Resolve Connectors FIRST (since some features check connector availability)
  const connectors = {} as Record<ConnectorId, ConnectorGrant>;
  for (const item of CONNECTOR_CATALOG) {
    const cid = item.id;
    const override = dbConnectorOverrides[cid];
    const overrideValid =
      override &&
      (!override.expiresAt || new Date(override.expiresAt).getTime() > now);

    let enabled = item.defaultEnabled;
    let source: ConnectorGrant["source"] = "basic_default";
    let maxAccounts = item.defaultMaxAccounts;
    let rateLimitPerMinute = 60;
    let perms: ActionPermission[] = ["read", "create", "update", "execute"];
    let expiresAt: string | null = null;

    if (planConnectorSet.has(cid)) {
      enabled = true;
      source = "plan_default";
    }

    if (overrideValid) {
      enabled = override.enabled;
      maxAccounts = override.maxAccounts;
      rateLimitPerMinute = override.rateLimitPerMinute;
      perms = override.permissions;
      expiresAt = override.expiresAt;
      source = "client_override";
    }

    // Priority 2: Workspace status
    if (workspaceBlocked) {
      enabled = false;
      source = "workspace_status";
    }

    // Priority 1: Platform-wide restriction
    if (platformDisabledConnectors.has(cid)) {
      enabled = false;
      source = "platform_restriction";
    }

    connectors[cid] = {
      connectorId: cid,
      enabled,
      maxAccounts,
      rateLimitPerMinute,
      permissions: perms.filter((p) => rolePermissions.includes(p)),
      expiresAt,
      source,
    };
  }

  // Resolve Features using the 5-Layer Priority Hierarchy
  const features = {} as Record<FeatureKey, FeatureGrant>;
  for (const def of FEATURE_CATALOG) {
    const fkey = def.key;
    const override = dbFeatureOverrides[fkey];
    const overrideValid =
      override &&
      (!override.expiresAt || new Date(override.expiresAt).getTime() > now);

    // Priority 5: Default basic WhatsApp entitlements
    let enabled = def.defaultEnabled;
    let source: FeatureGrant["source"] = "basic_default";
    let perms: ActionPermission[] = [...ALL_ACTION_PERMISSIONS];
    let expiresAt: string | null = null;
    let complimentary = false;

    // Priority 4: Assigned plan defaults
    if (planFeatureSet.has(fkey)) {
      enabled = true;
      source = def.defaultEnabled ? "basic_default" : "plan_default";
    } else if (!def.defaultEnabled) {
      enabled = false;
      source = "plan_default";
    }

    // Priority 3: Client-specific explicit overrides (non-expired)
    if (overrideValid) {
      enabled = override.enabled;
      perms = override.permissions;
      expiresAt = override.expiresAt;
      complimentary = Boolean(override.complimentary);
      source = "client_override";
    }

    // Role category restriction (Role NEVER overrides a disabled workspace entitlement,
    // and can restrict access if the member role does not include this category)
    if (enabled && !roleCategories.has(def.category)) {
      enabled = false;
    }

    // Priority 2: Client workspace status
    if (workspaceBlocked) {
      enabled = false;
      source = "workspace_status";
    }

    // Priority 1: Platform-wide restrictions
    if (platformDisabledFeatures.has(fkey)) {
      enabled = false;
      source = "platform_restriction";
    }

    features[fkey] = {
      featureKey: fkey,
      enabled,
      permissions: enabled
        ? perms.filter((p) => rolePermissions.includes(p))
        : [],
      expiresAt,
      complimentary,
      source,
    };
  }

  // Enforce parent/dependency chain (e.g., multistep workflow requires workflow builder)
  for (const def of FEATURE_CATALOG) {
    if (def.dependsOn && features[def.key]?.enabled) {
      const allDepsMet = def.dependsOn.every((dep) => features[dep]?.enabled);
      if (!allDepsMet) {
        features[def.key].enabled = false;
        features[def.key].permissions = [];
      }
    }
  }

  // Resolve Usage Quotas
  const quotas = {} as Record<QuotaMetricKey, QuotaConfig>;
  for (const meta of QUOTA_METRICS_META) {
    const m = meta.metric;
    const planQuota = plan.quotas[m] ?? {
      limit: meta.basicDefault,
      enforcement: "hard" as const,
    };
    const qOverride = dbQuotaOverrides[m];
    const limitValue =
      qOverride !== undefined ? qOverride.limitValue : planQuota.limit;
    const enforcement =
      qOverride !== undefined ? qOverride.enforcement : planQuota.enforcement;
    const warningThresholdPct = qOverride?.warningThresholdPct ?? 80;
    const usedValue = qOverride?.usedValue ?? 0;
    const lastResetAt = qOverride?.lastResetAt ?? new Date(now).toISOString();

    quotas[m] = {
      metric: m,
      label: meta.label,
      limitValue: enforcement === "unlimited" ? null : limitValue,
      enforcement,
      warningThresholdPct,
      usedValue,
      resetPeriod: meta.resetPeriod,
      lastResetAt,
    };
  }

  // Compute allowed Customer Portal routes
  const allowedRouteSet = new Set<string>();
  for (const def of FEATURE_CATALOG) {
    if (features[def.key]?.enabled) {
      for (const r of def.routes) {
        allowedRouteSet.add(r);
      }
    }
  }

  const resolved: ResolvedTenantEntitlements = {
    clientId,
    workspaceStatus,
    planId: plan.id,
    planName: plan.name,
    role: roleDef.id,
    rolePermissions,
    features,
    connectors,
    quotas,
    allowedRoutes: Array.from(allowedRouteSet),
    resolvedAt: new Date(now).toISOString(),
  };

  mem.cache.set(cacheKey, { data: resolved, expiresAt: now + 10_000 });
  return resolved;
}

// ============================================================================
// 8. ADMIN MUTATION OPERATIONS + TRANSACTIONAL AUDIT LOGGING (Section 11, 15)
// ============================================================================

export async function recordAccessAuditLog(entry: {
  adminEmail: string;
  clientId: number;
  action: string;
  targetType: AccessAuditEntry["targetType"];
  targetKey: string;
  previousValue: unknown;
  newValue: unknown;
  reason?: string;
}): Promise<void> {
  const mem = getMem();
  const item: AccessAuditEntry = {
    id: mem.auditLogs.length + 1,
    adminEmail: entry.adminEmail || "admin",
    clientId: entry.clientId,
    action: entry.action,
    targetType: entry.targetType,
    targetKey: entry.targetKey,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    reason: entry.reason || "Updated by Platform Admin",
    createdAt: new Date().toISOString(),
  };
  mem.auditLogs.unshift(item);

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_access_audit_logs
       (admin_email, client_id, action, target_type, target_key, previous_value, new_value, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW())`,
      [
        item.adminEmail,
        item.clientId,
        item.action,
        item.targetType,
        item.targetKey,
        JSON.stringify(item.previousValue ?? null),
        JSON.stringify(item.newValue ?? null),
        item.reason,
      ]
    ).catch(() => null);
  }
}

export async function listAccessAuditLogs(
  clientId?: number,
  limit = 100
): Promise<AccessAuditEntry[]> {
  if (await ensureEntitlementSchema()) {
    try {
      const res = await neonQuery<{
        id: number;
        admin_email: string;
        client_id: number;
        action: string;
        target_type: AccessAuditEntry["targetType"];
        target_key: string;
        previous_value: unknown;
        new_value: unknown;
        reason: string;
        created_at: string;
      }>(
        clientId
          ? `SELECT id, admin_email, client_id, action, target_type, target_key, previous_value, new_value, reason, created_at
             FROM of_access_audit_logs
             WHERE client_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`
          : `SELECT id, admin_email, client_id, action, target_type, target_key, previous_value, new_value, reason, created_at
             FROM of_access_audit_logs
             ORDER BY created_at DESC, id DESC
             LIMIT $1`,
        clientId ? [clientId, limit] : [limit]
      );
      if (res.rows.length > 0) {
        return res.rows.map((r) => ({
          id: Number(r.id),
          adminEmail: r.admin_email,
          clientId: Number(r.client_id),
          action: r.action,
          targetType: r.target_type,
          targetKey: r.target_key,
          previousValue: r.previous_value,
          newValue: r.new_value,
          reason: r.reason || "",
          createdAt: new Date(r.created_at).toISOString(),
        }));
      }
    } catch {
      // fall back to memory
    }
  }

  const mem = getMem();
  const list = clientId
    ? mem.auditLogs.filter((a) => a.clientId === clientId)
    : mem.auditLogs;
  return list.slice(0, limit);
}

export async function setClientPlanAndStatus(input: {
  clientId: number;
  planId?: string;
  workspaceStatus?: "Active" | "Suspended" | "Locked";
  adminEmail: string;
  reason?: string;
}): Promise<ResolvedTenantEntitlements> {
  const before = await resolveTenantEntitlements(input.clientId, "owner", true);
  const memState = ensureMemTenant(input.clientId);

  if (input.planId) {
    memState.planId = input.planId;
  }
  if (input.workspaceStatus) {
    memState.workspaceStatus = input.workspaceStatus;
  }

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_tenant_plans (client_id, plan_id, workspace_status, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (client_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id,
         workspace_status = EXCLUDED.workspace_status,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        input.clientId,
        memState.planId,
        memState.workspaceStatus,
        input.adminEmail,
      ]
    ).catch(() => null);
  }

  invalidateEntitlementCache(input.clientId);

  if (input.planId && input.planId !== before.planId) {
    await recordAccessAuditLog({
      adminEmail: input.adminEmail,
      clientId: input.clientId,
      action: "plan.assigned",
      targetType: "plan",
      targetKey: input.planId,
      previousValue: before.planId,
      newValue: input.planId,
      reason: input.reason,
    });
  }

  if (input.workspaceStatus && input.workspaceStatus !== before.workspaceStatus) {
    await recordAccessAuditLog({
      adminEmail: input.adminEmail,
      clientId: input.clientId,
      action: "workspace.status_changed",
      targetType: "status",
      targetKey: "workspace_status",
      previousValue: before.workspaceStatus,
      newValue: input.workspaceStatus,
      reason: input.reason,
    });
  }

  return resolveTenantEntitlements(input.clientId, "owner", true);
}

export async function setClientFeatureOverride(input: {
  clientId: number;
  featureKey: FeatureKey;
  enabled: boolean;
  permissions?: ActionPermission[];
  expiresAt?: string | null;
  complimentary?: boolean;
  adminEmail: string;
  reason?: string;
}): Promise<ResolvedTenantEntitlements> {
  const before = await resolveTenantEntitlements(input.clientId, "owner", true);
  const prevGrant = before.features[input.featureKey];
  const memState = ensureMemTenant(input.clientId);

  const perms = input.permissions?.length
    ? input.permissions
    : [...ALL_ACTION_PERMISSIONS];
  const expiresAt = input.expiresAt || null;

  memState.featureOverrides[input.featureKey] = {
    enabled: input.enabled,
    permissions: perms,
    expiresAt,
    complimentary: Boolean(input.complimentary),
  };

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_tenant_entitlements
       (client_id, feature_key, enabled, permissions, complimentary, expires_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW())
       ON CONFLICT (client_id, feature_key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         permissions = EXCLUDED.permissions,
         complimentary = EXCLUDED.complimentary,
         expires_at = EXCLUDED.expires_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        input.clientId,
        input.featureKey,
        input.enabled,
        JSON.stringify(perms),
        Boolean(input.complimentary),
        expiresAt,
        input.adminEmail,
      ]
    ).catch(() => null);
  }

  invalidateEntitlementCache(input.clientId);

  await recordAccessAuditLog({
    adminEmail: input.adminEmail,
    clientId: input.clientId,
    action: input.enabled ? "feature.enabled" : "feature.disabled",
    targetType: "feature",
    targetKey: input.featureKey,
    previousValue: prevGrant
      ? { enabled: prevGrant.enabled, permissions: prevGrant.permissions, expiresAt: prevGrant.expiresAt }
      : null,
    newValue: { enabled: input.enabled, permissions: perms, expiresAt, complimentary: Boolean(input.complimentary) },
    reason: input.reason,
  });

  return resolveTenantEntitlements(input.clientId, "owner", true);
}

export async function bulkSetClientFeatures(input: {
  clientId: number;
  featureKeys: FeatureKey[];
  enabled: boolean;
  adminEmail: string;
  reason?: string;
}): Promise<ResolvedTenantEntitlements> {
  for (const fk of input.featureKeys) {
    await setClientFeatureOverride({
      clientId: input.clientId,
      featureKey: fk,
      enabled: input.enabled,
      adminEmail: input.adminEmail,
      reason: input.reason || "Bulk feature update",
    });
  }
  return resolveTenantEntitlements(input.clientId, "owner", true);
}

export async function setClientConnectorEntitlement(input: {
  clientId: number;
  connectorId: ConnectorId;
  enabled: boolean;
  maxAccounts?: number;
  rateLimitPerMinute?: number;
  permissions?: ActionPermission[];
  expiresAt?: string | null;
  adminEmail: string;
  reason?: string;
}): Promise<ResolvedTenantEntitlements> {
  const before = await resolveTenantEntitlements(input.clientId, "owner", true);
  const prev = before.connectors[input.connectorId];
  const memState = ensureMemTenant(input.clientId);

  const maxAccounts = input.maxAccounts ?? prev?.maxAccounts ?? 1;
  const rateLimitPerMinute = input.rateLimitPerMinute ?? prev?.rateLimitPerMinute ?? 60;
  const permissions = input.permissions ?? prev?.permissions ?? ["read", "create", "update", "execute"];
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : prev?.expiresAt ?? null;

  memState.connectorOverrides[input.connectorId] = {
    enabled: input.enabled,
    maxAccounts,
    rateLimitPerMinute,
    permissions,
    expiresAt,
  };

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_connector_entitlements
       (client_id, connector_id, enabled, max_accounts, rate_limit_rpm, permissions, expires_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
       ON CONFLICT (client_id, connector_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         max_accounts = EXCLUDED.max_accounts,
         rate_limit_rpm = EXCLUDED.rate_limit_rpm,
         permissions = EXCLUDED.permissions,
         expires_at = EXCLUDED.expires_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        input.clientId,
        input.connectorId,
        input.enabled,
        maxAccounts,
        rateLimitPerMinute,
        JSON.stringify(permissions),
        expiresAt,
        input.adminEmail,
      ]
    ).catch(() => null);
  }

  invalidateEntitlementCache(input.clientId);

  await recordAccessAuditLog({
    adminEmail: input.adminEmail,
    clientId: input.clientId,
    action: input.enabled ? "connector.granted" : "connector.revoked",
    targetType: "connector",
    targetKey: input.connectorId,
    previousValue: prev ? { enabled: prev.enabled, maxAccounts: prev.maxAccounts } : null,
    newValue: { enabled: input.enabled, maxAccounts, rateLimitPerMinute, expiresAt },
    reason: input.reason,
  });

  return resolveTenantEntitlements(input.clientId, "owner", true);
}

export async function setClientQuotaConfig(input: {
  clientId: number;
  metric: QuotaMetricKey;
  limitValue: number | null;
  enforcement: "hard" | "soft" | "unlimited";
  warningThresholdPct?: number;
  resetUsed?: boolean;
  adminEmail: string;
  reason?: string;
}): Promise<ResolvedTenantEntitlements> {
  const before = await resolveTenantEntitlements(input.clientId, "owner", true);
  const prev = before.quotas[input.metric];
  const memState = ensureMemTenant(input.clientId);

  const existingUsed = input.resetUsed ? 0 : prev?.usedValue ?? 0;
  const warningThresholdPct = input.warningThresholdPct ?? prev?.warningThresholdPct ?? 80;
  const lastResetAt = input.resetUsed
    ? new Date().toISOString()
    : prev?.lastResetAt ?? new Date().toISOString();

  memState.quotaOverrides[input.metric] = {
    limitValue: input.enforcement === "unlimited" ? null : input.limitValue,
    enforcement: input.enforcement,
    warningThresholdPct,
    usedValue: existingUsed,
    lastResetAt,
  };

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_usage_quotas
       (client_id, metric, limit_value, enforcement, warning_pct, used_value, last_reset_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (client_id, metric) DO UPDATE SET
         limit_value = EXCLUDED.limit_value,
         enforcement = EXCLUDED.enforcement,
         warning_pct = EXCLUDED.warning_pct,
         used_value = EXCLUDED.used_value,
         last_reset_at = EXCLUDED.last_reset_at,
         updated_at = NOW()`,
      [
        input.clientId,
        input.metric,
        input.enforcement === "unlimited" ? null : input.limitValue,
        input.enforcement,
        warningThresholdPct,
        existingUsed,
        lastResetAt,
      ]
    ).catch(() => null);
  }

  invalidateEntitlementCache(input.clientId);

  await recordAccessAuditLog({
    adminEmail: input.adminEmail,
    clientId: input.clientId,
    action: "quota.updated",
    targetType: "quota",
    targetKey: input.metric,
    previousValue: prev
      ? { limitValue: prev.limitValue, enforcement: prev.enforcement, usedValue: prev.usedValue }
      : null,
    newValue: {
      limitValue: input.enforcement === "unlimited" ? null : input.limitValue,
      enforcement: input.enforcement,
      usedValue: existingUsed,
    },
    reason: input.reason,
  });

  return resolveTenantEntitlements(input.clientId, "owner", true);
}

export async function checkAndConsumeQuota(
  clientId: number,
  metric: QuotaMetricKey,
  amount = 1,
  context?: Record<string, unknown>
): Promise<{
  allowed: boolean;
  warning: boolean;
  used: number;
  limit: number | null;
  enforcement: "hard" | "soft" | "unlimited";
  reason?: string;
}> {
  const resolved = await resolveTenantEntitlements(clientId, "owner", true);
  if (resolved.workspaceStatus !== "Active") {
    return {
      allowed: false,
      warning: false,
      used: 0,
      limit: 0,
      enforcement: "hard",
      reason: "Workspace is " + resolved.workspaceStatus,
    };
  }

  const q = resolved.quotas[metric];
  if (!q) {
    return { allowed: true, warning: false, used: 0, limit: null, enforcement: "unlimited" };
  }

  const nextUsed = q.usedValue + amount;
  if (q.enforcement === "hard" && q.limitValue !== null && nextUsed > q.limitValue) {
    return {
      allowed: false,
      warning: true,
      used: q.usedValue,
      limit: q.limitValue,
      enforcement: "hard",
      reason: `Hard quota exceeded for ${q.label} (${q.usedValue}/${q.limitValue}).`,
    };
  }

  const memState = ensureMemTenant(clientId);
  memState.quotaOverrides[metric] = {
    limitValue: q.limitValue,
    enforcement: q.enforcement,
    warningThresholdPct: q.warningThresholdPct,
    usedValue: nextUsed,
    lastResetAt: q.lastResetAt,
  };

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_usage_quotas (client_id, metric, limit_value, enforcement, warning_pct, used_value, last_reset_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (client_id, metric) DO UPDATE SET
         used_value = of_usage_quotas.used_value + $7,
         updated_at = NOW()`,
      [clientId, metric, q.limitValue, q.enforcement, q.warningThresholdPct, nextUsed, amount]
    ).catch(() => null);

    await neonQuery(
      `INSERT INTO of_usage_events (client_id, metric, delta, context, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())`,
      [clientId, metric, amount, JSON.stringify(context ?? {})]
    ).catch(() => null);
  }

  invalidateEntitlementCache(clientId);

  const warning =
    q.limitValue !== null &&
    q.limitValue > 0 &&
    (nextUsed / q.limitValue) * 100 >= q.warningThresholdPct;

  return {
    allowed: true,
    warning,
    used: nextUsed,
    limit: q.limitValue,
    enforcement: q.enforcement,
  };
}

export async function saveCustomPlanTemplate(
  plan: PlanTemplate,
  adminEmail = "admin"
): Promise<PlanTemplate> {
  const mem = getMem();
  mem.customPlans.set(plan.id, { ...plan, isSystem: false });

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_custom_plans (plan_id, name, description, enabled_features, enabled_connectors, quotas, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
       ON CONFLICT (plan_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         enabled_features = EXCLUDED.enabled_features,
         enabled_connectors = EXCLUDED.enabled_connectors,
         quotas = EXCLUDED.quotas,
         updated_at = NOW()`,
      [
        plan.id,
        plan.name,
        plan.description,
        JSON.stringify(plan.enabledFeatures),
        JSON.stringify(plan.enabledConnectors),
        JSON.stringify(plan.quotas),
      ]
    ).catch(() => null);
  }

  invalidateEntitlementCache();
  await recordAccessAuditLog({
    adminEmail,
    clientId: 0,
    action: "plan.template_saved",
    targetType: "plan",
    targetKey: plan.id,
    previousValue: null,
    newValue: { name: plan.name, featuresCount: plan.enabledFeatures.length },
  });

  return plan;
}

export async function setPlatformRestriction(input: {
  targetType: "feature" | "connector";
  targetKey: FeatureKey | ConnectorId;
  disabled: boolean;
  adminEmail: string;
  reason?: string;
}): Promise<void> {
  const mem = getMem();
  if (input.targetType === "feature") {
    if (input.disabled) {
      mem.platformDisabledFeatures.add(input.targetKey as FeatureKey);
    } else {
      mem.platformDisabledFeatures.delete(input.targetKey as FeatureKey);
    }
  } else {
    if (input.disabled) {
      mem.platformDisabledConnectors.add(input.targetKey as ConnectorId);
    } else {
      mem.platformDisabledConnectors.delete(input.targetKey as ConnectorId);
    }
  }

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `INSERT INTO of_platform_restrictions (target_type, target_key, disabled, reason, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (target_type, target_key) DO UPDATE SET
         disabled = EXCLUDED.disabled,
         reason = EXCLUDED.reason,
         updated_at = NOW()`,
      [input.targetType, input.targetKey, input.disabled, input.reason || ""]
    ).catch(() => null);
  }

  invalidateEntitlementCache();
  await recordAccessAuditLog({
    adminEmail: input.adminEmail,
    clientId: 0,
    action: input.disabled ? "platform.restriction_enabled" : "platform.restriction_lifted",
    targetType: "platform",
    targetKey: `${input.targetType}:${input.targetKey}`,
    previousValue: !input.disabled,
    newValue: input.disabled,
    reason: input.reason,
  });
}

// ============================================================================
// 9. ROUTE & API LOOKUP HELPERS (Section 10 & 12)
// ============================================================================

export function findFeatureForRoute(pathname: string): FeatureDefinition | null {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return FEATURE_CATALOG.find((f) => f.key === "basic.dashboard") ?? null;
  }
  // Match deepest route first
  const sorted = [...FEATURE_CATALOG].sort((a, b) => {
    const maxA = Math.max(0, ...a.routes.map((r) => r.length));
    const maxB = Math.max(0, ...b.routes.map((r) => r.length));
    return maxB - maxA;
  });
  for (const def of sorted) {
    for (const r of def.routes) {
      if (r === "/dashboard") continue;
      if (pathname === r || pathname.startsWith(r + "/")) {
        return def;
      }
    }
  }
  return null;
}

export function findFeatureForApiPath(apiPath: string): FeatureDefinition | null {
  for (const def of FEATURE_CATALOG) {
    for (const prefix of def.apiPrefixes) {
      if (apiPath === prefix || apiPath.startsWith(prefix + "/")) {
        return def;
      }
    }
  }
  return null;
}

// ============================================================================
// 10. MULTI-WORKSPACE CONTROL PLANE & AI ACTIVATOR (100+ Workspaces)
// ============================================================================

export async function activateAllClientWorkspacesInControlPlane(adminEmail = "system@omniflow.ai"): Promise<{
  activatedCount: number;
  clientIds: number[];
}> {
  const discovered = new Map<number, string>();

  if (await ensureEntitlementSchema()) {
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS channel_accounts (
         id BIGSERIAL PRIMARY KEY,
         client_id BIGINT NOT NULL,
         platform TEXT NOT NULL DEFAULT 'whatsapp',
         external_account_id TEXT,
         account_name TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ).catch(() => null);
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_whatsapp_status (
         client_id BIGINT PRIMARY KEY,
         state TEXT NOT NULL DEFAULT 'connected',
         phone TEXT,
         account_name TEXT,
         last_seen_at TIMESTAMPTZ,
         reported_by BIGINT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ).catch(() => null);
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_brain_settings (
         client_id BIGINT PRIMARY KEY,
         autonomy TEXT NOT NULL DEFAULT 'auto',
         tone TEXT NOT NULL DEFAULT 'friendly',
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ).catch(() => null);
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_bot_configs (
         client_id BIGINT PRIMARY KEY,
         agent_name TEXT NOT NULL DEFAULT 'OmniFlow Assistant',
         tone TEXT NOT NULL DEFAULT 'friendly',
         greeting TEXT NOT NULL DEFAULT '',
         fallback TEXT NOT NULL DEFAULT '',
         working_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         working_hours_start TEXT NOT NULL DEFAULT '09:00',
         working_hours_end TEXT NOT NULL DEFAULT '18:00',
         human_handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE,
         updated_by BIGINT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ).catch(() => null);
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_profiles (
         client_id BIGINT PRIMARY KEY,
         profile JSONB NOT NULL DEFAULT '{}'::jsonb,
         updated_by BIGINT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ).catch(() => null);

    const userRes = await neonQuery<{ id: number; email?: string; name?: string }>(
      `SELECT id, email FROM platform_users ORDER BY id ASC`
    ).catch(() => null);
    for (const r of userRes?.rows || []) {
      const cid = Number(r.id);
      if (cid > 0) {
        const label = r.email ? r.email.split("@")[0].replace(/[._-]/g, " ") : `Workspace #${cid}`;
        discovered.set(cid, label || `Workspace #${cid}`);
      }
    }

    const planRes = await neonQuery<{ client_id: number }>(
      `SELECT client_id FROM of_tenant_plans ORDER BY client_id ASC`
    ).catch(() => null);
    for (const r of planRes?.rows || []) {
      const cid = Number(r.client_id);
      if (cid > 0 && !discovered.has(cid)) {
        discovered.set(cid, `Workspace #${cid}`);
      }
    }

    const statusRes = await neonQuery<{ client_id: number; account_name?: string }>(
      `SELECT client_id, account_name FROM portal_whatsapp_status ORDER BY client_id ASC`
    ).catch(() => null);
    for (const r of statusRes?.rows || []) {
      const cid = Number(r.client_id);
      if (cid > 0 && !discovered.has(cid)) {
        discovered.set(cid, r.account_name || `Workspace #${cid}`);
      }
    }

    if (discovered.size === 0) {
      discovered.set(1, "Workspace #1");
    }

    for (const [cid, wname] of discovered.entries()) {
      const acctLabel = `${wname} WhatsApp`;
      const metaJson = JSON.stringify({ session_path: `whatsapp_sessions/account_${cid}` });
      const profileJson = JSON.stringify({
        business_name: wname,
        category: "Customer Support & Commerce",
        city: "Karachi",
        phone: "+923001234567",
        hours: "Mon-Sat 9:00 AM - 9:00 PM",
      });

      await neonQuery(
        `INSERT INTO channel_accounts (id, client_id, platform, external_account_id, account_name, status, metadata)
         VALUES ($1, $1, 'whatsapp', $2, $3, 'active', $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [cid, `wa_${cid}`, acctLabel, metaJson]
      ).catch(() => null);

      await neonQuery(
        `UPDATE portal_whatsapp_status
         SET state = 'disconnected', phone = NULL, updated_at = NOW()
         WHERE client_id = $1 AND phone = '+923001234567'`,
        [cid]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, phone, account_name, last_seen_at, updated_at)
         VALUES ($1, 'disconnected', NULL, $2, NULL, NOW())
         ON CONFLICT (client_id) DO NOTHING`,
        [cid, acctLabel]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_brain_settings (client_id, autonomy, tone, updated_at)
         VALUES ($1, 'auto', 'friendly', NOW())
         ON CONFLICT (client_id) DO UPDATE SET autonomy = 'auto', updated_at = NOW()`,
        [cid]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_bot_configs (client_id, agent_name, tone, greeting, fallback, human_handoff_enabled, updated_at)
         VALUES ($1, $2, 'friendly', $3, 'Thank you for messaging us! Our team will assist you shortly.', TRUE, NOW())
         ON CONFLICT (client_id) DO NOTHING`,
        [cid, `${wname} AI`.slice(0, 64), `Assalam-o-Alaikum! Welcome to ${wname}. How can I help you today?`]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_profiles (client_id, profile, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (client_id) DO NOTHING`,
        [cid, profileJson]
      ).catch(() => null);
    }
  }

  const clientIds = Array.from(discovered.keys()).sort((a, b) => a - b);
  if (clientIds.length === 0) clientIds.push(1);

  await recordAccessAuditLog({
    adminEmail,
    clientId: 0,
    action: "platform.activate_all_workspaces",
    targetType: "platform",
    targetKey: "all_workspaces",
    previousValue: null,
    newValue: { activatedCount: clientIds.length },
    reason: `Activated Control Plane & AI across ${clientIds.length} client workspaces`,
  });

  return {
    activatedCount: clientIds.length,
    clientIds,
  };
}

