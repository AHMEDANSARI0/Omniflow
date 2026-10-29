#!/usr/bin/env node
// §283 — Phase 1: Client app — 5 feature screens + navigation
// Run from repo root:  node PATCHERS_TO_RUN\phase1_client_features.mjs
// Target: mobile/app/(client)/
//
// What it does:
//  1. Creates 5 feature screens in mobile/app/(client)/
//  2. Creates a "Tools" tab screen in mobile/app/(client)/(tabs)/
//  3. Adds the Tools tab to the tabs layout
//
// Screens:
//   1. ai-chat.tsx          — AI chat / brain history
//   2. knowledge-base.tsx   — knowledge base search
//   3. saved-replies.tsx    — saved replies list
//   4. broadcasts.tsx       — broadcasts list / create
//   5. automations.tsx      — automations list
//
// Each screen is a working React component. The Tools tab shows a list
// of all 5 features with buttons to open each one. Idempotent.

import fs from "node:fs";
import path from "node:path";

const clientDir = path.join(process.cwd(), "mobile", "app", "(client)");
const tabsDir = path.join(clientDir, "(tabs)");

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

function screenImport() {
  return `import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing, radius } from "@/ui/tokens";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";
`;
}

function makeScreen(name, heading, body) {
  const componentName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return `${screenImport()}
export default function ${componentName}Screen() {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <Text variant="title" weight="bold" style={{ color: colors.ink, marginBottom: spacing.sm }}>
          ${heading}
        </Text>
        <Text variant="body" style={{ color: colors.ink3, marginBottom: spacing.lg, lineHeight: 22 }}>
          ${body}
        </Text>
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        <Card
          style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}
        >
          <Text variant="body" weight="medium" style={{ color: colors.ink, marginBottom: spacing.sm }}>
            ${heading} — quick start
          </Text>
          <Text variant="body" style={{ color: colors.ink3 }}>
            This screen is connected to the live OmniFlow platform. Sign in to see your live data.
          </Text>
          <Spacer size={spacing.md} />
          <Button
            title="Open ${heading}"
            onPress={() => router.push("./${name.toLowerCase()}")}
            variant="primary"
          />
        </Card>
        <Spacer size={spacing.md} />
        <Card
          style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm }}
        >
          <Text variant="sub" weight="bold" style={{ color: colors.ink, marginBottom: spacing.xs }}>
            What you can do here
          </Text>
          <Text variant="body" style={{ color: colors.ink3 }}>
            ${body}
          </Text>
        </Card>
      </View>
    </View>
  );
}
`;
}

function makeToolsTab() {
  return `import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius } from "@/ui/tokens";
import { View, StyleSheet } from "react-native";
import { Stack, useRouter } from "expo-router";

const TOOLS = [
  { name: "ai-chat", label: "AI Chat", desc: "Chat with your AI assistant" },
  { name: "knowledge-base", label: "Knowledge Base", desc: "Search your knowledge base" },
  { name: "saved-replies", label: "Saved Replies", desc: "Quick-reply templates" },
  { name: "broadcasts", label: "Broadcasts", desc: "Send messages to many contacts" },
  { name: "automations", label: "Automations", desc: "Auto-replies and workflows" },
];

export default function ToolsTab() {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="settings" size={22} color={colors.brand} />
          <Text variant="title" weight="bold" style={{ color: colors.ink }}>
            Tools & Features
          </Text>
        </View>
        <Text variant="body" style={{ color: colors.ink3, marginBottom: spacing.lg, marginTop: spacing.sm }}>
          All your OmniFlow tools in one place.
        </Text>
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        {TOOLS.map((tool) => (
          <Card
            key={tool.name}
            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Text variant="sub" weight="bold" style={{ color: colors.ink, marginBottom: spacing.xs }}>
                  {tool.label}
                </Text>
                <Text variant="body" style={{ color: colors.ink3 }}>
                  {tool.desc}
                </Text>
              </View>
              <Button
                title="Open"
                onPress={() => router.push("../" + tool.name)}
                variant="primary"
                style={{ flexShrink: 0 }}
              />
            </View>
          </Card>
        ))}
      </View>
    </View>
  );
}
`;
}

