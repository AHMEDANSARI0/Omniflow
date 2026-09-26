// add_sound_alert.mjs - Phase 53: notification chime for new messages.
//
// Website only: a Sound on/off toggle next to the desktop alerts toggle. When
// enabled and the tab is hidden, a short chime plays whenever the unread +
// needs-reply total grows (WebAudio, no asset). Requires Phase 46 applied
// first (anchors on the alerts toggle blocks). No backend, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

const PAGE_STATE_FROM = `  const [alertEnabled, setAlertEnabled] = useState(false);
  const alertTotalRef = useRef(0);`;

const PAGE_STATE_TO = `  const [alertEnabled, setAlertEnabled] = useState(false);
  const alertTotalRef = useRef(0);
  const [soundEnabled, setSoundEnabled] = useState(false);`;

const PAGE_FN_FROM = `  async function toggleAlert() {
    const next = !alertEnabled;
    setAlertEnabled(next);
    try {
      window.localStorage.setItem("ofl_desktop_alert", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
    if (
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission prompt unavailable.
      }
    }
  }

  useEffect(() => {
    const total = chipCounts.unread + chipCounts.needsReply;
    if (
      alertEnabled &&
      total > alertTotalRef.current &&
      document.hidden &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification("New customer message", {
          body: "Open the inbox to reply.",
        });
      } catch {
        // Notifications unavailable in this browser.
      }
    }
    alertTotalRef.current = total;
  }, [chipCounts, alertEnabled]);`;

const PAGE_FN_TO = `  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    try {
      window.localStorage.setItem("ofl_sound", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
  }

  async function toggleAlert() {
    const next = !alertEnabled;
    setAlertEnabled(next);
    try {
      window.localStorage.setItem("ofl_desktop_alert", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
    if (
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission prompt unavailable.
      }
    }
  }

  useEffect(() => {
    const total = chipCounts.unread + chipCounts.needsReply;
    if (total > alertTotalRef.current && document.hidden) {
      if (
        alertEnabled &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification("New customer message", {
            body: "Open the inbox to reply.",
          });
        } catch {
          // Notifications unavailable in this browser.
        }
      }
      if (soundEnabled) {
        try {
          const AudioContextCtor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (AudioContextCtor) {
            const chime = new AudioContextCtor();
            const oscillator = chime.createOscillator();
            const gain = chime.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(0.05, chime.currentTime);
            gain.gain.exponentialRampToValueAtTime(
              0.0001,
              chime.currentTime + 0.4
            );
            oscillator.connect(gain);
            gain.connect(chime.destination);
            oscillator.start();
            oscillator.stop(chime.currentTime + 0.4);
            oscillator.onended = () => void chime.close();
          }
        } catch {
          // Audio playback unavailable.
        }
      }
    }
    alertTotalRef.current = total;
  }, [chipCounts, alertEnabled, soundEnabled]);`;

const PAGE_SEED_FROM = `    try {
      setAlertEnabled(window.localStorage.getItem("ofl_desktop_alert") === "1");
    } catch {
      // Storage unavailable.
    }
    void refresh();`;

const PAGE_SEED_TO = `    try {
      setAlertEnabled(window.localStorage.getItem("ofl_desktop_alert") === "1");
    } catch {
      // Storage unavailable.
    }
    try {
      setSoundEnabled(window.localStorage.getItem("ofl_sound") === "1");
    } catch {
      // Storage unavailable.
    }
    void refresh();`;

const PAGE_BUTTON_FROM = `        <button
          type="button"
          onClick={() => void toggleAlert()}
          title={
            alertEnabled
              ? "Desktop alerts are on"
              : "Get a desktop alert when new customer messages arrive"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            alertEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {alertEnabled ? "Alerts on" : "Alerts off"}
        </button>`;

const PAGE_BUTTON_TO = `        <button
          type="button"
          onClick={() => toggleSound()}
          title={
            soundEnabled
              ? "Notification sound is on"
              : "Play a sound when new customer messages arrive"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            soundEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {soundEnabled ? "Sound on" : "Sound off"}
        </button>
        <button
          type="button"
          onClick={() => void toggleAlert()}
          title={
            alertEnabled
              ? "Desktop alerts are on"
              : "Get a desktop alert when new customer messages arrive"
          }
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 \${
            alertEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }\`}
        >
          {alertEnabled ? "Alerts on" : "Alerts off"}
        </button>`;

// Driver

const TARGETS = [
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-sound-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-sound-fn-and-effect", from: PAGE_FN_FROM, to: PAGE_FN_TO },
      { name: "inbox-sound-seed", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "inbox-sound-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

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
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_sound.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
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

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);