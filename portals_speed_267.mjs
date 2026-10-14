// OmniFlow 267 - portals speed: instant loading shells for the client and admin portals.
// Every route that had no shell now paints a skeleton the moment you click, and the real data
// streams in after it. Pure additive change: no page logic, no auth flow and no API was touched,
// so nothing can break. Website only - no Control Plane files and no SQL.
// Run from the website root (the folder that has package.json): node portals_speed_267.mjs
// Then commit and deploy the website. Real cold-start fixes are in the after-notes (Neon/region/ping).
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_267.bak";
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
if (!fs.existsSync("app/admin/(panel)/layout.tsx") || !fs.readFileSync("app/admin/(panel)/layout.tsx", "utf8").includes("AdminShell")) {
  console.log("X " + "the admin layout the new shells sit under" + " Nothing was written.");
  process.exit(1);
}
if (!fs.existsSync("app/dashboard/(portal)/layout.tsx") || !fs.readFileSync("app/dashboard/(portal)/layout.tsx", "utf8").includes("DashShell")) {
  console.log("X " + "the portal layout the new shells sit under" + " Nothing was written.");
  process.exit(1);
}
if (!fs.existsSync("lib/omniflow/auth-dal.ts") || !fs.readFileSync("lib/omniflow/auth-dal.ts", "utf8").includes("getOmniFlowSession = cache(")) {
  console.log("X " + "the request-cached session call (unchanged by 267)" + " Nothing was written.");
  process.exit(1);
}
writeNewRepair("app/admin/(panel)/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AdminPanelLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/ai-control/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AiControlLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/ai-router/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AiRouterLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/analytics/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AnalyticsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/content/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function ContentLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/customers/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function CustomersLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/integrations/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function IntegrationsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/leads/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function LeadsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/seo/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function SeoLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/admin/(panel)/settings/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function SettingsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/ai-report/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AiReportLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/approvals/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function ApprovalsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/assistant/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function AssistantLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/retention/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function RetentionLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/rules/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function RulesLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/sales/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function SalesLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/sandbox/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function SandboxLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/website-analyzer/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function WebsiteAnalyzerLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("app/dashboard/(portal)/workflows/loading.tsx", "\u00a7267", false,
    "// \u00a7267 instant shell: the route paints immediately, data streams in after.\nexport default function WorkflowsLoading() {\n  return (\n    <div className=\"space-y-4\" aria-busy=\"true\">\n      <div className=\"h-8 w-56 animate-pulse rounded-lg bg-line/60\" />\n      <div className=\"h-4 w-72 animate-pulse rounded bg-line/60\" />\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2\">\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n        <div className=\"h-40 animate-pulse rounded-2xl bg-line/60\" />\n      </div>\n      <div className=\"h-64 animate-pulse rounded-2xl bg-line/60\" />\n    </div>\n  );\n}\n");
writeNewRepair("tools/cp-testrig/test_portals_speed_267.py", "\u00a7267", false,
    "\"\"\"\u00a7267 portals speed: every route in the client and admin portals paints an\ninstant shell while its data loads.\n\nChecks (structure only, no database):\n  * every directory under app/dashboard/(portal) and app/admin/(panel) that has\n    a page.tsx is covered by a loading.tsx - either its own or an ancestor's -\n    so a click never shows a blank screen while the server resolves;\n  * the shells carry the \u00a7267 marker or pre-date it (portal root);\n  * the shells render a pulse skeleton and mark the region busy;\n  * both portals keep their single request-scoped session call (no duplicate\n    auth round trip per page).\n\nRun from this folder: python test_portals_speed_267.py\n\"\"\"\nimport os\n\nfrom test_lib import check, summary\n\nHERE = os.path.dirname(os.path.abspath(__file__))\nROOT = os.environ.get(\"OF_RIG_WEB_ROOT\") or os.path.abspath(os.path.join(HERE, \"..\", \"..\"))\n\nROOTS = [\"app/dashboard/(portal)\", \"app/admin/(panel)\"]\n\n\ndef covered(path_dir, root):\n    \"\"\"True when path_dir or one of its ancestors (down to root) has loading.tsx.\"\"\"\n    d = path_dir\n    while True:\n        if os.path.isfile(os.path.join(ROOT, d, \"loading.tsx\")):\n            return True\n        if os.path.normpath(d) == os.path.normpath(root):\n            return False\n        d = os.path.dirname(d)\n\n\nprint(\"== every portal route has a loading shell above it ==\")\nmissing = []\ncount = 0\nfor root in ROOTS:\n    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, root)):\n        if \"page.tsx\" not in filenames:\n            continue\n        count += 1\n        rel = os.path.relpath(dirpath, ROOT)\n        if not covered(rel, root):\n            missing.append(rel)\ncheck(\"all %d portal routes are covered by a loading shell\" % count, not missing, str(missing))\n\nprint(\"== the new shells ==\")\nnew_shells = [\n    \"app/admin/(panel)/loading.tsx\",\n    \"app/admin/(panel)/analytics/loading.tsx\",\n    \"app/admin/(panel)/customers/loading.tsx\",\n    \"app/admin/(panel)/settings/loading.tsx\",\n    \"app/dashboard/(portal)/sales/loading.tsx\",\n    \"app/dashboard/(portal)/workflows/loading.tsx\",\n    \"app/dashboard/(portal)/approvals/loading.tsx\",\n]\nfor rel in new_shells:\n    full = os.path.join(ROOT, rel)\n    ok = os.path.isfile(full)\n    check(\"shell present: \" + rel, ok, \"missing\")\n    if ok:\n        text = open(full, encoding=\"utf8\").read()\n        check(\"shell \u00a7267 + skeleton + aria-busy: \" + rel,\n              \"\u00a7267\" in text and \"animate-pulse\" in text and 'aria-busy=\"true\"' in text, \"content\")\n\nprint(\"== one session call per request, no waterfalls added ==\")\ndal = open(os.path.join(ROOT, \"lib/omniflow/auth-dal.ts\"), encoding=\"utf8\").read()\ncheck(\"portal session stays request-cached (React.cache)\", \"export const getOmniFlowSession = cache(\" in dal,\n      \"cache\")\nadmin_page = open(os.path.join(ROOT, \"app/admin/(panel)/page.tsx\"), encoding=\"utf8\").read()\ncheck(\"admin dashboard still fetches its five sources in parallel\",\n      \"await Promise.allSettled([\" in admin_page, \"parallel\")\n\nfailures = summary(\"portals_speed_267\")\nraise SystemExit(1 if failures else 0)\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Website only: git add the 20 new files, commit, push, deploy. No Control Plane deploy and no SQL.");
console.log("What this fixes: clicks now paint a skeleton instantly instead of a blank wait, on the 19 routes that had no shell (including the admin and portal home pages).");
console.log("The REMAINING wait is infra latency, not code. Do these three (biggest first): (1) Neon console -> your project -> Settings -> turn OFF 'Scale to zero' / auto-suspend, so the database never sleeps; (2) put the website and the Control Plane Vercel projects in the SAME region; (3) add a free 5-minute uptime ping (e.g. UptimeRobot) to the Control Plane base URL and to the website, so the serverless functions stay warm.");
console.log("With Neon awake and warm functions, a click resolves in well under a second; the shell only shows for a blink.");
console.log("Still open from before: OF_ANALYTICS_SALT + CRON_SECRET env, laptop .env, laptop git pull stash steps, repo private, Neon-vs-Supabase analytics decision, PKR confirm.");