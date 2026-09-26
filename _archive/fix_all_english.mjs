// fix_all_english.mjs — final professional-English sweep across all three
// locations: Omniflow website, OmniFlow-Control-Plane backend, and the laptop
// connector modules (docstrings). Run from the bot ROOT (the folder that
// contains the Omniflow/, OmniFlow-Control-Plane/ and src/ folders):
//
//   cd /d "C:\Users\Ahmed Ansari\Desktop\whatsapp-ai-bot"
//   node fix_all_english.mjs
//
// CRLF-tolerant, idempotent, backups: *.pre_eng2.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TARGETS = [
  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/app/admin/(panel)/leads/LeadsTable.tsx",
    swaps: [
      {
        name: "lead temp-password note",
        from: `                    ⚠ Ye password dobara nahi dikhega — abhi copy kar ke client
                    ko securely bhej dein.`,
        to: `                    ⚠ This password will not be shown again — copy it now and
                    share it securely with the client.`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/[id]/route.ts",
    swaps: [
      {
        name: "conversation not found",
        from: `"Conversation nahi mili."`,
        to: `"Conversation not found."`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/profile/ProfileForm.tsx",
    swaps: [
      {
        name: "About placeholder",
        from: `placeholder="Aik line me apna business batayein"`,
        to: `placeholder="Describe your business in one line"`,
      },
      {
        name: "Products label",
        from: `Products &amp; prices (har line: item — price)`,
        to: `Products &amp; prices (one item per line: item — price)`,
      },
      {
        name: "Policies placeholder",
        from: `placeholder={"7 din return warranty\\nLahore me free delivery"}`,
        to: `placeholder={"7-day return warranty\\nFree delivery in Lahore"}`,
      },
      {
        name: "FAQs label",
        from: `FAQs (har line: sawal? — jawab)`,
        to: `FAQs (one per line: question? — answer)`,
      },
      {
        name: "FAQs placeholder",
        from: `placeholder={"Delivery kitne din me hoti hai? — 2 se 3 din\\nPayment method? — Cash on delivery ya bank transfer"}`,
        to: `placeholder={"How long does delivery take? — 2 to 3 days\\nPayment methods? — Cash on delivery or bank transfer"}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/channels/whatsapp/page.tsx",
    swaps: [
      {
        name: "runAction type gains restart",
        from: `  async function runAction(action: "connect" | "disconnect") {`,
        to: `  async function runAction(action: "connect" | "disconnect" | "restart") {`,
      },
      {
        name: "Restart session button",
        from: `                {busy ? "Working…" : "Disconnect"}
              </button>
            ) : (`,
        to: `                {busy ? "Working…" : "Disconnect"}
              </button>
              <button
                onClick={() => void runAction("restart")}
                disabled={busy}
                className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Working…" : "Restart session"}
              </button>
            ) : (`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/channels/whatsapp/route.ts",
    swaps: [
      {
        name: "BFF allows restart",
        from: `const ACTIONS: ReadonlySet<string> = new Set(["connect", "disconnect"]);`,
        to: `const ACTIONS: ReadonlySet<string> = new Set([
  "connect",
  "disconnect",
  "restart",
]);`,
      },
    ],
  },

  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/auth_password_reset.py",
    swaps: [
      {
        name: "reset email body",
        from: `            "Ye code " + str(CODE_TTL_MINUTES) + " minutes ke liye valid hai.\\n"
            "Agar aapne ye request nahi ki, is email ko ignore karein."`,
        to: `            "This code is valid for " + str(CODE_TTL_MINUTES) + " minutes.\\n"
            "If you did not request this, you can safely ignore this email."`,
      },
      { name: "email required", from: `"Email zaroori hai."`, to: `"Email is required."` },
      { name: "code required", from: `"Reset code zaroori hai."`, to: `"Reset code is required."` },
      {
        name: "password minimum",
        from: `"Password kam az kam 8 characters ka ho."`,
        to: `"Password must be at least 8 characters."`,
      },
      {
        name: "code invalid",
        from: `"Code galat hai. Dobara check karein."`,
        to: `"Invalid code. Please check it and try again."`,
      },
      {
        name: "code expired",
        from: `"Code expire ho gaya. Naya code mangwayein."`,
        to: `"This code has expired. Please request a new one."`,
      },
      {
        name: "too many attempts",
        from: `"Bohat zyada koshishen. Naya code mangwayein."`,
        to: `"Too many attempts. Please request a new code."`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "module docstring",
        from: `Ye endpoints customer ke apne device (home laptop) par chalne wale connector
ke liye hain — server par WhatsApp session KABHI nahi chalta. Auth:
X-Omniflow-Key header = OMNIFLOW_SERVICE_KEY ya OMNIFLOW_ADMIN_API_KEY
(wahi proven pattern jo admin endpoints use karte hain).

Connector ka tenant resolve hota hai (pehla match jeeta):
  1. Request body/query me explicit \`client_id\`
  2. Backend env OMNIFLOW_CONNECTOR_USER_EMAIL -> platform_users lookup`,
        to: `These endpoints serve the connector that runs on the customer's own device
(home laptop) — the WhatsApp session NEVER runs on the server. Auth:
X-Omniflow-Key header = OMNIFLOW_SERVICE_KEY or OMNIFLOW_ADMIN_API_KEY
(the same proven pattern used by the admin endpoints).

The connector's tenant is resolved as follows (first match wins):
  1. Explicit \`client_id\` in the request body/query
  2. Backend env OMNIFLOW_CONNECTOR_USER_EMAIL -> platform_users lookup`,
      },
      {
        name: "tenant resolve error",
        from: `"Connector tenant resolve nahi hua: body/query me client_id bhejein "
                "ya backend par OMNIFLOW_CONNECTOR_USER_EMAIL set karein."`,
        to: `"Connector tenant could not be resolved: send client_id in the "
                "body/query, or set OMNIFLOW_CONNECTOR_USER_EMAIL on the backend."`,
      },
      {
        name: "status state validation",
        from: `"state disconnected|connecting|connected hon."`,
        to: `"state must be disconnected, connecting, or connected."`,
      },
      {
        name: "command id required",
        from: `"command_id (positive int) zaroori hai."`,
        to: `"command_id (a positive int) is required."`,
      },
      { name: "command not found", from: `"Command nahi mili."`, to: `"Command not found."` },
      {
        name: "messages required",
        from: `"messages (non-empty list) zaroori hai."`,
        to: `"messages (a non-empty list) is required."`,
      },
      {
        name: "max messages per request",
        from: `"message": "Aik request me max "
                                             + str(MAX_INGEST_MESSAGES)
                                             + " messages bhejein."}}), 400`,
        to: `"message": "Send at most "
                                             + str(MAX_INGEST_MESSAGES)
                                             + " messages per request."}}), 400`,
      },
      {
        name: "message object validation",
        from: `"Har message aik object ho."`,
        to: `"Each message must be an object."`,
      },
      {
        name: "message from required",
        from: `"Har message me 'from' zaroori hai."`,
        to: `"Each message requires a 'from' field."`,
      },
      {
        name: "direction validation",
        from: `"direction in|out hon."`,
        to: `"direction must be 'in' or 'out'."`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_bot.py",
    swaps: [
      {
        name: "agent name validation",
        from: `"Agent name 1-64 characters ka hona chahiye."`,
        to: `"Agent name must be 1-64 characters."`,
      },
      {
        name: "tone validation",
        from: `"Tone friendly, professional ya concise ho sakta hai."`,
        to: `"Tone must be friendly, professional, or concise."`,
      },
      {
        name: "greeting/fallback validation",
        from: `"Greeting/fallback 2000 characters se chhote rakhein."`,
        to: `"Greeting and fallback must be under 2000 characters."`,
      },
      {
        name: "working hours format",
        from: `"Working hours HH:MM format me hon (jaise 09:00)."`,
        to: `"Working hours must use the HH:MM format (for example 09:00)."`,
      },
      {
        name: "working hours order",
        from: `"Working hours ka start end se pehle hona chahiye."`,
        to: `"Working hours start must be earlier than the end."`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "status filter validation",
        from: `"status all|open|closed hon."`,
        to: `"status must be all, open, or closed."`,
      },
      {
        name: "conversation not found",
        from: `"Conversation nahi mili."`,
        to: `"Conversation not found."`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_profile.py",
    swaps: [
      {
        name: "profile object required",
        from: `"profile object zaroori hai."`,
        to: `"The profile object is required."`,
      },
      {
        name: "profile serializable",
        from: `"Profile JSON serializable nahi hai."`,
        to: `"Profile must be JSON-serializable."`,
      },
      {
        name: "profile size limit",
        from: `"Profile 32KB se bara nahi ho sakta."`,
        to: `"Profile cannot exceed 32KB."`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_channels.py",
    swaps: [
      {
        name: "ALLOWED_ACTIONS gains restart",
        from: `ALLOWED_ACTIONS = ("connect", "disconnect")`,
        to: `ALLOWED_ACTIONS = ("connect", "disconnect", "restart")`,
      },
      {
        name: "restart queued message",
        from: `        if action == "connect"
        else "Disconnect request queued — your connector will log the account out."`,
        to: `        if action == "connect"
        else (
            "Restart request queued — your connector will refresh the session."
            if action == "restart"
            else "Disconnect request queued — your connector will log the account out."
        )`,
      },
    ],
  },

  // ---------------------------------------------------------- laptop modules
  {
    file: "src/portal_agent_config.py",
    swaps: [
      {
        name: "module docstring",
        from: `"""Portal "AI agents" page ka live mirror — laptop bot ke liye.

Background daemon thread har 60s Control Plane se agent config fetch karta hai:
  GET /api/v1/connector/bot?client_id=1   (X-Omniflow-Key)
Response (flat): {agent_name, tone, greeting, fallback, working_hours_*,
human_handoff_enabled, updated_at}

get_config() kabhi block nahi karta — hamesha aakhri known config (ya defaults).
Network fail ho to chupchaap previous config chalti rehti hai (bot kabhi nahi rukta).

Env (same as bridge): OMNIFLOW_SERVICE_KEY, OMNIFLOW_CP_BASE_URL,
OMNIFLOW_CLIENT_ID, OMNIFLOW_AGENT_CONFIG_SECONDS (refresh interval).
"""`,
        to: `"""Live mirror of the portal "Configure AI" page — drives the laptop bot.

A background daemon thread fetches the agent config from the Control Plane
every 60 seconds:
  GET /api/v1/connector/bot?client_id=1   (X-Omniflow-Key)
Response (flat): {agent_name, tone, greeting, fallback, working_hours_*,
human_handoff_enabled, updated_at}

get_config() never blocks — it always returns the last known config (or
defaults). If the network fails, the previous config keeps running (the bot
never stops).

Env (same as bridge): OMNIFLOW_SERVICE_KEY, OMNIFLOW_CP_BASE_URL,
OMNIFLOW_CLIENT_ID, OMNIFLOW_AGENT_CONFIG_SECONDS (refresh interval).
"""`,
      },
      {
        name: "build_directives docstring",
        from: `"""System prompt ke liye portal-driven instructions (string)."""`,
        to: `"""Builds the portal-driven system-prompt instructions (string)."""`,
      },
      // Safety net: if any of the earlier prompt-string fixes were missed,
      // apply them now (they are already English on this laptop, so these
      // report "already fine" in most cases).
      {
        name: "tone prompt line",
        from: `"Warm, friendly and casual — jaise dost se baat."`,
        to: `"Warm, friendly and casual."`,
      },
      {
        name: "greeting prompt line",
        from: `"fallback message (aap isay apne alfaaz me thoda adjust kar sakte ho): "`,
        to: `"fallback message (you may rephrase it slightly in your own words): "`,
      },
      {
        name: "handoff prompt line 1",
        from: `"Human handoff is ON: agar customer insaan se baat karna chahe ya "`,
        to: `"Human handoff is ON: if the customer asks for a human agent or the "`,
      },
      {
        name: "handoff prompt line 2",
        from: `"masla hal na ho, batao ke 'hamari team jald rabta karegi' — argument "`,
        to: `"issue cannot be resolved, politely say the team will follow up — "`,
      },
      { name: "handoff prompt line 3", from: `"mat karo."`, to: `"do not argue."` },
    ],
  },
  {
    file: "src/portal_business_profile.py",
    swaps: [
      {
        name: "module docstring",
        from: `"""Portal "Business profile" ka live mirror — bot ke jawabat isi se.

Background thread har 120s fetch karta hai:
  GET /api/v1/connector/profile?client_id=1   (X-Omniflow-Key)
  -> {profile: {...free-form JSON...}, updated_at}

build_business_directives() system prompt me jaata hai — business name,
products, prices, policies, FAQs. Profile khali ho to "" (kuch inject nahi).
Network fail -> previous profile chalti rehti hai.

Env: OMNIFLOW_SERVICE_KEY, OMNIFLOW_CP_BASE_URL, OMNIFLOW_CLIENT_ID,
OMNIFLOW_PROFILE_SECONDS (refresh interval, default 120).
"""`,
        to: `"""Live mirror of the portal "Business profile" page — the bot answers
from this data.

A background thread fetches the profile every 120 seconds:
  GET /api/v1/connector/profile?client_id=1   (X-Omniflow-Key)
  -> {profile: {...free-form JSON...}, updated_at}

build_business_directives() goes into the system prompt — business name,
products, prices, policies, FAQs. When the profile is empty it returns ""
(nothing is injected). On network failure the previous profile keeps running.

Env: OMNIFLOW_SERVICE_KEY, OMNIFLOW_CP_BASE_URL, OMNIFLOW_CLIENT_ID,
OMNIFLOW_PROFILE_SECONDS (refresh interval, default 120).
"""`,
      },
      {
        name: "build_business_directives docstring",
        from: `"""System prompt ke liye business-profile section (ya "")."""`,
        to: `"""Builds the business-profile system-prompt section (or "")."""`,
      },
      {
        name: "profile prompt intro",
        from: `"BUSINESS PROFILE (owner ne yeh information di hai — customer ke "`,
        to: `"BUSINESS PROFILE (provided by the owner — answer customer questions "`,
      },
      {
        name: "profile prompt line 2",
        from: `"sawalat ke jawabat pehle isi se do; jo yahan nahi hai woh ghumao "`,
        to: `"from this information first; if something is not covered here, say "`,
      },
      {
        name: "profile prompt line 3",
        from: `"mat, saaf mana kar do):"`,
        to: `"you will check with the team. Never invent information):"`,
      },
      {
        name: "profile prompt footer",
        from: `"- (aur bhi information maujood hai — zaroorat par "
                "owner se poochna)"`,
        to: `"- (more information is available — check with the owner "
                "when needed)"`,
      },
    ],
  },
  {
    file: "src/control_plane_bridge.py",
    swaps: [
      {
        name: "docstring failure line",
        from: `failure-tolerant: bridge kabhi bot loop ko nahi girata.`,
        to: `failure-tolerant: the bridge never crashes the bot loop.`,
      },
      {
        name: "service key error message",
        from: `"OMNIFLOW_SERVICE_KEY .env me nahi mila — "
                "oflow_service_key.txt ki value .env me daalo"`,
        to: `"OMNIFLOW_SERVICE_KEY not found in .env — "
                "put the value from oflow_service_key.txt into .env"`,
      },
      {
        name: "docstring service key line",
        from: `  OMNIFLOW_SERVICE_KEY          (zaroori — oflow_service_key.txt wali value)`,
        to: `  OMNIFLOW_SERVICE_KEY          (required — the value stored in oflow_service_key.txt)`,
      },
    ],
  },
];

const LEFTOVER_RE =
  /(karein|zaroori|nahi|mila|mili|galat|chahiye|dobara|bheje?in|rakhein|ghumao|koshishen|mangwayein|waghera|kam az kam|ho gaya|ke liye|jaise |ho sakta|kabhi)/i;

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (fromCount === 0 && toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already fully in English)");
    continue;
  }

  const backup = target.file + ".pre_eng2.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    // Compile gate: write patched text to the real file, byte-compile,
    // restore the backup on any failure.
    fs.writeFileSync(target.file, text, "utf8");
    let ok = false;
    for (const py of ["python", "python3"]) {
      try {
        execFileSync(py, ["-m", "py_compile", target.file], { stdio: "pipe" });
        ok = true;
        break;
      } catch {
        /* try next interpreter */
      }
    }
    if (!ok) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

// Final leftover scan across every target file.
console.log("");
console.log("Leftover scan:");
let leftovers = 0;
for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) continue;
  const lines = fs.readFileSync(target.file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (LEFTOVER_RE.test(line)) {
      leftovers++;
      console.log("  REVIEW " + target.file + ":" + (i + 1) + " -> " + line.trim().slice(0, 90));
    }
  });
}
if (leftovers === 0) console.log("  CLEAN — no Roman Urdu markers remain.");

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " replaced, " +
    alreadyTotal +
    " already English, " +
    warnTotal +
    " warnings, " +
    leftovers +
    " review lines"
);