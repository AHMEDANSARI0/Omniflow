"""OmniFlow Control Plane: connector_api.py me business-profile read endpoint.

Adds:  GET /api/v1/connector/profile?client_id=1  (X-Omniflow-Key)
       -> {profile: {...}, updated_at: iso|null}

- Anchor verify + backup (connector_api.py.pre_profile.bak) + py_compile
- Idempotent (marker: connector_business_profile)

Usage (OmniFlow-Control-Plane repo root, venv active):
  python add_connector_profile.py
Phir: git add/commit/push -> Vercel redeploy (~2 min)
"""

import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "connector_api.py"

MARKER = "connector_business_profile"

ANCHOR = "MAX_INGEST_MESSAGES = 100"

INSERT = '''@bp.get("/profile")
def connector_business_profile():
    """Business profile mirror (read-only) for the laptop connector."""
    tenant, error = _tenant_or_error(request.args.get("client_id"))
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT profile, updated_at FROM "
                    + portal_db._q(portal_db.PROFILE_TABLE) +
                    " WHERE client_id = %s",
                    (tenant["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "connector profile read")[0]), 503

    profile = {}
    updated_at = None
    if found:
        raw = found[0].get("profile")
        if isinstance(raw, dict):
            profile = raw
        updated = found[0].get("updated_at")
        if isinstance(updated, datetime):
            updated_at = updated.isoformat()

    return jsonify({"profile": profile, "updated_at": updated_at}), 200


MAX_INGEST_MESSAGES = 100'''


def main():
    if not TARGET.exists():
        print("connector_api.py nahi mila: " + str(TARGET))
        print("Yeh script OmniFlow-Control-Plane repo ke ROOT me chalao.")
        return 1

    original = TARGET.read_text(encoding="utf-8")

    if MARKER in original:
        print("connector_api.py pehle se patched hai — kuch nahi kiya.")
        return 0

    count = original.count(ANCHOR)

    if count != 1:
        print(
            f"Anchor {count} dafa mila (1 chahiye) — kuch change NahI kiya. "
            "File expected se alag hai, poora output mujhe bhejo."
        )
        return 1

    backup = TARGET.with_suffix(".py.pre_profile.bak")

    shutil.copyfile(TARGET, backup)
    print("Backup banaya: " + backup.name)

    patched = original.replace(ANCHOR, INSERT, 1)

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
    print("SUCCESS! GET /api/v1/connector/profile add ho gaya.")
    print("Ab yeh chalao:")
    print('  git add connector_api.py')
    print('  git commit -m "feat: connector business profile endpoint"')
    print("  git push")
    print("Phir Vercel deploy hone do (~2 min).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
