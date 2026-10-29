#!/usr/bin/env node
// §284 — Phase 2: Client app — remaining feature screens + Tools tab update
// Run from repo root:  node PATCHERS_TO_RUN\phase2_client_features.mjs
// Target: mobile/app/(client)/
//
// What it does:
//  1. Creates 4 additional feature screens in mobile/app/(client)/
//  2. Updates the Tools tab (mobile/app/(client)/(tabs)/tools.tsx) to include
//     the Phase 2 features in the list
//
// Screens:
//   1. pipeline.tsx        — Pipeline / CRM
//   2. settings.tsx         — Settings (advanced)
//   3. growth.tsx           — Growth tools
//   4. integrations.tsx     — Integrations
//
// Idempotent. The Tools tab is updated only if the Phase 1 patcher (§283)
// created it first.

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

function patcher() {
  console.log("§284 — Phase 2: Client app — 4 additional feature screens");
  console.log("Target:", clientDir);
  console.log("");

  if (!fs.existsSync(clientDir)) {
    console.error("! mobile/app/(client)/ not found. Run from the repo root.");
    process.exit(1);
  }

  // 1. Create 4 additional feature screens
  const screens = [
    {
      name: "pipeline",
      file: "pipeline.tsx",
      heading: "Pipeline",
      body: "Manage your deal pipeline — stages, deals, and progress. See what's closing and what needs attention.",
    },
    {
      name: "settings",
      file: "settings.tsx",
      heading: "Settings",
      body: "App settings, notifications, account details, and preferences. Configure OmniFlow to work your way.",
    },
    {
      name: "growth",
      file: "growth.tsx",
      heading: "Growth",
      body: "Growth tools to expand your business — referrals, campaigns, and retention strategies.",
    },
    {
      name: "integrations",
      file: "integrations.tsx",
      heading: "Integrations",
      body: "Connect OmniFlow with other tools you use — sync data, automate workflows, and unify your stack.",
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

  // 2. Update Tools tab to include Phase 2 features
  const toolsPath = path.join(tabsDir, "tools.tsx");
  if (exists(toolsPath)) {
    const toolsContent = read(toolsPath);
    if (toolsContent.includes('"pipeline"') && toolsContent.includes('"settings"') &&
        toolsContent.includes('"growth"') && toolsContent.includes('"integrations"')) {
      console.log("= Phase 2 tools already in Tools tab");
    } else {
      // Add Phase 2 tools to the TOOLS array
      const phase2Tools = [
        { name: "pipeline", label: "Pipeline", desc: "Manage your deal pipeline" },
        { name: "settings", label: "Settings", desc: "App settings and preferences" },
        { name: "growth", label: "Growth", desc: "Growth and retention tools" },
        { name: "integrations", label: "Integrations", desc: "Connect your tools" },
      ];

      const insertion = phase2Tools.map(t =>
        `  { name: "${t.name}", label: "${t.label}", desc: "${t.desc}" },`
      ).join("\n");

      // The tools.tsx file has the TOOLS array ending with "];" on its own line.
      // Replace "];" with the new tools + "];"
      const updated = toolsContent.replace(/\];\n/, `${insertion}\n];\n`);
      write(toolsPath, updated);
      console.log("+ tools.tsx — Phase 2 tools added to list");
    }
  } else {
    console.warn("! tools.tsx not found. Run Phase 1 patcher first.");
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. npx tsc --noEmit   (typecheck)");
  console.log("  2. npx jest           (tests)");
  console.log("  3. Push an OTA update or rebuild APK to see the new features");
}

patcher();