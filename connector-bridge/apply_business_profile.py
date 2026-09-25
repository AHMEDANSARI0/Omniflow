"""prompt_builder.py (pehle se agent-config patched) me business-profile
directives inject karta hai.

- Anchor verify + backup (prompt_builder.py.pre_biz.bak) + py_compile
- Idempotent (marker: build_business_directives)

Usage:  python apply_business_profile.py   (bot root, venv ke andar)
Pehle src\\portal_business_profile.py save hona chahiye.
"""

import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "src" / "prompt_builder.py"
CONFIG_FILE = ROOT / "src" / "portal_business_profile.py"

MARKER = "build_business_directives"

ANCHORS = [
    (
        "import",
        "from portal_agent_config import (\n"
        "    build_directives,\n"
        "    start_background_refresh,\n"
        ")",
        "from portal_agent_config import (\n"
        "    build_directives,\n"
        "    start_background_refresh,\n"
        ")\n"
        "from portal_business_profile import (\n"
        "    build_business_directives,\n"
        "    start_background_refresh as start_profile_refresh,\n"
        ")",
    ),
    (
        "init-refresh",
        "    def __init__(self):\n"
        "        start_background_refresh()",
        "    def __init__(self):\n"
        "        start_background_refresh()\n"
        "        start_profile_refresh()",
    ),
    (
        "profile-inject",
        "        prompt += build_directives()\n\n"
        '        prompt += "\\n\\n"',
        "        prompt += build_directives()\n\n"
        '        prompt += "\\n\\n"\n'
        "        prompt += build_business_directives()\n\n"
        '        prompt += "\\n\\n"',
    ),
]


def main():
    if not TARGET.exists():
        print("src\\prompt_builder.py nahi mila: " + str(TARGET))
        return 1

    if not CONFIG_FILE.exists():
        print(
            "src\\portal_business_profile.py nahi mila — pehle STEP 2 wali "
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
                "change NahI kiya. Pehle apply_agent_config.py chala hua "
                "honA chahiye. Poora output mujhe bhejo."
            )
            return 1

    backup = TARGET.with_suffix(".py.pre_biz.bak")

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
    print("SUCCESS! Bot ab portal Business profile se jawab dega.")
    print("Ab bot restart karo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
