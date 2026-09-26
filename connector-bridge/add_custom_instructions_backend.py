"""Custom Instructions: backend (Control-Plane repo) — 4 files patch.

  * portal_bot.py      — validation + GET/PUT (custom_instructions, max 2000)
  * connector_api.py   — /connector/bot response
  * portal_db.py       — lazy CREATE TABLE schema
  * migrations/008     — canonical schema file

Har anchor verify (1x) + backups + py_compile + idempotent.
Chalao OmniFlow-Control-Plane repo ROOT me (venv andar):
  python add_custom_instructions_backend.py
PEHLE Neon SQL editor me column ALTER chalana (script khud bhi bataegi).
"""

import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

FILES = {
    "portal_bot": ROOT / "portal_bot.py",
    "connector_api": ROOT / "connector_api.py",
    "portal_db": ROOT / "portal_db.py",
    "migration": ROOT / "migrations" / "008_portal_connector.sql",
}

MARKER = "custom_instructions"


def fail(msg):
    for name, path in FILES.items():
        bak = path.with_suffix(path.suffix + ".pre_ci.bak")
        if bak.exists():
            shutil.copyfile(bak, path)
    print("FAIL — sab backups restore ho gaye.")
    print(msg)
    sys.exit(1)


def patch(path, edits, name):
    text = path.read_text(encoding="utf-8")
    if MARKER not in text:
        for old, new in edits:
            count = text.count(old)
            if count != 1:
                fail(f"[{name}] anchor {count} dafa mila (1 chahiye):\n{old[:120]}")
            text = text.replace(old, new, 1)
        shutil.copyfile(path, path.with_suffix(path.suffix + ".pre_ci.bak"))
        path.write_text(text, encoding="utf-8", newline="")
        print("  + " + name)
    else:
        print("  = " + name + " (pehle se patched)")


def main():
    missing = [str(p) for p in FILES.values() if not p.exists()]
    if missing:
        print("Files nahi mile (Control-Plane ROOT me chalao): " + ", ".join(missing))
        return 1

    patch(
        FILES["portal_bot"],
        [
            (
                '    "human_handoff_enabled": False,\n}',
                '    "human_handoff_enabled": False,\n    "custom_instructions": "",\n}',
            ),
            (
                '    handoff = _as_bool(_pick(payload, "human_handoff_enabled", "humanHandoffEnabled"), False)\n\n    config = {',
                '    handoff = _as_bool(_pick(payload, "human_handoff_enabled", "humanHandoffEnabled"), False)\n\n'
                '    custom_instructions = _pick(payload, "custom_instructions", "customInstructions")\n'
                '    custom_instructions = custom_instructions if isinstance(custom_instructions, str) else ""\n'
                '    if not _TEXT_RE.match(custom_instructions):\n'
                '        return None, "Custom instructions 2000 characters se chhote rakhein."\n\n'
                '    config = {',
            ),
            (
                '        "human_handoff_enabled": handoff,\n    }',
                '        "human_handoff_enabled": handoff,\n        "custom_instructions": custom_instructions,\n    }',
            ),
            (
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, updated_at"',
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, custom_instructions, updated_at"',
            ),
            (
                '            "human_handoff_enabled": row.get("human_handoff_enabled") is True,\n        }',
                '            "human_handoff_enabled": row.get("human_handoff_enabled") is True,\n            "custom_instructions": row.get("custom_instructions") or "",\n        }',
            ),
            (
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, updated_by, updated_at) "',
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, custom_instructions, updated_by, updated_at) "',
            ),
            (
                '"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) "',
                '"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) "',
            ),
            (
                '" human_handoff_enabled = EXCLUDED.human_handoff_enabled,"',
                '" human_handoff_enabled = EXCLUDED.human_handoff_enabled,"\n                    " custom_instructions = EXCLUDED.custom_instructions,"',
            ),
            (
                '                     config["working_hours_end"], config["human_handoff_enabled"],',
                '                     config["working_hours_end"], config["human_handoff_enabled"],\n                     config["custom_instructions"],',
            ),
        ],
        "portal_bot.py",
    )

    patch(
        FILES["connector_api"],
        [
            (
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, updated_at"',
                '" working_hours_enabled, working_hours_start, working_hours_end,"\n                    " human_handoff_enabled, custom_instructions, updated_at"',
            ),
            (
                '            "human_handoff_enabled": False,\n            "updated_at": None,',
                '            "human_handoff_enabled": False,\n            "custom_instructions": "",\n            "updated_at": None,',
            ),
            (
                '        "human_handoff_enabled": row.get("human_handoff_enabled") is True,\n        "updated_at":',
                '        "human_handoff_enabled": row.get("human_handoff_enabled") is True,\n        "custom_instructions": row.get("custom_instructions") or "",\n        "updated_at":',
            ),
        ],
        "connector_api.py",
    )

    schema_edit = [
        (
            "  human_handoff_enabled BOOLEAN NOT NULL DEFAULT FALSE,\n  updated_by BIGINT,",
            "  human_handoff_enabled BOOLEAN NOT NULL DEFAULT FALSE,\n  custom_instructions TEXT NOT NULL DEFAULT '',\n  updated_by BIGINT,",
        )
    ]
    patch(FILES["portal_db"], schema_edit, "portal_db.py")
    patch(FILES["migration"], schema_edit, "migrations/008_portal_connector.sql")

    for name in ("portal_bot", "connector_api"):
        try:
            py_compile.compile(
                str(FILES[name]),
                cfile=str(tempfile.mktemp(suffix=".pyc")),
                doraise=True,
            )
        except Exception as error:
            fail(f"[{name}] COMPILE FAIL: {error}")

    print("")
    print("SUCCESS! Backend custom_instructions ready.")
    print("Ab:")
    print("  1) Neon SQL editor (agar abhi tak nahi chalaya):")
    print("     ALTER TABLE portal_bot_configs ADD COLUMN IF NOT EXISTS custom_instructions TEXT NOT NULL DEFAULT '';")
    print("  2) git add portal_bot.py connector_api.py portal_db.py migrations/008_portal_connector.sql")
    print('  3) git commit -m "feat: custom instructions for AI agent"')
    print("  4) git push")
    return 0


if __name__ == "__main__":
    sys.exit(main())
