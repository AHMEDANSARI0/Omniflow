from pathlib import Path
import hashlib
import py_compile
import shutil


ROOT = Path(__file__).resolve().parent
WHATSAPP = ROOT / "src" / "whatsapp.py"
ADAPTER = ROOT / "src" / "channels" / "whatsapp_web.py"
BURST_TEST = ROOT / "test_whatsapp_burst_adapter.py"
DIAGNOSTIC = ROOT / "diagnose_whatsapp_dom_burst.py"

OLD_DIRECTION_SHA256 = "48c61f6d03bbbe11aabc9fdd46429a70dea7261bee91ee50d2e79c4a39b79422"
NEW_DIRECTION_SHA256 = "cb6cf340080dfada8a02225deced256cf246d4e436b0f50162771a9aafd7c625"

NEW_DIRECTION_METHOD = '    @staticmethod\n    def _get_message_direction(container):\n        """\n        Return inbound/outbound from structural WhatsApp DOM/React signals.\n\n        Current WhatsApp builds can omit the historical message-in/message-out\n        classes and expose opaque message IDs. Outbound delivery-state icons,\n        nearest data-id ancestors, message-scoped React fromMe values, and\n        bubble alignment provide bounded fallbacks without inspecting text.\n        """\n        try:\n            outbound_status = container.locator(\n                "[data-icon=\'msg-check\'], "\n                "[data-icon=\'msg-dblcheck\'], "\n                "[data-icon=\'msg-dblcheck-ack\'], "\n                "[data-icon=\'msg-time\'], "\n                "[data-testid=\'msg-check\'], "\n                "[data-testid=\'msg-dblcheck\'], "\n                "[data-testid=\'msg-dblcheck-ack\']"\n            )\n\n            if outbound_status.count() > 0:\n                return "outbound"\n\n        except Exception:\n            pass\n\n        try:\n            direction = container.evaluate(\n                """(element) => {\n                    const directionalNode = element.closest(\n                        \'.message-in, .message-out\'\n                    ) || element.querySelector(\n                        \'.message-in, .message-out\'\n                    );\n\n                    if (\n                        element.classList?.contains(\'message-out\') ||\n                        directionalNode?.classList?.contains(\'message-out\')\n                    ) {\n                        return \'outbound\';\n                    }\n\n                    if (\n                        element.classList?.contains(\'message-in\') ||\n                        directionalNode?.classList?.contains(\'message-in\')\n                    ) {\n                        return \'inbound\';\n                    }\n\n                    const idNodes = [];\n                    const nearestIdNode = element.closest(\'[data-id]\');\n\n                    if (nearestIdNode) {\n                        idNodes.push(nearestIdNode);\n                    }\n\n                    idNodes.push(element);\n                    idNodes.push(\n                        ...element.querySelectorAll(\'[data-id]\')\n                    );\n\n                    for (const node of idNodes) {\n                        const value = String(\n                            node.getAttribute?.(\'data-id\') || \'\'\n                        ).toLowerCase();\n\n                        if (value.startsWith(\'true_\')) {\n                            return \'outbound\';\n                        }\n\n                        if (value.startsWith(\'false_\')) {\n                            return \'inbound\';\n                        }\n                    }\n\n                    const readFromMe = (value) => {\n                        if (!value || typeof value !== \'object\') {\n                            return null;\n                        }\n\n                        const candidates = [\n                            value.id?.fromMe,\n                            value.__x_id?.fromMe,\n                            value.msg?.id?.fromMe,\n                            value.message?.id?.fromMe,\n                            value.model?.id?.fromMe,\n                            value.data?.id?.fromMe,\n                            value.message?.fromMe,\n                            value.msg?.fromMe\n                        ];\n\n                        for (const candidate of candidates) {\n                            if (typeof candidate === \'boolean\') {\n                                return candidate;\n                            }\n                        }\n\n                        return null;\n                    };\n\n                    let currentElement = element;\n\n                    for (\n                        let elementDepth = 0;\n                        currentElement && elementDepth < 10;\n                        elementDepth += 1\n                    ) {\n                        let propertyNames = [];\n\n                        try {\n                            propertyNames = Object.getOwnPropertyNames(\n                                currentElement\n                            );\n                        } catch (error) {\n                            propertyNames = [];\n                        }\n\n                        for (const propertyName of propertyNames) {\n                            if (!propertyName.startsWith(\'__reactFiber$\')) {\n                                continue;\n                            }\n\n                            let fiber = null;\n\n                            try {\n                                fiber = currentElement[propertyName];\n                            } catch (error) {\n                                fiber = null;\n                            }\n\n                            for (\n                                let fiberDepth = 0;\n                                fiber && fiberDepth < 24;\n                                fiberDepth += 1\n                            ) {\n                                const values = [\n                                    fiber.memoizedProps,\n                                    fiber.pendingProps,\n                                    fiber.memoizedState\n                                ];\n\n                                for (const value of values) {\n                                    const fromMe = readFromMe(value);\n\n                                    if (fromMe === true) {\n                                        return \'outbound\';\n                                    }\n\n                                    if (fromMe === false) {\n                                        return \'inbound\';\n                                    }\n                                }\n\n                                fiber = fiber.return;\n                            }\n                        }\n\n                        currentElement = currentElement.parentElement;\n                    }\n\n                    const main = document.querySelector(\'#main\');\n                    const mainRect = main?.getBoundingClientRect();\n                    const bubbleRect = element.getBoundingClientRect();\n\n                    if (\n                        mainRect &&\n                        mainRect.width > 0 &&\n                        bubbleRect.width > 0 &&\n                        bubbleRect.width < mainRect.width * 0.90\n                    ) {\n                        const leftGap = bubbleRect.left - mainRect.left;\n                        const rightGap = mainRect.right - bubbleRect.right;\n                        const tolerance = Math.max(\n                            8,\n                            mainRect.width * 0.02\n                        );\n\n                        if (leftGap > rightGap + tolerance) {\n                            return \'outbound\';\n                        }\n\n                        if (rightGap > leftGap + tolerance) {\n                            return \'inbound\';\n                        }\n                    }\n\n                    return \'unknown\';\n                }"""\n            )\n            return direction or "unknown"\n\n        except Exception:\n            return "unknown"\n'

