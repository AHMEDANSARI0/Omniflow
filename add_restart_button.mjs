// add_restart_button.mjs — WhatsApp setup page par Restart button
// (portal -> command queue -> laptop bridge adapter stop/start).
// Omniflow repo ROOT me chalao:  node add_restart_button.mjs
// CRLF-tolerant, backups: *.pre_rst.bak, idempotent.

import fs from "node:fs";

const PAGE = "app/dashboard/(portal)/channels/whatsapp/page.tsx";
const BFF = "app/api/omniflow/portal/channels/whatsapp/route.ts";
const BACKEND = "../OmniFlow-Control-Plane/portal_channels.py";

let touched = 0;

function patch(path, edits, name) {
  if (!fs.existsSync(path)) {
    console.log("  SKIP (nahi mila): " + path);
    return;
  }
  let text = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  let changed = false;

  for (const [oldStr, newStr] of edits) {
    const count = text.split(oldStr).length - 1;
    if (count === 0) continue;
    text = text.split(oldStr).join(newStr);
    changed = true;
  }

  if (!changed) {
    console.log("  = " + name + " (pehle se theek)");
    return;
  }
  fs.copyFileSync(path, path + ".pre_rst.bak");
  fs.writeFileSync(path, text, "utf8");
  touched++;
  console.log("  + " + name);
}

// 1) Website page: Restart button (connected state me Disconnect ke saath)
patch(PAGE, [
  [
    '                {busy ? "Working…" : "Disconnect"}\n              </button>',
    '                {busy ? "Working…" : "Disconnect"}\n              </button>\n              <button\n                onClick={() => void runAction("restart")}\n                disabled={busy}\n                className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"\n              >\n                {busy ? "Working…" : "Restart session"}\n              </button>',
  ],
  [
    '  async function runAction(action: "connect" | "disconnect") {',
    '  async function runAction(action: "connect" | "disconnect" | "restart") {',
  ],
], "channels/whatsapp/page.tsx");

// 2) BFF: restart action allow
patch(BFF, [
  [
    'new Set(["connect", "disconnect"])',
    'new Set(["connect", "disconnect", "restart"])',
  ],
], "api/channels/whatsapp/route.ts");

// 3) Backend: ALLOWED_ACTIONS me restart
patch(BACKEND, [
  [
    'ALLOWED_ACTIONS = ("connect", "disconnect")',
    'ALLOWED_ACTIONS = ("connect", "disconnect", "restart")',
  ],
  [
    '        if action == "connect"\n                            else "Disconnect request queued — your connector will log the account out."',
    '        if action == "connect"\n                            else (\n            "Restart request queued — your connector will refresh the session."\n            if action == "restart"\n            else "Disconnect request queued — your connector will log the account out."\n        )',
  ],
], "backend portal_channels.py");

console.log("");
if (touched > 0) {
  console.log("SUCCESS! Ab dono repos commit + push karo (neeche wale block me).");
} else {
  console.log("Kuch nahi badla — sab pehle se theek tha.");
}