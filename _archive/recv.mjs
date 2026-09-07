// Plan C receiver — chunks verify karke omniflow_portal_setup.mjs banata hai
// Usage:  node recv.mjs   (payload.txt isi folder mein hona chahiye)
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.join(here, "payload.txt");
const TARGETS = [
  path.join(here, "Omniflow", "omniflow_portal_setup.mjs"),
  path.join(here, "OmniFlow-Control-Plane", "omniflow_portal_setup.mjs"),
];
const N = 13;
const FINAL_SHA = "60d7331b1e185a37e707b66e8046818863cb813606ce0c2b970bbddf8d0930e5";
const FINAL_SIZE = 90440;
const EXPECTED = {
  "01": "c0c2e22bca92914dc1677023010a71eae87019da15af3e77be1ea7c64efe0bd9",
  "02": "4d8cdef202873159efb519cb603e0c156331bfdb4fcf3288b78ddb564e869ec8",
  "03": "48b0bca51b74bb6850824b0ab97e3a23c416e92ae8cf67164834ac4aabb5a697",
  "04": "91347143d6df66a9664a100ec20eabe95c6563a4aef6b6740740a83c3a357ede",
  "05": "0b4ff51510a511fa49d007ac87969a6094bde848d57cb3153a5fce4d4c4dca79",
  "06": "480dbd95219c6961c3f4fef1a598b77c0253489e5a8747def40250c316867589",
  "07": "b15307e99bc9f42eb0f382411503151f51dfa9f1a799c486a1b48ec69f7da56d",
  "08": "c952acd59c91125cc3be6cc1656eda08889c5d7109a3dbc92239412352e1cb21",
  "09": "a88beb7c11f5c495803f06ac22a9ce21a7e0b7a04040588f6933b49e6271fbe0",
  "10": "20d36f3515dec3ac0c8b0b000d7118f60edc05d51052b45b29a9ea7a54743af1",
  "11": "bd59a058c4cb659d5629824c6375b2da56e73df0971c9fb1c9dd0065c6099705",
  "12": "bbd7daed208b41d8237d40cfa3be0a3315f9ccb3134dbbdc9082aab11c6363ae",
  "13": "99b0d06ad4e2280222160272a9ea91ae73868c0a3a20eede4da5972eee2a3399",
};

const raw = fs.readFileSync(PAYLOAD);
let text;
if (raw[0] === 0xff && raw[1] === 0xfe) text = new TextDecoder("utf-16le").decode(raw.subarray(2));
else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) text = raw.subarray(3).toString("utf8");
else text = raw.toString("utf8");

const map = new Map();
let cur = null;
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  const m = line.match(/^===CHUNK-(\d+)===$/);
  if (m) { cur = m[1].padStart(2, "0"); map.set(cur, ""); }
  else if (cur !== null && line.length > 0) map.set(cur, map.get(cur) + line);
}

const bad = [], missing = [];
for (let i = 1; i <= N; i++) {
  const key = String(i).padStart(2, "0");
  const got = (map.get(key) || "").replace(/\s+/g, "");
  if (!map.has(key) || got.length === 0) { missing.push(key); continue; }
  const h = crypto.createHash("sha256").update(got, "ascii").digest("hex");
  if (h === EXPECTED[key]) console.log("  CHUNK " + key + " OK");
  else { bad.push(key); console.log("  CHUNK " + key + " CORRUPT (dobara bhejni hai)"); }
}

if (missing.length || bad.length) {
  console.log("");
  if (missing.length) console.log("MISSING chunks: " + missing.join(", ") + "  (paste hona adhoora reh gaya)");
  if (bad.length) console.log("CORRUPT chunks: " + bad.join(", ") + "  (chat se dobara copy karo)");
  console.log("File NahI banayi. Sirf upar diye gaye chunks fix karke dobara 'node recv.mjs' chalao.");
  process.exit(1);
}

const all = Array.from({ length: N }, (_, k) => (map.get(String(k + 1).padStart(2, "0")) || "").replace(/\s+/g, "")).join("");
const buf = Buffer.from(all, "base64");
const finalSha = crypto.createHash("sha256").update(buf).digest("hex");
if (buf.length !== FINAL_SIZE || finalSha !== FINAL_SHA) {
  console.log("FINAL mismatch! size=" + buf.length + " sha=" + finalSha);
  console.log("Chunks OK the magar final galat — mujhe batayein, yeh alag case hai.");
  process.exit(1);
}

for (const t of TARGETS) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, buf);
  console.log("  LIKHA: " + t);
}
console.log("");
console.log("SUCCESS! File byte-perfect hai.");
console.log("Final check (optional): certutil -hashfile \"" + TARGETS[0] + "\" SHA256");
console.log("  -> " + FINAL_SHA);
console.log("");
console.log("Agla step:");
console.log("  cd /d \"C:\\Users\\Ahmed Ansari\\Desktop\\whatsapp-ai-bot\\Omniflow\"");
console.log("  node omniflow_portal_setup.mjs --push");