OLD_ADAPTER_LOG_POINT = '                if burst_candidates:\n                    candidates = burst_candidates\n                else:\n                    inbound_candidates = [\n                        message\n                        for message in unseen_candidates\n                        if message.get(\n                            "direction",\n                            "unknown"\n                        ) != "outbound"\n                    ]\n                    candidates = inbound_candidates[\n                        -unread_limit:\n                    ]\n            else:\n'

NEW_ADAPTER_LOG_POINT = '                if burst_candidates:\n                    candidates = burst_candidates\n                else:\n                    inbound_candidates = [\n                        message\n                        for message in unseen_candidates\n                        if message.get(\n                            "direction",\n                            "unknown"\n                        ) != "outbound"\n                    ]\n                    candidates = inbound_candidates[\n                        -unread_limit:\n                    ]\n\n                direction_counts = {\n                    "inbound": 0,\n                    "outbound": 0,\n                    "unknown": 0,\n                }\n\n                for message in normalized_visible:\n                    direction = message.get(\n                        "direction",\n                        "unknown"\n                    )\n\n                    if direction not in direction_counts:\n                        direction = "unknown"\n\n                    direction_counts[direction] += 1\n\n                print(\n                    "WhatsApp unread burst snapshot: "\n                    f"visible={len(normalized_visible)}, "\n                    f"inbound={direction_counts[\'inbound\']}, "\n                    f"outbound={direction_counts[\'outbound\']}, "\n                    f"unknown={direction_counts[\'unknown\']}, "\n                    "last_outbound_position="\n                    + (\n                        str(last_outbound_index + 1)\n                        if last_outbound_index is not None\n                        else "none"\n                    )\n                    + f", selected={len(candidates)}"\n                )\n            else:\n'

