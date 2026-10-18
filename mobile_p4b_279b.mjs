// §279b P4 hotfix: lazy fail-soft imports for expo-notifications and
// expo-haptics. Fixes the Expo Go crash 'Cannot find native module
// ExpoTopicSubscriptionModule' (a top-level import poisoned the route
// tree). Alerts now degrade to off on runtimes without the native module.
// Run from the repo root AFTER mobile_p4_279.mjs:
//   node mobile_p4b_279b.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_279b.bak";
let applied = 0, already = 0, warnings = 0;
if (!fs.existsSync("OmniFlow-Control-Plane") || !fs.statSync("OmniFlow-Control-Plane").isDirectory()) {
  console.log("X Run this from the website repo root (bot root) - the folder that contains OmniFlow-Control-Plane/. Nothing was written.");
  process.exit(1);
}
if (!fs.existsSync("OmniFlow-Control-Plane/app.py")) {
  console.log("X OmniFlow-Control-Plane/ is empty or not the Control Plane repo (no app.py). On a fresh machine the website clone leaves this folder empty: delete it, then clone the Control Plane repo into it (git clone <CP repo url> OmniFlow-Control-Plane) and run this again. Nothing was written.");
  process.exit(1);
}
function compilePython(pathArg) {
  const { spawnSync } = require("child_process");
  for (const py of ["python3", "python", "py"]) {
    const probe = spawnSync(py, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const check = spawnSync(py, ["-c", "import sys;sys.exit(0 if sys.version_info[0]>=3 else 1)"], { encoding: "utf8" });
    if (check.status !== 0) continue;
    const result = spawnSync(py, ["-c", "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True);sys.exit(0)", pathArg], { encoding: "utf8" });
    return result.status === 0;
  }
  console.log("  (python not found - skipped compile guard)");
  return true;
}
function writeNewRepair(repoPath, marker, isCp, content) {
  try {
  let existed = false;
  if (fs.existsSync(repoPath)) {
    if (fs.statSync(repoPath).isDirectory()) {
      let target = repoPath + ".dir_conflict.bak";
      let n = 1;
      while (fs.existsSync(target)) { target = repoPath + ".dir_conflict.bak." + n; n++; }
      fs.renameSync(repoPath, target);
      console.log("! " + repoPath + " was a DIRECTORY on this machine - renamed to " + target + "; writing the real file.");
      warnings++;
    } else existed = true;
  }
  if (!existed) {
    const cut = Math.max(repoPath.lastIndexOf("/"), repoPath.lastIndexOf("\\"));
    if (cut > 0) fs.mkdirSync(repoPath.slice(0, cut), { recursive: true });
    fs.writeFileSync(repoPath, content, "utf8");
    if (isCp && repoPath.endsWith(".py") && !compilePython(repoPath)) {
      fs.unlinkSync(repoPath);
      console.log("X " + repoPath + " FAILED to compile - not written");
      warnings++;
      return;
    }
    console.log("+ " + repoPath + " (new file)");
    applied++;
    return;
  }
  const original = fs.readFileSync(repoPath, "utf8").replace(/\r\n/g, "\n");
  if (original.includes(marker)) {
    console.log("= " + repoPath + " (already correct)");
    already++;
    return;
  }
  const backup = repoPath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
  fs.writeFileSync(repoPath, content, "utf8");
  if (isCp && repoPath.endsWith(".py") && !compilePython(repoPath)) {
    fs.copyFileSync(backup, repoPath);
    console.log("X " + repoPath + " FAILED to compile - old copy restored");
    warnings++;
    return;
  }
  console.log("+ " + repoPath + " (REPAIRED - old copy kept as " + BACKUP_TAG + ")");
  applied++;
  } catch (err) {
    console.log("X " + repoPath + " FAILED: " + err.message);
    warnings++;
  }
}
function removeFile(repoPath) {
  try {
    if (!fs.existsSync(repoPath)) {
      console.log("= " + repoPath + " (already removed)");
      already++;
      return;
    }
    const backup = repoPath + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
    fs.unlinkSync(repoPath);
    console.log("- " + repoPath + " (removed - old copy kept as " + BACKUP_TAG + ")");
    applied++;
  } catch (err) {
    console.log("X " + repoPath + " FAILED to remove: " + err.message);
    warnings++;
  }
}
writeNewRepair("mobile/src/lib/notify.ts", "\u00a7279b", false,
    "/**\n * \u00a7279b P4 notifications (device side) - LAZY and fail-soft.\n *\n * expo-notifications is imported dynamically: on runtimes where its native\n * module is missing (Expo Go dropped remote push in SDK 53+; older Expo Go\n * clients throw `Cannot find native module 'ExpoTopicSubscriptionModule'`\n * at import time), a top-level import would poison the whole route tree.\n * Lazy loading degrades alerts to \"off\" while every screen keeps working.\n *\n * Strategy per the locked decision \"safe smart polling + push\":\n *  - foreground handler shows banners with the user's sound preference;\n *  - inbox polling diffs unread counts and fires a LOCAL notification when\n *    the app is backgrounded (no push infra needed);\n *  - tapping a notification deep-links into the exact conversation;\n *  - Expo Push token registration fails soft until an EAS project id exists.\n */\n\nimport { AppState, Platform } from \"react-native\";\nimport {\n  CHANNEL_ID,\n  buildNotificationBody,\n  notificationDataSchema,\n} from \"@/lib/notifyCore\";\nimport { useSettingsStore } from \"@/store/settings\";\nimport { logger } from \"@/lib/logger\";\n\ntype NotificationsModule = typeof import(\"expo-notifications\");\n\n// undefined = not attempted yet; null = unavailable on this runtime\nlet cached: NotificationsModule | null | undefined;\n\nasync function loadNotifications(): Promise<NotificationsModule | null> {\n  if (cached !== undefined) return cached;\n  try {\n    cached = await import(\"expo-notifications\");\n  } catch (err) {\n    logger.warn(\"expo-notifications unavailable - alerts disabled\", err);\n    cached = null;\n  }\n  return cached;\n}\n\ntype Navigator = (href: string) => void;\n\nlet navigator: Navigator | null = null;\n\n/** Wired by the root layout once expo-router is mounted. */\nexport function setNotificationNavigator(fn: Navigator | null): void {\n  navigator = fn;\n}\n\nexport async function initNotifications(): Promise<void> {\n  try {\n    const N = await loadNotifications();\n    if (!N) return;\n\n    N.setNotificationHandler({\n      handleNotification: async () => ({\n        shouldShowBanner: true,\n        shouldShowList: true,\n        shouldPlaySound: useSettingsStore.getState().prefs.sounds,\n        shouldSetBadge: true,\n      }),\n    });\n\n    if (Platform.OS === \"android\") {\n      await N.setNotificationChannelAsync(CHANNEL_ID, {\n        name: \"Inbox alerts\",\n        importance: N.AndroidImportance.HIGH,\n        sound: \"default\",\n        vibrationPattern: [0, 250, 250, 250],\n        lightColor: \"#4f46e5\",\n      });\n    }\n\n    const status = await N.getPermissionsAsync();\n    if (!status.granted) {\n      const asked = await N.requestPermissionsAsync();\n      if (!asked.granted) logger.warn(\"notification permission denied\");\n    }\n\n    N.addNotificationResponseReceivedListener((response) => {\n      const data = notificationDataSchema.parse(\n        response.notification.request.content.data ?? {},\n      );\n      if (!navigator) return;\n      if (data.conversationId) navigator(`/conversation/${data.conversationId}`);\n      else if (data.tab) navigator(`/${data.tab}`);\n      else navigator(\"/inbox\");\n    });\n  } catch (err) {\n    logger.warn(\"notifications init failed soft\", err);\n  }\n}\n\n/**\n * Fires a local notification for newly arrived messages - only while the\n * app is NOT in the foreground (in-app the badge + list update is enough)\n * and only when the user enabled alerts and the runtime supports them.\n */\nexport async function notifyNewMessages(\n  preview: string,\n  count: number,\n  conversationId?: number | string | null,\n): Promise<void> {\n  try {\n    const { prefs } = useSettingsStore.getState();\n    if (!prefs.notifications) return;\n    if (AppState.currentState === \"active\") return;\n    const N = await loadNotifications();\n    if (!N) return;\n    const { title, body } = buildNotificationBody(preview, count);\n    await N.scheduleNotificationAsync({\n      content: {\n        title,\n        body,\n        sound: prefs.sounds ? \"default\" : undefined,\n        data: { conversationId: conversationId ?? null, tab: \"inbox\" },\n      },\n      trigger: null, // deliver immediately\n    });\n  } catch (err) {\n    logger.warn(\"local notification failed soft\", err);\n  }\n}\n\n/** Expo Push token - null until an EAS project id exists (fail soft). */\nexport async function registerForPush(): Promise<string | null> {\n  try {\n    const N = await loadNotifications();\n    if (!N) return null;\n    const token = await N.getExpoPushTokenAsync();\n    return token.data || null;\n  } catch {\n    return null;\n  }\n}\n");
writeNewRepair("mobile/src/lib/haptics.ts", "\u00a7279b", false,
    "/**\n * \u00a7279b P4 haptics - lazy, guarded wrapper around expo-haptics. Dynamic\n * import keeps runtimes without the native module alive (same fail-soft\n * law as notify.ts); every call respects the user's preference and never\n * throws. Haptics are cosmetic - the app must never depend on them.\n */\n\nimport { useSettingsStore } from \"@/store/settings\";\n\ntype HapticsModule = typeof import(\"expo-haptics\");\n\nlet cached: HapticsModule | null | undefined;\n\nasync function loadHaptics(): Promise<HapticsModule | null> {\n  if (cached !== undefined) return cached;\n  try {\n    cached = await import(\"expo-haptics\");\n  } catch {\n    cached = null;\n  }\n  return cached;\n}\n\nasync function guarded(run: (H: HapticsModule) => Promise<void>): Promise<void> {\n  if (!useSettingsStore.getState().prefs.haptics) return;\n  try {\n    const H = await loadHaptics();\n    if (H) await run(H);\n  } catch {\n    // unsupported platform / permission - haptics are cosmetic, fail soft\n  }\n}\n\nexport const haptics = {\n  tap: () => guarded((H) => H.impactAsync(H.ImpactFeedbackStyle.Light)),\n  success: () =>\n    guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Success)),\n  warning: () =>\n    guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Warning)),\n  error: () => guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Error)),\n  selection: () => guarded((H) => H.selectionAsync()),\n};\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then:");
console.log("  cd mobile");
console.log("  npm start  -> Expo Go reload -> app must boot clean now.");
console.log("  Update the Expo Go app from the Play Store for local-notification support.");
console.log("  Background the app -> send a WhatsApp message -> local alert -> tap -> thread.");