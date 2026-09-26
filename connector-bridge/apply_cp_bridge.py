"""run_channel.py me Control Plane bridge wire karta hai.

- Har anchor pehle verify hota hai (exact match, sirf 1 jagah)
- Backup: run_channel.py.pre_cp_bridge.bak
- Patch ke baad py_compile check — fail hua to backup auto-restore
- Idempotent: agar pehle se patched hai to kuch nahi karta

Usage:  python apply_cp_bridge.py   (bot root me, venv ke andar)
"""

import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "run_channel.py"
BRIDGE_FILE = ROOT / "src" / "control_plane_bridge.py"

MARKER = "ControlPlaneBridge("

ANCHORS = [
    (
        "import",
        "from conversation import ConversationManager  # noqa: E402",
        "from conversation import ConversationManager  # noqa: E402\n"
        "from control_plane_bridge import ControlPlaneBridge  # noqa: E402",
    ),
    (
        "bridge-init",
        '    try:\n'
        '        adapter.start()\n'
        '        adapter_started = True\n'
        '\n'
        '        print("Channel worker running. Press Ctrl+C to stop.\\n")',
        '    try:\n'
        '        bridge = None\n'
        '\n'
        '        adapter.start()\n'
        '        adapter_started = True\n'
        '\n'
        '        try:\n'
        '            bridge = ControlPlaneBridge(\n'
        '                account_name=account.account_name,\n'
        '            )\n'
        '\n'
        '            manager.cp_bridge = bridge\n'
        '\n'
        '            bridge.report_status("connected")\n'
        '        except Exception as bridge_error:\n'
        '            print(f"CP bridge init warning: {bridge_error}")\n'
        '\n'
        '        print("Channel worker running. Press Ctrl+C to stop.\\n")',
    ),
    (
        "poll-throttle-init",
        "    previous_signal_handlers = {}\n"
        "    next_due_reply_scan_at = 0.0",
        "    previous_signal_handlers = {}\n"
        "    next_due_reply_scan_at = 0.0\n"
        "    next_command_poll_at = 0.0",
    ),
    (
        "commands-poll",
        "            now = time.monotonic()\n"
        "\n"
        "            if now >= next_due_reply_scan_at:",
        "            now = time.monotonic()\n"
        "\n"
        "            if (\n"
        "                bridge is not None\n"
        "                and now >= next_command_poll_at\n"
        "            ):\n"
        "                try:\n"
        "                    bridge.run_due_commands(\n"
        "                        adapter,\n"
        "                        stop_requested,\n"
        "                    )\n"
        "                except Exception as bridge_error:\n"
        '                    print(f"CP bridge commands warning: {bridge_error}")\n'
        "\n"
        "                next_command_poll_at = (\n"
        "                    time.monotonic()\n"
        "                    + bridge.command_poll_seconds\n"
        "                )\n"
        "\n"
        "            if now >= next_due_reply_scan_at:",
    ),
    (
        "inbound-ingest",
        "                    outbound = manager.process_event(\n"
        "                        event\n"
        "                    )",
        "                    if bridge is not None:\n"
        "                        bridge.ingest_message(\n"
        "                            external_user_id=event.external_user_id,\n"
        "                            body=event.content,\n"
        '                            direction="in",\n'
        "                            display_name=event.display_name,\n"
        "                        )\n"
        "\n"
        "                    outbound = manager.process_event(\n"
        "                        event\n"
        "                    )",
    ),
    (
        "outbound-ingest",
        "            manager.memory.mark_reply_sent(\n"
        "                job_id,\n"
        "                outbound_external_message_id=(\n"
        "                    result.external_message_id\n"
        "                )\n"
        "            )\n"
        "            return True",
        "            manager.memory.mark_reply_sent(\n"
        "                job_id,\n"
        "                outbound_external_message_id=(\n"
        "                    result.external_message_id\n"
        "                )\n"
        "            )\n"
        "\n"
        '            bridge_out = getattr(manager, "cp_bridge", None)\n'
        "\n"
        "            if bridge_out is not None:\n"
        "                bridge_out.ingest_message(\n"
        "                    external_user_id=outbound.external_user_id,\n"
        "                    body=outbound.content,\n"
        '                    direction="out",\n'
        "                )\n"
        "\n"
        "            return True",
    ),
    (
        "shutdown-status",
        "        if adapter_started:\n"
        "            try:\n"
        "                adapter.stop()\n"
        "            except Exception as error:\n"
        "                print(\n"
        '                    f"Browser cleanup warning: {error}"\n'
        "                )",
        "        if adapter_started:\n"
        "            try:\n"
        "                adapter.stop()\n"
        "            except Exception as error:\n"
        "                print(\n"
        '                    f"Browser cleanup warning: {error}"\n'
        "                )\n"
        "\n"
        "        if bridge is not None:\n"
        "            try:\n"
        '                bridge.report_status("disconnected")\n'
        "            except Exception:\n"
        "                pass",
    ),
]


def main():
    if not TARGET.exists():
        print("run_channel.py nahi mila: " + str(TARGET))
        return 1

    if not BRIDGE_FILE.exists():
        print(
            "src\\control_plane_bridge.py nahi mila — pehle wo file "
            "save karo (STEP 1 wala code), phir yeh dobara chalao."
        )
        return 1

    original = TARGET.read_text(encoding="utf-8")

    if MARKER in original:
        print("run_channel.py pehle se patched hai — kuch nahi kiya.")
        return 0

    for name, old, _new in ANCHORS:
        count = original.count(old)

        if count != 1:
            print(
                f"Anchor '{name}' {count} dafa mila (1 hona chahiye) — "
                "kuch change NahI kiya. run_channel.py expected version "
                "se alag hai."
            )
            return 1

    backup = TARGET.with_suffix(".py.pre_cp_bridge.bak")

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
            cfile=str(
                tempfile.mktemp(suffix=".pyc")
            ),
            doraise=True,
        )
    except Exception as error:
        shutil.copyfile(backup, TARGET)
        print("COMPILE FAIL — backup restore ho gaya.")
        print(f"Error: {error}")
        return 1

    print("")
    print("SUCCESS! run_channel.py ab Control Plane bridge ke saath hai.")
    print("Ab bot ko restart karo (jaise pehle chalate ho waise hi).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