DIRECTION_TEST = 'def verify_current_dom_direction_fallbacks():\n    # Keep the real-DOM direction defenses in the launch regression even when\n    # Playwright is intentionally absent from this isolated fake-bot test.\n    source = (\n        SRC_DIR\n        / "whatsapp.py"\n    ).read_text(encoding="utf-8")\n\n    required_signals = (\n        "[data-icon=\'msg-check\']",\n        "[data-icon=\'msg-dblcheck\']",\n        "closest(\'[data-id]\')",\n        "fromMe",\n        "getBoundingClientRect",\n    )\n\n    for signal in required_signals:\n        assert signal in source, (\n            "Missing current-DOM direction fallback: "\n            f"{signal}"\n        )\n\n\n'

OLD_DIAGNOSTIC_RESULT = '        if raw_seen == set(MARKERS) and parsed_seen == set(MARKERS):\n            print(\n                "RESULT: The DOM and parser both exposed all three markers. "\n                "The remaining fault is in adapter selection/cursor timing."\n            )\n        elif raw_seen == set(MARKERS):\n            print(\n                "RESULT: The DOM exposed all three markers, but the parser "\n                "missed at least one. The DOM extraction layer is the fault."\n            )\n        else:\n            print(\n                "RESULT: The current DOM selector did not expose all three "\n                "markers during the capture window. A DOM/store ingestion "\n                "fallback is required."\n            )\n'

NEW_DIAGNOSTIC_RESULT = '        direction_boundary_ready = any(\n            {\n                item["marker"]\n                for item in snapshot["parsed_markers"]\n                if item["direction"] == "inbound"\n            } == set(MARKERS)\n            and snapshot["last_outbound_position"] is not None\n            for snapshot in snapshots\n        )\n\n        if direction_boundary_ready:\n            print(\n                "RESULT: All three markers are parsed as inbound and a prior "\n                "outbound boundary is detected. Direction classification is "\n                "ready for the controlled live worker test."\n            )\n        elif raw_seen == set(MARKERS) and parsed_seen == set(MARKERS):\n            print(\n                "RESULT: The DOM and parser exposed all three markers, but "\n                "direction/boundary classification is still incomplete. Do "\n                "not launch the worker yet."\n            )\n        elif raw_seen == set(MARKERS):\n            print(\n                "RESULT: The DOM exposed all three markers, but the parser "\n                "missed at least one. The DOM extraction layer is the fault."\n            )\n        else:\n            print(\n                "RESULT: The current DOM selector did not expose all three "\n                "markers during the capture window. A DOM/store ingestion "\n                "fallback is required."\n            )\n'


def direction_plan():
    original = WHATSAPP.read_text(
        encoding="utf-8"
    )

    start_marker = (
        "    @staticmethod\n"
        "    def _get_message_direction"
    )

    end_marker = (
        "\n    def _parse_message_container"
    )

    start = original.find(start_marker)
    end = original.find(
        end_marker,
        start
    )

    if start < 0 or end < 0:
        raise RuntimeError(
            "WhatsApp direction method "
            "boundaries were not found. "
            "No files were changed."
        )

    current = original[start:end]

    current_hash = hashlib.sha256(
        current.encode("utf-8")
    ).hexdigest()

    if current_hash == NEW_DIRECTION_SHA256:
        updated = original
        changes = 0

    elif current_hash == OLD_DIRECTION_SHA256:
        updated = (
            original[:start]
            + NEW_DIRECTION_METHOD
            + original[end:]
        )
        changes = 1

    else:
        raise RuntimeError(
            "Unsupported src/whatsapp.py "
            "direction method version: "
            f"{current_hash}. "
            "No files were changed."
        )

    return make_plan(
        WHATSAPP,
        original,
        updated,
        changes,
        "WhatsApp DOM direction classifier"
    )


