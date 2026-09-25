"""prompt_builder.py me portal agent-config inject karta hai.

- Har anchor pehle verify (exact, sirf 1 jagah)
- Backup: prompt_builder.py.pre_agent.bak
- py_compile check — fail to auto-restore
- Idempotent (marker: build_directives)

Usage:  python apply_agent_config.py   (bot root, venv ke andar)
Pehle src\\portal_agent_config.py save hona chahiye.
"""

import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "src" / "prompt_builder.py"
CONFIG_FILE = ROOT / "src" / "portal_agent_config.py"

MARKER = "build_directives"

ANCHORS = [
    (
        "import",
        "from system_prompt import SYSTEM_PROMPT",
        "from system_prompt import SYSTEM_PROMPT\n"
        "from portal_agent_config import (\n"
        "    build_directives,\n"
        "    start_background_refresh,\n"
        ")",
    ),
    (
        "init-refresh",
        "    def __init__(self):\n"
        "        pass",
        "    def __init__(self):\n"
        "        start_background_refresh()",
    ),
    (
        "directives-inject",
        '        prompt = SYSTEM_PROMPT.strip()\n\n'
        '        prompt += "\\n\\n"',
        '        prompt = SYSTEM_PROMPT.strip()\n\n'
        '        prompt += "\\n\\n"\n'
        "        prompt += build_directives()\n\n"
        '        prompt += "\\n\\n"',
    ),
]


def main():
    if not TARGET.exists():
        print("src\\prompt_builder.py nahi mila: " + str(TARGET))
        return 1

    if not CONFIG_FILE.exists():
        print(
            "src\\portal_agent_config.py nahi mila — pehle STEP 1 wali "
            "file save karo, phir yeh dobara chalao."
        )
        return 1

    original = TARGET.read_text(encoding="utf-8")

    if MARKER in original:
        print("prompt_builder.py pehle se patched hai — kuch nahi kiya.")
        return 0

    for name, old, _new in ANCHORS:
        count = original.count(old)

        if count != 1:
            print(
                f"Anchor '{name}' {count} dafa mila (1 chahiye) — kuch "
                "change NahI kiya. File expected se alag hai, mujhe batana."
            )
            return 1

    backup = TARGET.with_suffix(".py.pre_agent.bak")

    shutil.copyfile(TARGET, backup)
    print("Backup banaya: " + backup.name)

    patched = original

    for name, _old, new in ANCHORS:
        patched = patched.replace(_old, new, 1)
        print("  + " + name)

    TARGET.write_text(patched, encoding="utf-8", newline="")

    try:
        py_compile.compile(
            str(TARGET),
            cfile=str(tempfile.mktemp(suffix=".pyc")),
            doraise=True,
        )
    except Exception as error:
        shutil.copyfile(backup, TARGET)
        print("COMPILE FAIL — backup restore ho gaya.")
        print(f"Error: {error}")
        return 1

    print("")
    print("SUCCESS! Bot ab portal 'AI agents' config follow karega.")
    print("Ab bot restart karo, phir portal se tone/name badal kar test karo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
