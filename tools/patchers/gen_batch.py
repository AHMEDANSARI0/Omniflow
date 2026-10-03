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
             "requires": [["path", "needle", "why"]]  (optional: earlier
                                        batches this one builds on),
             "ensure_lines": [["path", "line", "regex already-present"]]
                                       (optional: append one line to a
                                        plain-text file, e.g. a CP
                                        requirements.txt dependency;
                                        EOL style kept, backup taken),
             "ops": [["path/relative/to/repo", "unique marker"], ...,
                     ["path/to/retire.tsx", {"delete": true}]]}

Markers must be present in the NEW content and absent from the base copy
(so drift triggers a repair, and a second run says "already").
"""
import json
import os
import posixpath
import re
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
'''

ENSURE_LINE = r'''function ensureLine(repoPath, line, presentRe) {
  try {
    if (!fs.existsSync(repoPath)) {
      console.log("! " + repoPath + " not found - add this line yourself: " + line);
      warnings++;
      return;
    }
    const text = fs.readFileSync(repoPath, "utf8");
    if (new RegExp(presentRe, "im").test(text)) {
      console.log("= " + repoPath + " (already lists " + line + ")");
      already++;
      return;
    }
    const backup = repoPath + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(repoPath, text + (text === "" || text.endsWith("\n") ? "" : eol) + line + eol, "utf8");
    console.log("+ " + repoPath + " (added " + line + ")");
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


# §213 build-fix law: every relative import in a TS/JS op must resolve to a
# real file from the op's own path, with EXACT letter case (Vercel builds on
# case-sensitive Linux). A wrong "../" count once shipped in §205/§207/§209
# and broke `npm run build` on the laptop; generation now refuses that.
_IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}/[^"'\n]*)["']""")
_SUFFIXES = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss",
             "/index.ts", "/index.tsx", "/index.js", "/index.jsx")


def _is_file_exact(rel):
    parts = [x for x in rel.split("/") if x]
    cur = "."
    for part in parts:
        try:
            if part not in os.listdir(cur):
                return False
        except OSError:
            return False
        cur = os.path.join(cur, part)
    return os.path.isfile(cur)


def unresolved_imports(rel, content):
    if not re.search(r"\.(tsx?|jsx?|mjs|cjs)$", rel):
        return []
    bad = []
    for spec in _IMPORT_RE.findall(content):
        target = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
        if target.startswith("..") or not any(_is_file_exact(target + s) for s in _SUFFIXES):
            bad.append(spec)
    return bad


def main(spec_path):
    spec = json.load(open(spec_path, encoding="utf8"))
    base = spec.get("base")
    out = [spec["header"].rstrip("\n") + "\n",
           HELPER.replace("__BACKUP_TAG__", spec["backup_tag"])]
    # Optional "requires": [[path, needle, why], ...] - earlier batches this
    # one builds on. Checked before anything is written; abort if missing.
    for req_path, needle, why in spec.get("requires", []):
        local = req_path
        if req_path.startswith(CP_REPO) and not os.path.exists(req_path):
            local = CP_SRC + req_path[len(CP_REPO):]  # sandbox keeps the CP as its mirror
        assert needle in open(local, encoding="utf8").read(), "requires: %s lacks %r" % (local, needle)
        out.append(
            "if (!fs.existsSync(%s) || !fs.readFileSync(%s, \"utf8\").includes(%s)) {\n"
            "  console.log(\"X \" + %s + \" Nothing was written.\");\n  process.exit(1);\n}\n" % (
                json.dumps(req_path), json.dumps(req_path), json.dumps(needle, ensure_ascii=True), json.dumps(why)))
    emitted = 0
    seen = set()
    for rel, marker in spec["ops"]:
        assert rel not in seen, "duplicate op " + rel
        seen.add(rel)
        if isinstance(marker, dict) and marker.get("delete"):
            assert not os.path.exists(rel), "delete op but %s still exists in the workspace" % rel
            assert not rel.startswith(CP_SRC), "delete ops are website-only"
            out.append("removeFile(%s);\n" % json.dumps(rel, ensure_ascii=True))
            emitted += 1
            continue
        content = open(rel, encoding="utf8").read().replace("\r\n", "\n")
        assert marker in content, "marker missing in NEW %s: %r" % (rel, marker)
        bad = unresolved_imports(rel, content)
        assert not bad, "unresolved relative import(s) in %s: %r" % (rel, bad)
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
    # Optional "ensure_lines": [[path, line, present_regex], ...] - append a
    # single line (e.g. a CP dependency) when the regex finds nothing.
    ensure = spec.get("ensure_lines", [])
    if ensure:
        out.append(ENSURE_LINE)
    for rel, line, present in ensure:
        assert re.search(present, line, re.I | re.M), "ensure_lines regex must match its own line: %r" % line
        out.append("ensureLine(%s, %s, %s);\n" % (
            json.dumps(rel, ensure_ascii=True), json.dumps(line, ensure_ascii=True),
            json.dumps(present, ensure_ascii=True)))
        emitted += 1
    out.append(FOOTER)
    text = "".join(out)
    open(spec["out"], "w", encoding="utf8", newline="\n").write(text)
    print("wrote", spec["out"], "-", emitted, "ops,", round(len(text) / 1048576, 2), "MB")


if __name__ == "__main__":
    main(sys.argv[1])
