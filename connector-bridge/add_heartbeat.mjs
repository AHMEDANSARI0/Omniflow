// add_heartbeat.mjs — control_plane_bridge.py me 60s status heartbeat.
// Har commands poll (15s) par check: 60s se zyada ho to "connected" report.
// Laptop crash/hang par portal ab max ~75s me stale status dikhayega.
// Bot root me chalao:  node add_heartbeat.mjs   — CRLF-tolerant, idempotent.

import fs from "node:fs";
import { execSync } from "node:child_process";

const TARGET = "src/control_plane_bridge.py";

if (!fs.existsSync(TARGET)) {
  console.log("src/control_plane_bridge.py nahi mila — bot root me chalao.");
  process.exit(1);
}

let text = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

if (text.includes("_last_heartbeat")) {
  console.log("control_plane_bridge.py pehle se patched hai — kuch nahi kiya.");
  process.exit(0);
}

const edits = [
  [
    "import threading\nimport urllib.error",
    "import threading\nimport time\nimport urllib.error",
  ],
  [
    "        self._pending = []\n        self._lock = threading.Lock()",
    "        self._pending = []\n        self._lock = threading.Lock()\n        self._last_heartbeat = 0.0",
  ],
  [
    '    def fetch_commands(self, limit=10):\n        status, data = self._request(',
    '    def fetch_commands(self, limit=10):\n        now = time.monotonic()\n\n'
    + '        if now - self._last_heartbeat >= 60.0:\n'
    + '            self.report_status("connected")\n'
    + '            self._last_heartbeat = now\n\n'
    + '        status, data = self._request(',
  ],
];

for (const [oldStr, newStr] of edits) {
  const count = text.split(oldStr).length - 1;
  if (count !== 1) {
    console.log(`FAIL — anchor ${count} dafa mila (1 chahiye):\n${oldStr.slice(0, 140)}`);
    console.log("Kuch change NahI kiya. Poora output mujhe bhejo.");
    process.exit(1);
  }
  text = text.replace(oldStr, newStr);
}

fs.copyFileSync(TARGET, TARGET + ".pre_hb.bak");
fs.writeFileSync(TARGET, text, "utf8");

try {
  execSync("python -m py_compile " + JSON.stringify(TARGET), {
    stdio: "pipe",
  });
} catch (error) {
  fs.copyFileSync(TARGET + ".pre_hb.bak", TARGET);
  console.log("COMPILE FAIL — backup restore ho gaya.");
  console.log(String(error.stderr || error));
  process.exit(1);
}

console.log("  + control_plane_bridge.py: 60s status heartbeat");
console.log("");
console.log("SUCCESS! Ab bot restart karo:  python run_channel.py 1");
