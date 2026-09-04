// patch_sidebar.mjs — DashSidebar ke 5 "SOON" portal nav items enable karta hai
import fs from "node:fs";
import crypto from "node:crypto";

const FILE = "app/dashboard/components/DashSidebar.tsx";
if (!fs.existsSync(FILE)) {
  console.log("File nahi mili: " + FILE);
  console.log("Yeh script Omniflow website repo ke ROOT me chalao.");
  process.exit(1);
}
const before = fs.readFileSync(FILE, "utf8");
const sha = crypto.createHash("sha256").update(before).digest("hex").slice(0, 12);
const count = (before.match(/enabled: false/g) || []).length;
if (count !== 5 || !before.includes('label: "WhatsApp setup"') || !before.includes('href: "/dashboard/settings"')) {
  console.log("File expected jaisi nahi hai (enabled: false x" + count + "). Kuch change NahI kiya.");
  console.log("Yeh output mujhe paste karo: " + sha);
  process.exit(1);
}
fs.writeFileSync(FILE, before.replace(/enabled: false/g, "enabled: true"), "utf8");
console.log("OK! 5 sidebar items enable ho gaye (file " + sha + " thi).");
console.log("Ab git commit + push karo (agla block).");