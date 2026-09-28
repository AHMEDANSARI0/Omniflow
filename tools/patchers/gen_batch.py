"""Generic batch-patcher generator (laptop layout law, HANDOFF 202).

Laptop layout: the patcher runs at the WEBSITE repo root (the bot root),
which contains the nested CP repo folder ``OmniFlow-Control-Plane/``.
Every CP op given as ``omniflow-backend-patch/<file>`` is therefore
emitted TWICE:

* ``omniflow-backend-patch/<file>``  - website-side mirror (tracked in
  the website repo since batch 1301; keeps origin/main == sandbox tree)
* ``OmniFlow-Control-Plane/<file>``  - the CP repo = what Vercel deploys
  (isCp: py_compile guard, restore-on-failure)

Usage (from the repo root):

    python3 tools/patchers/gen_batch.py SPEC.json

SPEC.json = {"out": "tools/patchers/add_batch_X.mjs",
             "backup_tag": ".pre_x.bak",
             "header": "// comment lines...",
             "base": "/tmp/mainbase"   (optional: origin/main tree; markers
                                        must be ABSENT there),
             "ops": [["path/relative/to/repo", "unique marker"], ...]}

Markers must be present in the NEW content and absent from the base copy
(so drift triggers a repair, and a second run says "already").
"""
import json
import os
import sys

CP_SRC = "omniflow-backend-patch/"
CP_REPO = "OmniFlow-Control-Plane/"

HELPER = r'''import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = "__BACKUP_TAG__";
let applied = 0, already = 0, warnings = 0;
if (!fs.existsSync("OmniFlow-Control-Plane") || !fs.statSync("OmniFlow-Control-Plane").isDirectory()) {
  console.log("X Run this from the website repo root (bot root) - the folder that contains OmniFlow-Control-Plane/. Nothing was written.");
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
'''

FOOTER = r'''
console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: cd OmniFlow-Control-Plane -> git add -A -> commit -> push (CP redeploys); then website: git add -A -> commit -> push.");
'''


def main(spec_path):
    spec = json.load(open(spec_path, encoding="utf8"))
    base = spec.get("base")
    out = [spec["header"].rstrip("\n") + "\n",
           HELPER.replace("__BACKUP_TAG__", spec["backup_tag"])]
    emitted = 0
    seen = set()
    for rel, marker in spec["ops"]:
        assert rel not in seen, "duplicate op " + rel
        seen.add(rel)
        content = open(rel, encoding="utf8").read().replace("\r\n", "\n")
        assert marker in content, "marker missing in NEW %s: %r" % (rel, marker)
        if base:
            base_path = os.path.join(base, rel)
            if os.path.exists(base_path):
                base_text = open(base_path, encoding="utf8").read().replace("\r\n", "\n")
                assert marker not in base_text, "marker already in BASE %s: %r" % (rel, marker)
        targets = [(rel, False)]
        if rel.startswith(CP_SRC):
            targets.append((CP_REPO + rel[len(CP_SRC):], True))
        for target, is_cp in targets:
            out.append("writeNewRepair(%s, %s, %s,\n    %s);\n" % (
                json.dumps(target, ensure_ascii=True),
                json.dumps(marker, ensure_ascii=True),
                "true" if is_cp else "false",
                json.dumps(content, ensure_ascii=True)))
            emitted += 1
    out.append(FOOTER)
    text = "".join(out)
    open(spec["out"], "w", encoding="utf8", newline="\n").write(text)
    print("wrote", spec["out"], "-", emitted, "ops,", round(len(text) / 1048576, 2), "MB")


if __name__ == "__main__":
    main(sys.argv[1])
