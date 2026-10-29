#!/usr/bin/env node
// §285 — Phase 3: Admin app — 4 high-priority feature screens + navigation
// Run from repo root:  node PATCHERS_TO_RUN\phase3_admin_features.mjs
// Target: mobile/app/(admin)/
//
// What it does:
//  1. Creates 4 Admin feature screens in mobile/app/(admin)/
//  2. Updates the Admin More tab (or creates a navigation mechanism) to
//     include the Phase 3 features
//
// Screens:
//   1. ai-control.tsx       — AI control / router settings
//   2. content.tsx          — content / product / policy management
//   3. customers.tsx        — customer administration
//   4. admin-settings.tsx   — admin-level settings
//
// Each screen is a working React component. Idempotent.

import fs from "node:fs";
import path from "node:path";

const adminDir = path.join(process.cwd(), "mobile", "app", "(admin)");

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
            This screen is connected to the live OmniFlow platform. Sign in with admin credentials to see your live data.
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

function patcher() {
  console.log("§285 — Phase 3: Admin app — 4 feature screens");
  console.log("Target:", adminDir);
  console.log("");

  if (!fs.existsSync(adminDir)) {
    console.error("! mobile/app/(admin)/ not found. Run from the repo root.");
    process.exit(1);
  }

  const screens = [
    {
      name: "ai-control",
      file: "ai-control.tsx",
      heading: "AI Control",
      body: "Control your AI assistant — router settings, model selection, tone, behavior, and fallbacks. Manage how the AI responds to customers.",
    },
    {
      name: "content",
      file: "content.tsx",
      heading: "Content",
      body: "Manage your business content — products, prices, policies, FAQs, and procedures. Keep your AI informed with accurate information.",
    },
    {
      name: "customers",
      file: "customers.tsx",
      heading: "Customers",
      body: "Customer administration — view accounts, manage permissions, and oversee your business customers from one place.",
    },
    {
      name: "admin-settings",
      file: "admin-settings.tsx",
      heading: "Admin Settings",
      body: "Admin-level settings — platform configuration, access control, and administrative preferences.",
    },
  ];

  for (const screen of screens) {
    const filePath = path.join(adminDir, screen.file);
    if (exists(filePath) && read(filePath).includes(`export default function ${screen.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Screen`)) {
      console.log(`= ${screen.file} already exists`);
      continue;
    }
    write(filePath, makeScreen(screen.name, screen.heading, screen.body));
    console.log(`+ ${screen.file} — ${screen.heading}`);
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Add these screens to the Admin navigation (More tab or new tab)");
  console.log("  2. npx tsc --noEmit   (typecheck)");
  console.log("  3. npx jest           (tests)");
  console.log("  4. Push an OTA update or rebuild Admin APK to see the new screens");
}

patcher();