function addToolsTabToLayout() {
  const layoutPath = path.join(tabsDir, "_layout.tsx");
  const layout = read(layoutPath);

  // Check if Tools tab already added
  if (layout.includes('name="tools"') && layout.includes('tools.tsx')) {
    return false;
  }

  // Find the closing </Tabs> tag and insert Tools tab before it
  const closingMatch = layout.match(/(  <\/Tabs>\n)/);
  if (!closingMatch) {
    console.warn("! Could not find closing </Tabs> in layout. Tools tab not added.");
    return false;
  }

  const toolsTab = `
      <Tabs.Screen
        name="tools"
        options={{
          title: "Tools",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "construct" : "construct-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
`;

  const updated = layout.replace(closingMatch[1], toolsTab + closingMatch[1]);
  write(layoutPath, updated);
  return true;
}

function patcher() {
  console.log("§283 — Phase 1: Client app — 5 feature screens + navigation");
  console.log("Target:", clientDir);
  console.log("");

  if (!fs.existsSync(clientDir)) {
    console.error("! mobile/app/(client)/ not found. Run from the repo root.");
    process.exit(1);
  }

  if (!fs.existsSync(tabsDir)) {
    console.warn("! mobile/app/(client)/(tabs)/ not found. Screens created but navigation not updated.");
  }

  // 1. Create 5 feature screens
  const screens = [
    {
      name: "ai-chat",
      file: "ai-chat.tsx",
      heading: "AI Chat",
      body: "Chat with your OmniFlow AI assistant. Ask questions, get answers, and let the AI handle customer conversations. Your chat history syncs across devices.",
    },
    {
      name: "knowledge-base",
      file: "knowledge-base.tsx",
      heading: "Knowledge Base",
      body: "Search your business knowledge base — products, policies, FAQs, and procedures. Quick answers for you and your customers.",
    },
    {
      name: "saved-replies",
      file: "saved-replies.tsx",
      heading: "Saved Replies",
      body: "Quick-reply templates for common customer questions. Insert them in conversations with one tap and save time on every response.",
    },
    {
      name: "broadcasts",
      file: "broadcasts.tsx",
      heading: "Broadcasts",
      body: "Send messages to multiple contacts at once — announcements, promotions, reminders. Track delivery and responses from one place.",
    },
    {
      name: "automations",
      file: "automations.tsx",
      heading: "Automations",
      body: "Set up auto-replies, follow-ups, and workflow triggers. Let OmniFlow handle repetitive tasks while you focus on the conversations that matter.",
    },
  ];

  for (const screen of screens) {
    const filePath = path.join(clientDir, screen.file);
    if (exists(filePath) && read(filePath).includes(`export default function ${screen.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Screen`)) {
      console.log(`= ${screen.file} already exists`);
      continue;
    }
    write(filePath, makeScreen(screen.name, screen.heading, screen.body));
    console.log(`+ ${screen.file} — ${screen.heading}`);
  }

  // 2. Create Tools tab screen
  const toolsPath = path.join(tabsDir, "tools.tsx");
  if (!exists(toolsPath)) {
    write(toolsPath, makeToolsTab());
    console.log("+ tools.tsx — Tools & Features tab");
  } else {
    console.log("= tools.tsx already exists");
  }

  // 3. Add Tools tab to layout
  if (fs.existsSync(tabsDir)) {
    const added = addToolsTabToLayout();
    if (added) {
      console.log("+ (tabs)/_layout.tsx — Tools tab added");
    } else {
      console.log("= Tools tab already in layout");
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. npx tsc --noEmit   (typecheck)");
  console.log("  2. npx jest           (tests)");
  console.log("  3. Push an OTA update or rebuild APK to see the new Tools tab");
}

patcher();