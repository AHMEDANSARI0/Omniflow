#!/usr/bin/env node
// §288 — Phase 6: Client app — API Integration
// Run from repo root:  node PATCHERS_TO_RUN\phase6_client_api.mjs
// Target: mobile/app/(client)/

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

function makeApiScreen(name, heading, body, apiEndpoint, dataField, dataLabel) {
  const componentName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const routeName = name.toLowerCase();

  const lines = [
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
    '// §288 Phase 6 - Client feature screen with API integration',
    'export default function ' + componentName + 'Screen() {',
    '  const { colors } = useTheme();',
    '  const router = useRouter();',
    '  const [data, setData] = useState<any>(null);',
    '  const [loading, setLoading] = useState(true);',
    '  const [error, setError] = useState<string | null>(null);',
    '',
    '  useEffect(() => {',
    '    const fetchData = async () => {',
    '      try {',
    '        setLoading(true);',
    '        setError(null);',
    '        const result = await api.get<any>("' + apiEndpoint + '");',
    '        setData(result?.' + dataField + ' ?? result);',
    '      } catch (err: any) {',
    '        setError(err?.message ?? "Failed to load data");',
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
    "      </View>",
    '      <View style={{ flex: 1, padding: spacing.md, justifyContent: "center" }}>',
    '        {loading && (',
    '          <View style={{ alignItems: "center" }}>',
    '            <ActivityIndicator size="large" color={colors.brand} />',
    '            <Text variant="body" style={{ color: colors.ink3, marginTop: spacing.md }}>',
    "              Loading " + heading + "!",
    "            </Text>",
    '          </View>',
    '        )}',
    '        {error && (',
    '          <Card',
    '            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}',
    '          >',
    '            <Text variant="body" weight="medium" style={{ color: colors.danger, marginBottom: spacing.sm }}>',
    '              Error',
    '            </Text>',
    '            <Text variant="body" style={{ color: colors.ink3 }}>',
    '              {error}',
    '            </Text>',
    '            <Spacer size={spacing.md} />',
    '            <Button',
    '              title="Retry"',
    '              onPress={() => window.location.reload()}',
    '              variant="secondary"',
    '            />',
    '          </Card>',
    '        )}',
    '        {!loading && !error && data && (',
    '          <Card',
    '            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}',
    '          >',
    '            <Text variant="body" weight="medium" style={{ color: colors.ink, marginBottom: spacing.sm }}>',
    '              ' + (dataLabel || heading) + ' — Live Data',
    '            </Text>',
    '            <Text variant="body" style={{ color: colors.ink3 }}>',
    '              {JSON.stringify(data).substring(0, 500)}',
    '            </Text>',
    '            <Spacer size={spacing.md} />',
    '            <Button',
    '              title="Refresh"',
    '              onPress={() => window.location.reload()}',
    '              variant="primary"',
    '            />',
    '          </Card>',
    '        )}',
    '        {!loading && !error && !data && (',
    '          <Card',
    '            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}',
    '          >',
    '            <Text variant="body" weight="medium" style={{ color: colors.ink, marginBottom: spacing.sm }}>',
    '              No data available',
    '            </Text>',
    '            <Text variant="body" style={{ color: colors.ink3 }}>',
    '              Sign in to see your live ' + (dataLabel || heading).toLowerCase() + '.',
    '            </Text>',
    '          </Card>',
    '        )}',
    '      </View>',
    '    </View>',
    '  );',
    '}',
    '',
  ];

  return lines.join("\n");
}

const API_SCREENS = [
  { name: "ai-chat", file: "ai-chat.tsx", heading: "AI Chat", body: "Chat with your AI assistant — ask questions, get answers, and solve customer issues in real time.", endpoint: "/api/v1/portal/ai/chat", dataField: "messages", dataLabel: "AI Chat" },
  { name: "knowledge-base", file: "knowledge-base.tsx", heading: "Knowledge Base", body: "Your central knowledge base — all product information, policies, procedures, and FAQs.", endpoint: "/api/v1/portal/knowledge", dataField: "articles", dataLabel: "Knowledge Base" },
  { name: "saved-replies", file: "saved-replies.tsx", heading: "Saved Replies", body: "Quick responses for common questions. Save your best replies and use them to handle customer queries faster.", endpoint: "/api/v1/portal/saved-replies", dataField: "replies", dataLabel: "Saved Replies" },
  { name: "broadcasts", file: "broadcasts.tsx", heading: "Broadcasts", body: "Send messages to your customers — announcements, updates, promotions, and notifications.", endpoint: "/api/v1/portal/broadcasts", dataField: "campaigns", dataLabel: "Broadcasts" },
  { name: "automations", file: "automations.tsx", heading: "Automations", body: "Automate your workflows — triggers, actions, and rules. Set up automations to handle repetitive tasks.", endpoint: "/api/v1/portal/automations", dataField: "rules", dataLabel: "Automations" },
  { name: "pipeline", file: "pipeline.tsx", heading: "Pipeline", body: "Manage your deal pipeline — stages, deals, and progress. See what's closing and what needs attention.", endpoint: "/api/v1/portal/pipeline", dataField: "deals", dataLabel: "Pipeline" },
  { name: "settings", file: "settings.tsx", heading: "Settings", body: "App settings, notifications, account details, and preferences.", endpoint: "/api/v1/portal/settings", dataField: "settings", dataLabel: "Settings" },
  { name: "growth", file: "growth.tsx", heading: "Growth", body: "Growth tools to expand your business — referrals, campaigns, and retention strategies.", endpoint: "/api/v1/portal/growth", dataField: "tools", dataLabel: "Growth" },
  { name: "integrations", file: "integrations.tsx", heading: "Integrations", body: "Connect OmniFlow with other tools you use — sync data, automate workflows, and unify your stack.", endpoint: "/api/v1/portal/integrations", dataField: "integrations", dataLabel: "Integrations" },
];

function patcher() {
  console.log("§288 — Phase 6: Client app — API Integration");
  console.log("Target:", clientDir);
  console.log("");

  if (!fs.existsSync(clientDir)) {
    console.error("! mobile/app/(client)/ not found. Run from the repo root.");
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0;

  for (const screen of API_SCREENS) {
    const filePath = path.join(clientDir, screen.file);

    if (!exists(filePath)) {
      console.warn("! " + screen.file + " not found. Skipping.");
      continue;
    }

    const content = read(filePath);

    if (content.includes("api.get<any>(") && content.includes(screen.endpoint)) {
      console.log("= " + screen.file + " — already has API integration");
      skipped++;
      continue;
    }

    const newContent = makeApiScreen(
      screen.name,
      screen.heading,
      screen.body,
      screen.endpoint,
      screen.dataField,
      screen.dataLabel
    );

    write(filePath, newContent);
    console.log("+ " + screen.file + " — API integration added");
    updated++;
  }

  console.log("");
  console.log("Summary: Updated: " + updated + ", Skipped: " + skipped);
  console.log("");
  console.log("Backend endpoints needed:");
  for (const screen of API_SCREENS) {
    console.log("  " + screen.endpoint);
  }
  console.log("");
  console.log("Next: npx tsc --noEmit  &&  npx jest");
}

patcher();