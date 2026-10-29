#!/usr/bin/env node
// §289 — Phase 7: Client app — Mock Data Fallback
// Run from repo root:  node PATCHERS_TO_RUN\phase7_client_mock_data.mjs
// Target: mobile/app/(client)/
//
// This patcher adds mock data fallback to all client screens.
// When the API is unavailable (404, network error), screens show
// realistic mock data instead of empty/error state.
//
// This ensures the app works even before backend endpoints are ready.
//
// Idempotent. Safe to re-run.

import fs from "node:fs";
import path from "node:path";

const clientDir = path.join(process.cwd(), "mobile", "app", "(client)");

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function write(p, text) {
  ensureDir(p);
  const wasCRLF = fs.existsSync(p) && read(p).includes("\r\n");
  const out = wasCRLF ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(p, out, "utf8");
}

function exists(p) {
  return fs.existsSync(p);
}

function makeScreenWithMockData(name, heading, body, apiEndpoint, dataField, dataLabel, mockData) {
  const componentName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const routeName = name.toLowerCase();

  const mockDataStr = JSON.stringify(mockData, null, 2);

  return [
    'import { useTheme } from "@/ui/theme";',
    'import { Text, Card, Spacer } from "@/ui/primitives";',
    'import { Button } from "@/ui/Button";',
    'import { spacing, radius } from "@/ui/tokens";',
    'import { View } from "react-native";',
    'import { Stack, useRouter } from "expo-router";',
    'import { useState, useEffect } from "react";',
    'import { api } from "@/api/client";',
    'import { ActivityIndicator } from "react-native";',
    '',
    '// §289 Phase 7 - Client feature screen with API + mock data',
    'export default function ' + componentName + 'Screen() {',
    '  const { colors } = useTheme();',
    '  const router = useRouter();',
    '  const [data, setData] = useState<any>(null);',
    '  const [loading, setLoading] = useState(true);',
    '  const [error, setError] = useState<string | null>(null);',
    '  const [isMock, setIsMock] = useState(false);',
    '',
    '  useEffect(() => {',
    '    const fetchData = async () => {',
    '      try {',
    '        setLoading(true);',
    '        setError(null);',
    '        setIsMock(false);',
    '        const result = await api.get<any>("' + apiEndpoint + '");',
    '        setData(result?.' + dataField + ' ?? result);',
    '      } catch (err: any) {',
    '        // Fallback to mock data when API is unavailable',
    '        setIsMock(true);',
    '        setData(' + mockDataStr + ');',
    '        setError(err?.message ?? "Using offline data");',
    '      } finally {',
    '        setLoading(false);',
    '      }',
    '    };',
    '    fetchData();',
    '  }, []);',
    '',
    '  return (',
    '    <View style={{ flex: 1, backgroundColor: colors.canvas }}>',
    '      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>',
    '        <Text variant="title" weight="bold" style={{ color: colors.ink, marginBottom: spacing.sm }}>',
    "          " + heading,
    "        </Text>",
    '        <Text variant="body" style={{ color: colors.ink3, marginBottom: spacing.lg, lineHeight: 22 }}>',
    "          " + body,
    "        </Text>",
    '        {isMock && (',
    '          <Text variant="caption" tone="ok" style={{ alignSelf: "flex-start" }}>',
    "            Offline mode",
    "          </Text>",
    "        )}",
    '      </View>',
    '      <View style={{ flex: 1, padding: spacing.md, justifyContent: loading ? "center" : "flex-start" }}>',
    '        {loading && (',
    '          <View style={{ alignItems: "center" }}>',
    '            <ActivityIndicator size="large" color={colors.brand} />',
    '            <Text variant="body" style={{ color: colors.ink3, marginTop: spacing.md }}>',
    "              Loading " + heading + "!",
    "            </Text>",
    "          </View>",
    "        )}",
    '        {!loading && data && (',
    '          <Card',
    '            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md }}',
    '          >',
    '            <Text variant="body" weight="medium" style={{ color: colors.ink, marginBottom: spacing.sm }}>',
    '              ' + (dataLabel || heading) + '',
    '            </Text>',
    '            <Text variant="body" style={{ color: colors.ink3 }}>',
    '              {JSON.stringify(data).substring(0, 800)}',
    '            </Text>',
    '          </Card>',
    "        )}",
    '        <Button',
    '          title="Refresh"',
    '          onPress={() => window.location.reload()}',
    '          variant="primary"',
    '          style={{ marginTop: spacing.sm }}',
    '        />',
    "      </View>",
    "    </View>",
    "  );",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mock data for each screen
// ---------------------------------------------------------------------------

const MOCK_SCREENS = [
  {
    name: "ai-chat",
    file: "ai-chat.tsx",
    heading: "AI Chat",
    body: "Chat with your AI assistant — ask questions, get answers, and solve customer issues in real time.",
    endpoint: "/api/v1/portal/ai/chat",
    dataField: "messages",
    dataLabel: "AI Chat",
    mockData: {
      messages: [
        { id: "1", role: "user", content: "What are your business hours?", timestamp: "2024-01-15T10:00:00Z" },
        { id: "2", role: "assistant", content: "Our business hours are Monday to Friday, 9 AM to 6 PM. How can I help you?", timestamp: "2024-01-15T10:00:30Z" },
        { id: "3", role: "user", content: "Do you offer weekend support?", timestamp: "2024-01-15T10:01:00Z" },
        { id: "4", role: "assistant", content: "Yes, we offer limited weekend support from 10 AM to 2 PM on Saturdays.", timestamp: "2024-01-15T10:01:30Z" },
      ],
      stats: { totalChats: 150, resolved: 120, pending: 30 },
    },
  },
  {
    name: "knowledge-base",
    file: "knowledge-base.tsx",
    heading: "Knowledge Base",
    body: "Your central knowledge base — all product information, policies, procedures, and FAQs.",
    endpoint: "/api/v1/portal/knowledge",
    dataField: "articles",
    dataLabel: "Knowledge Base",
    mockData: {
      articles: [
        { id: "1", title: "Business Hours Policy", category: "Policy", updated: "2024-01-10" },
        { id: "2", title: "Product Return Guidelines", category: "Policy", updated: "2024-01-08" },
        { id: "3", title: "FAQ: Shipping Information", category: "FAQ", updated: "2024-01-05" },
        { id: "4", title: "Contact Support", category: "Support", updated: "2024-01-03" },
      ],
      totalArticles: 25,
    },
  },
  {
    name: "saved-replies",
    file: "saved-replies.tsx",
    heading: "Saved Replies",
    body: "Quick responses for common questions. Save your best replies and use them to handle customer queries faster.",
    endpoint: "/api/v1/portal/saved-replies",
    dataField: "replies",
    dataLabel: "Saved Replies",
    mockData: {
      replies: [
        { id: "1", title: "Business Hours", content: "Our business hours are Mon-Fri 9AM-6PM.", usage: 45 },
        { id: "2", title: "Pricing Info", content: "Check our website for current pricing: [link]", usage: 32 },
        { id: "3", title: "Order Status", content: "You can track your order using the tracking number provided.", usage: 28 },
      ],
      totalReplies: 12,
    },
  },
  {
    name: "broadcasts",
    file: "broadcasts.tsx",
    heading: "Broadcasts",
    body: "Send messages to your customers — announcements, updates, promotions, and notifications.",
    endpoint: "/api/v1/portal/broadcasts",
    dataField: "campaigns",
    dataLabel: "Broadcasts",
    mockData: {
      campaigns: [
        { id: "1", name: "New Year Sale", status: "sent", sentAt: "2024-01-01", recipients: 500, delivered: 480 },
        { id: "2", name: "Welcome Offer", status: "draft", createdAt: "2024-01-10", recipients: 0, delivered: 0 },
      ],
      totalCampaigns: 8,
    },
  },
  {
    name: "automations",
    file: "automations.tsx",
    heading: "Automations",
    body: "Automate your workflows — triggers, actions, and rules. Set up automations to handle repetitive tasks.",
    endpoint: "/api/v1/portal/automations",
    dataField: "rules",
    dataLabel: "Automations",
    mockData: {
      rules: [
        { id: "1", name: "Welcome Message", trigger: "new_customer", status: "active", runsToday: 15 },
        { id: "2", name: "Order Confirmation", trigger: "order_placed", status: "active", runsToday: 23 },
        { id: "3", name: "Follow-up", trigger: "no_reply_24h", status: "paused", runsToday: 0 },
      ],
      totalRules: 6,
    },
  },
  {
    name: "pipeline",
    file: "pipeline.tsx",
    heading: "Pipeline",
    body: "Manage your deal pipeline — stages, deals, and progress. See what's closing and what needs attention.",
    endpoint: "/api/v1/portal/pipeline",
    dataField: "deals",
    dataLabel: "Pipeline",
    mockData: {
      deals: [
        { id: "1", name: "Enterprise Deal", stage: "negotiation", value: 50000, probability: 70 },
        { id: "2", name: "Small Business", stage: "proposal", value: 5000, probability: 50 },
        { id: "3", name: "Startup Package", stage: "qualified", value: 2500, probability: 30 },
      ],
      totalDeals: 12,
      totalValue: 125000,
    },
  },
  {
    name: "settings",
    file: "settings.tsx",
    heading: "Settings",
    body: "App settings, notifications, account details, and preferences.",
    endpoint: "/api/v1/portal/settings",
    dataField: "settings",
    dataLabel: "Settings",
    mockData: {
      settings: {
        businessName: "OmniFlow Demo",
        timezone: "Asia/Karachi",
        currency: "PKR",
        language: "en",
        notifications: { enabled: true, sounds: true, haptics: true },
        theme: "system",
      },
    },
  },
  {
    name: "growth",
    file: "growth.tsx",
    heading: "Growth",
    body: "Growth tools to expand your business — referrals, campaigns, and retention strategies.",
    endpoint: "/api/v1/portal/growth",
    dataField: "tools",
    dataLabel: "Growth",
    mockData: {
      tools: [
        { id: "1", name: "Referral Program", status: "active", referralsThisMonth: 12 },
        { id: "2", name: "Loyalty Rewards", status: "active", members: 150 },
        { id: "3", name: "Email Campaigns", status: "draft", scheduled: 2 },
      ],
      totalTools: 5,
    },
  },
  {
    name: "integrations",
    file: "integrations.tsx",
    heading: "Integrations",
    body: "Connect OmniFlow with other tools you use — sync data, automate workflows, and unify your stack.",
    endpoint: "/api/v1/portal/integrations",
    dataField: "integrations",
    dataLabel: "Integrations",
    mockData: {
      integrations: [
        { id: "1", name: "WhatsApp", status: "connected", lastSync: "2024-01-15T10:00:00Z" },
        { id: "2", name: "Gmail", status: "connected", lastSync: "2024-01-15T09:30:00Z" },
        { id: "3", name: "Slack", status: "disconnected", lastSync: null },
      ],
      totalIntegrations: 4,
    },
  },
];

// ---------------------------------------------------------------------------
// Main patcher
// ---------------------------------------------------------------------------

function patcher() {
  console.log("§289 — Phase 7: Client app — Mock Data Fallback");
  console.log("Target:", clientDir);
  console.log("");

  if (!fs.existsSync(clientDir)) {
    console.error("! mobile/app/(client)/ not found. Run from the repo root.");
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0;

  for (const screen of MOCK_SCREENS) {
    const filePath = path.join(clientDir, screen.file);

    if (!exists(filePath)) {
      console.warn("! " + screen.file + " not found. Skipping.");
      continue;
    }

    const content = read(filePath);

    // Check if already has mock data fallback
    if (content.includes("isMock") && content.includes("Offline mode")) {
      console.log("= " + screen.file + " — already has mock data fallback");
      skipped++;
      continue;
    }

    const newContent = makeScreenWithMockData(
      screen.name,
      screen.heading,
      screen.body,
      screen.endpoint,
      screen.dataField,
      screen.dataLabel,
      screen.mockData
    );

    write(filePath, newContent);
    console.log("+ " + screen.file + " — mock data added");
    updated++;
  }

  console.log("");
  console.log("Summary: Updated: " + updated + ", Skipped: " + skipped);
  console.log("");
  console.log("Now screens show mock data when API is unavailable.");
  console.log("When backend endpoints are ready, real data will show automatically.");
  console.log("");
  console.log("Next: npx tsc --noEmit  &&  npx jest");
}

patcher();