def exact_plan(
    path,
    replacements,
    label
):
    if not path.is_file():
        raise RuntimeError(
            f"Missing required file: {path}"
        )

    original = path.read_text(
        encoding="utf-8"
    )

    updated = original
    changes = 0

    for old_text, new_text in replacements:
        if new_text in updated:
            continue

        count = updated.count(old_text)

        if count != 1:
            raise RuntimeError(
                f"{label}: expected one "
                "supported old block, "
                f"found {count}. "
                "No files were changed."
            )

        updated = updated.replace(
            old_text,
            new_text,
            1
        )

        changes += 1

    return make_plan(
        path,
        original,
        updated,
        changes,
        label
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


def diagnostic_plan():
    if not DIAGNOSTIC.is_file():
        return None

    original = DIAGNOSTIC.read_text(
        encoding="utf-8"
    )

    updated = original
    changes = 0

    old_markers = (
        'MARKERS = ("A5", "B5", "C5")'
    )

    new_markers = (
        'MARKERS = ("A6", "B6", "C6")'
    )

    if new_markers not in updated:
        if updated.count(old_markers) != 1:
            raise RuntimeError(
                "DOM diagnostic marker block "
                "is unsupported. "
                "No files were changed."
            )

        updated = updated.replace(
            old_markers,
            new_markers,
            1
        )

        changes += 1

    if NEW_DIAGNOSTIC_RESULT not in updated:
        if (
            updated.count(
                OLD_DIAGNOSTIC_RESULT
            )
            != 1
        ):
            raise RuntimeError(
                "DOM diagnostic result block "
                "is unsupported. "
                "No files were changed."
            )

        updated = updated.replace(
            OLD_DIAGNOSTIC_RESULT,
            NEW_DIAGNOSTIC_RESULT,
            1
        )

        changes += 1

    return make_plan(
        DIAGNOSTIC,
        original,
        updated,
        changes,
        "DOM diagnostic A6/B6/C6 "
        "direction gate"
    )


def install(plans):
    written = []

    try:
        for plan in plans:
            if plan is None:
                continue

            path = plan["path"]

            if not plan["changes"]:
                print(
                    f"{plan['label']}: "
                    "already installed"
                )
                continue

            backup = path.with_suffix(
                path.suffix
                + ".pre_direction_fix.bak"
            )

            if not backup.exists():
                shutil.copy2(
                    path,
                    backup
                )

            temporary = path.with_suffix(
                path.suffix
                + ".direction_fix.tmp"
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

        py_compile.compile(
            str(WHATSAPP),
            doraise=True
        )

        py_compile.compile(
            str(ADAPTER),
            doraise=True
        )

        py_compile.compile(
            str(BURST_TEST),
            doraise=True
        )

        if DIAGNOSTIC.is_file():
            py_compile.compile(
                str(DIAGNOSTIC),
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
        "GOLD WhatsApp current-DOM "
        "direction fix"
    )

    print(
        f"Project root: {ROOT}"
    )

    if not WHATSAPP.is_file():
        raise RuntimeError(
            f"Missing required file: "
            f"{WHATSAPP}"
        )

    plans = [
        direction_plan(),

        exact_plan(
            ADAPTER,
            [
                (
                    OLD_ADAPTER_LOG_POINT,
                    NEW_ADAPTER_LOG_POINT
                )
            ],
            "Unread burst observability"
        ),

        exact_plan(
            BURST_TEST,
            [
                (
                    "def verify_active_chat_burst():\n",
                    DIRECTION_TEST
                    + "def verify_active_chat_burst():\n"
                ),

                (
                    "def main():\n"
                    "    verify_active_chat_burst()\n",

                    "def main():\n"
                    "    verify_current_dom_direction_fallbacks()\n"
                    "    verify_active_chat_burst()\n"
                ),

                (
                    "    print("
                    "\"Active-chat rapid messages "
                    "captured in order: 3/3\""
                    ")\n",

                    "    print("
                    "\"Current DOM outbound direction "
                    "fallback: passed\""
                    ")\n"
                    "    print("
                    "\"React/data-id/geometry direction "
                    "fallbacks: present\""
                    ")\n"
                    "    print("
                    "\"Active-chat rapid messages "
                    "captured in order: 3/3\""
                    ")\n"
                ),
            ],
            "Direction regression coverage"
        ),

        diagnostic_plan(),
    ]

    install(plans)

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
        "\nDIRECTION FIX "
        "INSTALLED SUCCESSFULLY"
    )


if __name__ == "__main__":
    main()