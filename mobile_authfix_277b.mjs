// §277b: client login hotfix - CP /me payloads without `id` no longer break
// session hydrate (ZodError loop); display_name/business mapped to the UI.
// Run from the repo root AFTER mobile_p2_277.mjs:
//   node mobile_authfix_277b.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_277b.bak";
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
writeNewRepair("mobile/src/api/auth.ts", "\u00a7277b", false,
    "/**\n * Client-auth endpoints of the existing Control Plane, reused as-is by the\n * mobile Client app (the web portal uses the same routes via\n * lib/omniflow/control-plane.ts). Admin auth is the CP's Neon-backed\n * mobile-admin login and lives in src/api/admin.ts (\u00a7275).\n */\n\nimport { z } from \"zod\";\nimport { api } from \"@/api/client\";\n\nexport const loginInputSchema = z.object({\n  email: z.string().trim().min(3, \"Enter your email\").email(\"Enter a valid email\"),\n  password: z.string().min(8, \"Password must be at least 8 characters\"),\n});\nexport type LoginInput = z.infer<typeof loginInputSchema>;\n\nexport const tokenPairSchema = z.object({\n  access_token: z.string().min(1),\n  refresh_token: z.string().min(1),\n  expires_in: z.number().int().positive().optional(),\n});\nexport type TokenPair = z.infer<typeof tokenPairSchema>;\n\nexport const sessionUserSchema = z.object({\n  // \u00a7277b fail-soft: the live CP /me payload can omit `id` entirely - a\n  // missing id must never break session hydrate (ZodError loop on login).\n  id: z\n    .union([z.string(), z.number()])\n    .nullish()\n    .transform((v) => v ?? \"\")\n    .catch(\"\"),\n  email: z.string().optional(),\n  name: z.string().optional(),\n  role: z.string().optional(),\n  business_name: z.string().optional(),\n});\nexport type SessionUser = z.infer<typeof sessionUserSchema>;\n\nexport async function login(input: LoginInput): Promise<TokenPair> {\n  const data = await api.post<unknown>(\"/api/v1/auth/login\", input, {\n    auth: false,\n  });\n  return tokenPairSchema.parse(data);\n}\n\nexport async function refresh(refreshToken: string): Promise<TokenPair> {\n  const data = await api.post<unknown>(\n    \"/api/v1/auth/refresh\",\n    { refresh_token: refreshToken },\n    { auth: false, retries: 1 },\n  );\n  return tokenPairSchema.parse(data);\n}\n\nexport async function fetchSession(): Promise<SessionUser> {\n  const data = await api.get<unknown>(\"/api/v1/auth/me\");\n  const obj = (data ?? {}) as Record<string, unknown>;\n  const candidate =\n    obj && typeof obj.user === \"object\" && obj.user !== null\n      ? (obj.user as Record<string, unknown>)\n      : obj;\n  // \u00a7277b: CP portal sessions expose display_name / business rather than\n  // name / business_name - map them so the UI shows a friendly greeting.\n  const mapped: Record<string, unknown> = { ...candidate };\n  if (mapped.name == null && typeof mapped.display_name === \"string\") {\n    mapped.name = mapped.display_name;\n  }\n  if (mapped.business_name == null && typeof mapped.business === \"string\") {\n    mapped.business_name = mapped.business;\n  }\n  return sessionUserSchema.parse(mapped);\n}\n\nexport async function logoutCall(): Promise<void> {\n  try {\n    await api.post<void>(\"/api/v1/auth/logout\", undefined, { retries: 0 });\n  } catch {\n    // fail-soft: local sign-out always succeeds\n  }\n}\n\nexport async function forgotPassword(email: string): Promise<void> {\n  await api.post<void>(\"/api/v1/auth/forgot-password\", { email }, { auth: false });\n}\n");
writeNewRepair("mobile/tests/schemas.test.ts", "\u00a7277b", false,
    "import {\n  loginInputSchema,\n  sessionUserSchema,\n  tokenPairSchema,\n} from \"@/api/auth\";\nimport { compareVersions, mobileConfigSchema } from \"@/store/app\";\n\ndescribe(\"validation schemas\", () => {\n  it(\"accepts a valid login\", () => {\n    const parsed = loginInputSchema.safeParse({\n      email: \"owner@omniflow.pk\",\n      password: \"longenough1\",\n    });\n    expect(parsed.success).toBe(true);\n  });\n\n  it(\"rejects weak logins\", () => {\n    expect(loginInputSchema.safeParse({ email: \"x\", password: \"123\" }).success).toBe(false);\n    expect(loginInputSchema.safeParse({ email: \"a@b.co\", password: \"short\" }).success).toBe(false);\n  });\n\n  it(\"parses token pairs and sessions\", () => {\n    expect(\n      tokenPairSchema.safeParse({ access_token: \"a\", refresh_token: \"b\" }).success,\n    ).toBe(true);\n    expect(tokenPairSchema.safeParse({ access_token: \"a\" }).success).toBe(false);\n    expect(\n      sessionUserSchema.safeParse({ id: \"u1\", email: \"a@b.co\", role: \"owner\" }).success,\n    ).toBe(true);\n  });\n\n  it(\"\u00a7277b: tolerates a CP /me payload without id\", () => {\n    const parsed = sessionUserSchema.safeParse({ email: \"a@b.co\", display_name: \"A\" });\n    expect(parsed.success).toBe(true);\n    if (parsed.success) expect(parsed.data.id).toBe(\"\");\n  });\n\n  it(\"parses remote config tolerantly\", () => {\n    const parsed = mobileConfigSchema.safeParse({\n      min_version: \"0.2.0\",\n      maintenance: false,\n      flags: { inbox: true },\n    });\n    expect(parsed.success).toBe(true);\n  });\n\n  it(\"compares semantic versions\", () => {\n    expect(compareVersions(\"1.2.3\", \"1.2.3\")).toBe(0);\n    expect(compareVersions(\"1.2.3\", \"1.10.0\")).toBe(-1);\n    expect(compareVersions(\"2.0.0\", \"1.9.9\")).toBe(1);\n    expect(compareVersions(\"junk\", \"1.0.0\")).toBe(0);\n  });\n});\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then:");
console.log("  cd mobile");
console.log("  npm run typecheck && npm test   (expect 0 errors, 29 passed)");
console.log("  set OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app");
console.log("  npm start  -> Expo Go reload -> login with the CP PORTAL account");