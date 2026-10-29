#!/usr/bin/env node
// §290 — Phase 8: Client app — Proper Data Formatting
// Run from repo root:  node PATCHERS_TO_RUN\phase8_client_format.mjs

import fs from "node:fs";
import path from "node:path";

const clientDir = path.join(process.cwd(), "mobile", "app", "(client)");

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, text) {
  ensureDir(p);
  const wasCRLF = fs.existsSync(p) && read(p).includes("\r\n");
  const out = wasCRLF ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(p, out, "utf8");
}
function exists(p) { return fs.existsSync(p); }

function makeListScreen(name, heading, body, itemLabel, fields) {
  const componentName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  
  // Build field display lines
  const fieldLines = fields.map((f, i) => {
    const comma = i > 0 ? ", " : "";
    return `              <Text variant="body" style={{ color: colors.ink${comma}marginTop: spacing.xs }}>${f.label}: {item.${f.field}}</Text>`;
  }).join("\n");

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
    'import { Ionicons } from "@expo/vector-icons";',
    '',
    '// §290 Phase 8 - ' + heading + ' screen',
    'export default function ' + componentName + 'Screen() {',
    '  const { colors } = useTheme();',
    '  const router = useRouter();',
    '  const [items, setItems] = useState<any[]>([]);',
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
    '        const result = await api.get<any>("/api/v1/portal/' + name + '");',
    '        setItems(result?.' + itemLabel + ' ?? result?.' + itemLabel + ' ?? []);',
    '      } catch (err: any) {',
    '        setIsMock(true);',
    '        setItems(' + getMockData(name) + ');',
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
    '        <Text variant="title" weight="bold" style={{ color: colors.ink }}>',
    "          " + heading,
    "        </Text>",
    '        <Text variant="body" style={{ color: colors.ink3, marginTop: spacing.xs }}>',
    "          " + body,
    "        </Text>",
    '        {isMock && (',
    '          <Text variant="caption" tone="ok" style={{ alignSelf: "flex-start" }}>',
    "            Offline mode",
    "          </Text>",
    "        )}",
    "      </View>",
    '      <View style={{ flex: 1, padding: spacing.md }}>',
    '        {loading && (',
    '          <View style={{ alignItems: "center", justifyContent: "center", height: 200 }}>',
    '            <ActivityIndicator size="large" color={colors.brand} />',
    "          </View>",
    "        )}",
    '        {!loading && items.length === 0 && (',
    '          <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, alignItems: "center" }}>',
    '            <Text variant="body" style={{ color: colors.ink3 }}>No items found</Text>',
    "          </Card>",
    "        )}",
    '        {!loading && items.length > 0 && (',
    '          <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm }}>',
    '            {items.map((item) => (',
    '              <View',
    '                key={item.id ?? Math.random()}',
    '                style={{',
    '                  flexDirection: "row",',
    '                  alignItems: "flex-start",',
    '                  paddingVertical: spacing.sm,',
    '                  borderBottomWidth: 0.5,',
    '                  borderBottomColor: colors.line,',
    '                }}',
    '              >',
    '                <Ionicons',
    '                  name="ellipse"',
    '                  size={16}',
    '                  color={colors.brand}',
    '                  style={{ marginRight: spacing.sm, marginTop: 2 }}',
    '                />',
    '                <View style={{ flex: 1 }}>',
    '                  <Text variant="body" weight="medium" style={{ color: colors.ink }}>',
    "                    {item.title ?? item.name ?? item.label ?? 'Item'}",
    "                  </Text>",
    fieldLines,
    "                </View>",
    "              </View>",
    "            ))}",
    "          </Card>",
    "        )}",
    "      </View>",
    "      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderTopWidth: 0.5, borderTopColor: colors.line }}>",
    '        <Button',
    '          title="Refresh"',
    '          onPress={() => window.location.reload()}',
    '          variant="primary"',
    '        />',
    "      </View>",
    "    </View>",
    "  );",
    "}",
    "",
  ].join("\n");
}

