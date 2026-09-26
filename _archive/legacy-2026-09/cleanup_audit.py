"""One-shot cleanup audit: lists root files and checks which src/ modules
are reachable from run_channel.py via imports. Deletes NOTHING."""

import ast
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")


def module_name(path):
    rel = os.path.relpath(path, ROOT)
    return rel.replace("\\", "/").rsplit(".", 1)[0].replace("/", ".")


py_files = {}
for base, dirs, files in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in ("__pycache__", ".venv", "venv")]
    for f in files:
        if f.endswith(".py"):
            py_files[module_name(os.path.join(base, f))] = os.path.join(base, f)

run_channel = os.path.join(ROOT, "run_channel.py")
if os.path.exists(run_channel):
    py_files["run_channel"] = run_channel


def imports_of(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            tree = ast.parse(handle.read())
    except Exception:
        return []
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.append(node.module)
    return found


reachable = set()
stack = ["run_channel"]
while stack:
    mod = stack.pop()
    if mod in reachable or mod not in py_files:
        continue
    reachable.add(mod)
    for imp in imports_of(py_files[mod]):
        stack.append(imp)
        if imp.startswith("src."):
            stack.append(imp[4:])
        else:
            stack.append("src." + imp)

print("=== ROOT FILES ===")
for name in sorted(os.listdir(ROOT)):
    path = os.path.join(ROOT, name)
    if os.path.isfile(path):
        print(str(os.path.getsize(path)).rjust(9) + "  " + name)
    else:
        print("<dir>     " + name + "/")

print()
print("=== src/ REACHABILITY (from run_channel.py) ===")
for name in sorted(py_files):
    tag = "KEEP  " if name in reachable else "ORPHAN"
    print(tag + "  " + name)

kept = len([n for n in py_files if n in reachable])
print()
print("reachable: " + str(kept) + " / " + str(len(py_files)))