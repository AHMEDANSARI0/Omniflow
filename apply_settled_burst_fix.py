from pathlib import Path
import base64
import hashlib
import py_compile
import shutil
import zlib


ROOT = Path(__file__).resolve().parent
WHATSAPP = ROOT / "src" / "whatsapp.py"
ADAPTER = ROOT / "src" / "channels" / "whatsapp_web.py"

WHATSAPP_PAYLOAD = (
    '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'
)

ADAPTER_PAYLOAD = (
    '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'
    'H76wvrw='
)

EXPECTED_WHATSAPP_SHA256 = (
    "a5bff419613a8937b73fc8ea9aeaf45fe16f5376e7e56e366c794835ea54a1a0"
)

EXPECTED_ADAPTER_SHA256 = (
    "091fae8c7d941e01495e748f25114ab6b5f27dfaf0eb162a537fc6b4d6eae7c9"
)


def decode_payload(
    encoded,
    expected_hash,
    label
):
    decoded = zlib.decompress(
        base64.b64decode(encoded)
    ).decode("utf-8")

    actual_hash = hashlib.sha256(
        decoded.encode("utf-8")
    ).hexdigest()

    if actual_hash != expected_hash:
        raise RuntimeError(
            f"{label} payload checksum failed; "
            "no files changed"
        )

    return decoded


def prepare_whatsapp(new_block):
    if not WHATSAPP.is_file():
        raise RuntimeError(
            f"Missing file: {WHATSAPP}"
        )

    original = WHATSAPP.read_text(
        encoding="utf-8"
    )

    updated = original

    if "import time\n" not in updated:
        if "import re\n" not in updated:
            raise RuntimeError(
                "Import boundary missing; "
                "no files changed"
            )

        updated = updated.replace(
            "import re\n",
            "import re\nimport time\n",
            1
        )

    parse_marker = (
        "    def _parse_message_container("
    )

    timestamp_marker = (
        "    @staticmethod\n"
        "    def _get_message_timestamp_label"
    )

    end_marker = (
        "    def get_latest_chat_message("
    )

    parse_start = updated.find(
        parse_marker
    )

    timestamp_start = updated.find(
        timestamp_marker
    )

    start = (
        timestamp_start
        if (
            0 <= timestamp_start
            < parse_start
        )
        else parse_start
    )

    end = updated.find(
        end_marker,
        max(0, start)
    )

    if start < 0 or end < 0:
        raise RuntimeError(
            "Message reader boundaries "
            "missing; no files changed"
        )

    updated = (
        updated[:start]
        + new_block
        + updated[end:]
    )

    return {
        "path": WHATSAPP,
        "original": original,
        "updated": updated,
        "label": (
            "Settled timestamp-aware "
            "DOM reader"
        ),
    }


def prepare_adapter(new_method):
    if not ADAPTER.is_file():
        raise RuntimeError(
            f"Missing file: {ADAPTER}"
        )

    original = ADAPTER.read_text(
        encoding="utf-8"
    )

    start_marker = (
        "    def _read_current_events("
    )

    end_marker = (
        "    # ---------------------------------\n"
        "    # Polling Input"
    )

    start = original.find(
        start_marker
    )

    end = original.find(
        end_marker,
        max(0, start)
    )

    if start < 0 or end < 0:
        raise RuntimeError(
            "Adapter reader boundaries "
            "missing; no files changed"
        )

    updated = (
        original[:start]
        + new_method
        + original[end:]
    )

    return {
        "path": ADAPTER,
        "original": original,
        "updated": updated,
        "label": (
            "No-boundary settled "
            "burst selection"
        ),
    }


def validate(plans):
    required = {
        WHATSAPP: (
            (
                "def "
                "get_stable_visible_chat_messages("
            ),
            '"timestamp_label":',
            '"present_at_settle_start"',
        ),
        ADAPTER: (
            '"settled-recent-timestamp"',
            '"badge-tail-plus-late"',
            (
                "get_stable_visible_chat_messages"
            ),
        ),
    }

    for plan in plans:
        for signal in required[
            plan["path"]
        ]:
            if signal not in plan["updated"]:
                raise RuntimeError(
                    "Internal validation failed: "
                    f"{signal}"
                )


def install(plans):
    written = []

    try:
        for plan in plans:
            path = plan["path"]

            backup = path.with_suffix(
                path.suffix
                + ".before_settled_burst_fix.bak"
            )

            if not backup.exists():
                shutil.copy2(
                    path,
                    backup
                )

            temporary = path.with_suffix(
                path.suffix
                + ".settled_burst_fix.tmp"
            )

            temporary.write_text(
                plan["updated"],
                encoding="utf-8"
            )

            py_compile.compile(
                str(temporary),
                doraise=True
            )

            temporary.replace(path)
            written.append(plan)

            print(
                f"{plan['label']}: installed"
            )

            print(
                f"  backup: {backup}"
            )

        for plan in plans:
            py_compile.compile(
                str(plan["path"]),
                doraise=True
            )

    except Exception:
        for plan in reversed(written):
            plan["path"].write_text(
                plan["original"],
                encoding="utf-8"
            )

        raise


def main():
    print(
        "Installing settled "
        "no-boundary burst fix"
    )

    print(
        f"Project root: {ROOT}"
    )

    whatsapp_block = decode_payload(
        WHATSAPP_PAYLOAD,
        EXPECTED_WHATSAPP_SHA256,
        "WhatsApp"
    )

    adapter_method = decode_payload(
        ADAPTER_PAYLOAD,
        EXPECTED_ADAPTER_SHA256,
        "Adapter"
    )

    plans = [
        prepare_whatsapp(
            whatsapp_block
        ),
        prepare_adapter(
            adapter_method
        ),
    ]

    validate(plans)
    install(plans)

    print(
        "Payload checksums: passed"
    )

    print(
        "Source validation: passed"
    )

    print(
        "Compile checks: passed"
    )

    print(
        "SETTLED BURST FIX "
        "INSTALLED SUCCESSFULLY"
    )


if __name__ == "__main__":
    main()