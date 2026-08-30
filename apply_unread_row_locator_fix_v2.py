from pathlib import Path
import hashlib
import py_compile
import shutil

import apply_unread_row_locator_fix as payload


ROOT = Path(__file__).resolve().parent
WHATSAPP = ROOT / "src" / "whatsapp.py"
ADAPTER = ROOT / "src" / "channels" / "whatsapp_web.py"
BURST_TEST = ROOT / "test_whatsapp_burst_adapter.py"
DIAGNOSTIC = ROOT / "diagnose_whatsapp_dom_burst.py"


REQUIRED_PAYLOAD_NAMES = (
    "OLD_METHOD_SHA256",
    "NEW_METHOD_SHA256",
    "NEW_METHOD",
    "OLD_MARKERS",
    "NEW_MARKERS",
    "OLD_PROMPT",
    "NEW_PROMPT",
)

for name in REQUIRED_PAYLOAD_NAMES:
    if not hasattr(payload, name):
        raise RuntimeError(
            "The previous apply_unread_row_locator_fix.py file is not the "
            f"expected version; missing: {name}"
        )


def make_plan(
    path,
    original,
    updated,
    changes,
    label
):
    return {
        "path": path,
        "original": original,
        "updated": updated,
        "changes": changes,
        "label": label,
    }


def unread_method_plan():
    if not WHATSAPP.is_file():
        raise RuntimeError(
            f"Missing required file: {WHATSAPP}"
        )

    original = WHATSAPP.read_text(
        encoding="utf-8"
    )

    start_marker = (
        "    def find_unread_chat(self):"
    )

    end_marker = (
        "    # ---------------------------------\n"
        "    # Open Chat"
    )

    start = original.find(start_marker)
    end = original.find(
        end_marker,
        start
    )

    if start < 0 or end < 0:
        raise RuntimeError(
            "Unread method boundaries were "
            "not found. No files were changed."
        )

    current = original[start:end]

    current_hash = hashlib.sha256(
        current.encode("utf-8")
    ).hexdigest()

    if (
        current_hash
        == payload.NEW_METHOD_SHA256
    ):
        updated = original
        changes = 0

    elif (
        current_hash
        == payload.OLD_METHOD_SHA256
    ):
        updated = (
            original[:start]
            + payload.NEW_METHOD
            + original[end:]
        )
        changes = 1

    else:
        raise RuntimeError(
            "Unsupported find_unread_chat "
            f"version: {current_hash}. "
            "No files were changed."
        )

    return make_plan(
        WHATSAPP,
        original,
        updated,
        changes,
        "Scoped clickable unread-chat row"
    )


def diagnostic_plan():
    if not DIAGNOSTIC.is_file():
        raise RuntimeError(
            f"Missing required file: "
            f"{DIAGNOSTIC}"
        )

    original = DIAGNOSTIC.read_text(
        encoding="utf-8"
    )

    updated = original
    changes = 0

    replacements = (
        (
            payload.OLD_MARKERS,
            payload.NEW_MARKERS,
            "marker declaration",
        ),
        (
            payload.OLD_PROMPT,
            payload.NEW_PROMPT,
            "marker prompt",
        ),
    )

    for old_text, new_text, label in replacements:
        if new_text in updated:
            continue

        if updated.count(old_text) != 1:
            raise RuntimeError(
                f"Unsupported diagnostic "
                f"{label}. "
                "No files were changed."
            )

        updated = updated.replace(
            old_text,
            new_text,
            1
        )

        changes += 1

    return make_plan(
        DIAGNOSTIC,
        original,
        updated,
        changes,
        "Fresh A7/B7/C7 diagnostic "
        "and dynamic prompt"
    )


def validate_installed_source():
    source = WHATSAPP.read_text(
        encoding="utf-8"
    )

    required = (
        "#pane-side "
        "span[aria-label*='unread' i]",

        "xpath=ancestor::*"
        "[@role='row'][1]",

        "candidate.bounding_box()",

        "Unread indicator had no "
        "clickable chat-row ancestor",
    )

    for signal in required:
        if signal not in source:
            raise RuntimeError(
                "Installed unread-row "
                "validation failed: "
                f"{signal}"
            )


def install(plans):
    written = []

    try:
        for plan in plans:
            path = plan["path"]

            if not plan["changes"]:
                print(
                    f"{plan['label']}: "
                    "already installed"
                )
                continue

            backup = path.with_suffix(
                path.suffix
                + ".pre_unread_row_fix_v2.bak"
            )

            if not backup.exists():
                shutil.copy2(
                    path,
                    backup
                )

            temporary = path.with_suffix(
                path.suffix
                + ".unread_row_fix_v2.tmp"
            )

            temporary.write_text(
                plan["updated"],
                encoding="utf-8"
            )

            temporary.replace(path)
            written.append(plan)

            print(
                f"{plan['label']}: installed"
            )

            print(
                f"  backup: {backup}"
            )

        validate_installed_source()

        for path in (
            WHATSAPP,
            ADAPTER,
            BURST_TEST,
            DIAGNOSTIC,
        ):
            py_compile.compile(
                str(path),
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
        "GOLD WhatsApp unread-row "
        "locator fix v2"
    )

    print(
        f"Project root: {ROOT}"
    )

    # The prior failure happened during planning,
    # before install(), so it made no changes.
    # This version deliberately leaves the
    # already-passing burst test file untouched.
    plans = [
        unread_method_plan(),
        diagnostic_plan(),
    ]

    install(plans)

    print(
        "Unread-row source validation: passed"
    )

    print(
        "Compile checks: passed"
    )

    print("\nRun next:")

    print(
        "  python "
        "test_whatsapp_adapter.py"
    )

    print(
        "  python "
        "test_whatsapp_burst_adapter.py"
    )

    print(
        "  python "
        "diagnose_whatsapp_dom_burst.py"
    )

    print(
        "\nUNREAD-ROW FIX V2 "
        "INSTALLED SUCCESSFULLY"
    )


if __name__ == "__main__":
    main()