function getMockData(name) {
  const mocks = {
    "knowledge-base": '[{ "id": "1", "title": "Business Hours Policy", "category": "Policy", "updated": "2024-01-10" }, { "id": "2", "title": "Return Guidelines", "category": "Policy", "updated": "2024-01-08" }, { "id": "3", "title": "Shipping FAQ", "category": "FAQ", "updated": "2024-01-05" }]',
    "saved-replies": '[{ "id": "1", "title": "Business Hours", "content": "Mon-Fri 9AM-6PM", "usage": 45 }, { "id": "2", "title": "Pricing", "content": "Check website", "usage": 32 }]',
    "broadcasts": '[{ "id": "1", "name": "New Year Sale", "status": "sent", "sentAt": "2024-01-01", "recipients": 500, "delivered": 480 }]',
    "automations": '[{ "id": "1", "name": "Welcome Message", "trigger": "new_customer", "status": "active", "runsToday": 15 }]',
    "pipeline": '[{ "id": "1", "name": "Enterprise Deal", "stage": "negotiation", "value": 50000, "probability": 70 }]',
    "growth": '[{ "id": "1", "name": "Referral Program", "status": "active", "referralsThisMonth": 12 }]',
    "integrations": '[{ "id": "1", "name": "WhatsApp", "status": "connected", "lastSync": "2024-01-15" }]',
    "settings": '[{ "id": "1", "title": "Business Name", "value": "OmniFlow Demo" }, { "id": "2", "title": "Timezone", "value": "Asia/Karachi" }]',
  };
  return mocks[name] || "[]";
}

const SCREENS = [
  { name: "knowledge-base", file: "knowledge-base.tsx", heading: "Knowledge Base", body: "Your central knowledge base.", itemLabel: "articles", fields: [{ field: "category", label: "Category" }, { field: "updated", label: "Updated" }] },
  { name: "saved-replies", file: "saved-replies.tsx", heading: "Saved Replies", body: "Quick responses for common questions.", itemLabel: "replies", fields: [{ field: "content", label: "Message" }, { field: "usage", label: "Used" }] },
  { name: "broadcasts", file: "broadcasts.tsx", heading: "Broadcasts", body: "Send messages to customers.", itemLabel: "campaigns", fields: [{ field: "status", label: "Status" }, { field: "sentAt", label: "Sent" }, { field: "delivered", label: "Delivered" }] },
  { name: "automations", file: "automations.tsx", heading: "Automations", body: "Automate workflows.", itemLabel: "rules", fields: [{ field: "trigger", label: "Trigger" }, { field: "status", label: "Status" }, { field: "runsToday", label: "Today" }] },
  { name: "pipeline", file: "pipeline.tsx", heading: "Pipeline", body: "Manage deal pipeline.", itemLabel: "deals", fields: [{ field: "stage", label: "Stage" }, { field: "value", label: "Value" }, { field: "probability", label: "Prob." }] },
  { name: "growth", file: "growth.tsx", heading: "Growth", body: "Growth tools.", itemLabel: "tools", fields: [{ field: "status", label: "Status" }] },
  { name: "integrations", file: "integrations.tsx", heading: "Integrations", body: "Connect with other tools.", itemLabel: "integrations", fields: [{ field: "status", label: "Status" }, { field: "lastSync", label: "Last Sync" }] },
  { name: "settings", file: "settings.tsx", heading: "Settings", body: "App settings.", itemLabel: "settings", fields: [{ field: "value", label: "Value" }] },
];

function patcher() {
  console.log("§290 — Phase 8: Proper Data Formatting");
  console.log("");

  for (const screen of SCREENS) {
    const filePath = path.join(clientDir, screen.file);
    if (!exists(filePath)) {
      write(filePath, makeListScreen(screen.name, screen.heading, screen.body, screen.itemLabel, screen.fields));
      console.log("+ " + screen.file + " — formatted");
    } else {
      const content = read(filePath);
      if (content.includes("JSON.stringify(data)") && !content.includes("item.title")) {
        write(filePath, makeListScreen(screen.name, screen.heading, screen.body, screen.itemLabel, screen.fields));
        console.log("+ " + screen.file + " — reformatted");
      } else {
        console.log("= " + screen.file + " — already formatted");
      }
    }
  }

  console.log("");
  console.log("Done. Screens now show proper formatted data.");
}

patcher();  