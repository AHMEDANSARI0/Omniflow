from pathlib import Path
import hashlib
import py_compile
import shutil


ROOT = Path(__file__).resolve().parent
WHATSAPP = ROOT / "src" / "whatsapp.py"
BURST_TEST = ROOT / "test_whatsapp_burst_adapter.py"
DIAGNOSTIC = ROOT / "diagnose_whatsapp_dom_burst.py"

OLD_METHOD_SHA256 = "2f5f11426bd2016842eff407c37f9e72e0b7940a447212131ce2a399711b548b"
NEW_METHOD_SHA256 = "9a0041244e1d5b9cedfe53925554b12447ee4b194e66a855486c7877b79a2d02"

NEW_METHOD = '    def find_unread_chat(self):\n        """Return a visible, clickable sidebar row containing an unread badge."""\n        try:\n            # Scope every selector to the chat list. A global aria-label search\n            # can otherwise match WhatsApp\\\'s "Unread" filter control instead of\n            # a chat badge, leaving open_chat with a disappearing span.\n            selectors = [\n                "#pane-side span[aria-label*=\\\'unread\\\' i]",\n                "#pane-side span[data-testid=\\\'icon-unread-count\\\']",\n                "#pane-side [data-testid=\\\'cell-unread-count\\\']",\n                "#side #pane-side span[aria-label*=\\\'unread\\\' i]",\n                "#side #pane-side [data-testid=\\\'cell-unread-count\\\']",\n            ]\n\n            unread_element = None\n\n            for selector in selectors:\n                unread_element = self._last_visible_locator(\n                    self.page.locator(selector)\n                )\n\n                if unread_element is not None:\n                    break\n\n            if unread_element is None:\n                return None\n\n            self.last_unread_count = 1\n\n            try:\n                unread_text = " ".join(\n                    value\n                    for value in (\n                        unread_element.inner_text(),\n                        unread_element.get_attribute(\n                            "aria-label"\n                        ),\n                    )\n                    if value\n                )\n                numbers = [\n                    int(value)\n                    for value in re.findall(\n                        r"\\d+",\n                        unread_text\n                    )\n                ]\n\n                if numbers:\n                    self.last_unread_count = max(\n                        1,\n                        max(numbers)\n                    )\n            except Exception:\n                self.last_unread_count = 1\n\n            self.logger.log(\n                "Unread indicator found: "\n                f"count={self.last_unread_count}"\n            )\n\n            parent_selectors = [\n                "xpath=ancestor::*[@data-testid=\\\'cell-frame-container\\\'][1]",\n                "xpath=ancestor::*[@role=\\\'row\\\'][1]",\n                "xpath=ancestor::*[@role=\\\'listitem\\\'][1]",\n                "xpath=ancestor::*[@role=\\\'gridcell\\\'][1]",\n                "xpath=ancestor::*[@role=\\\'button\\\'][1]",\n                "xpath=ancestor::div[@tabindex][1]",\n            ]\n\n            for selector in parent_selectors:\n                parent = unread_element.locator(selector)\n\n                if parent.count() == 0:\n                    continue\n\n                candidate = parent.first\n\n                try:\n                    if candidate.is_visible():\n                        return candidate\n                except Exception:\n                    continue\n\n            # WhatsApp frequently changes row roles/test IDs. As a bounded last\n            # fallback, choose the nearest visible ancestor whose dimensions\n            # match a sidebar chat row rather than clicking the transient badge.\n            ancestors = unread_element.locator(\n                "xpath=ancestor::*"\n            )\n\n            for index in range(\n                min(ancestors.count(), 12)\n            ):\n                candidate = ancestors.nth(index)\n\n                try:\n                    if not candidate.is_visible():\n                        continue\n\n                    box = candidate.bounding_box()\n\n                    if (\n                        box\n                        and box.get("width", 0) >= 220\n                        and 36 <= box.get("height", 0) <= 140\n                    ):\n                        return candidate\n                except Exception:\n                    continue\n\n            self.logger.log(\n                "Unread indicator had no clickable chat-row ancestor"\n            )\n            return None\n\n        except Exception as error:\n            self.logger.log(\n                f"Unread Detection Error: {error}"\n            )\n\n            return None\n\n'

OLD_MARKERS = 'MARKERS = ("A6", "B6", "C6")'
NEW_MARKERS = 'MARKERS = ("A7", "B7", "C7")'

OLD_PROMPT = '        print(\n            "Now send A5, B5, and C5 rapidly as three separate messages "\n            "from the test phone. Waiting up to 90 seconds..."\n        )'

NEW_PROMPT = '        print(\n            "Now send "\n            + ", ".join(MARKERS)\n            + " rapidly as three separate messages from the test phone. "\n            "Waiting up to 90 seconds..."\n        )'

OLD_TEST_SIGNALS = '    required_signals = (\n        "[data-icon=\\\'msg-check\\\']",\n        "[data-icon=\\\'msg-dblcheck\\\']",\n        "closest(\\\'[data-id]\\\')",\n        "fromMe",\n        "getBoundingClientRect",\n    )'

NEW_TEST_SIGNALS = '    required_signals = (\n        "[data-icon=\\\'msg-check\\\']",\n        "[data-icon=\\\'msg-dblcheck\\\']",\n        "closest(\\\'[data-id]\\\')",\n        "fromMe",\n        "getBoundingClientRect",\n        "#pane-side span[aria-label*=\\\'unread\\\' i]",\n        "candidate.bounding_box()",\n    )'

OLD_TEST_PRINT = '    print("Current DOM outbound direction fallback: passed")\n    print("React/data-id/geometry direction fallbacks: present")\n    print("Active-chat rapid messages captured in order: 3/3")'

NEW_TEST_PRINT = '    print("Current DOM outbound direction fallback: passed")\n    print("React/data-id/geometry direction fallbacks: present")\n    print("Unread indicator scoped to clickable sidebar row: passed")\n    print("Active-chat rapid messages captured in order: 3/3")'


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

    if current_hash == NEW_METHOD_SHA256:
        updated = original
        changes = 0

    elif current_hash == OLD_METHOD_SHA256:
        updated = (
            original[:start]
            + NEW_METHOD
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

        if updated.count(old_text) != 1:
            raise RuntimeError(
                f"{label}: unsupported source "
                "version. No files were changed."
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
                + ".pre_unread_row_fix.bak"
            )

            if not backup.exists():
                shutil.copy2(
                    path,
                    backup
                )

            temporary = path.with_suffix(
                path.suffix
                + ".unread_row_fix.tmp"
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

        for path in (
            WHATSAPP,
            BURST_TEST,
            DIAGNOSTIC
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
        "locator fix"
    )

    print(
        f"Project root: {ROOT}"
    )

    plans = [
        unread_method_plan(),

        exact_plan(
            DIAGNOSTIC,
            [
                (
                    OLD_MARKERS,
                    NEW_MARKERS
                ),
                (
                    OLD_PROMPT,
                    NEW_PROMPT
                ),
            ],
            "Fresh A7/B7/C7 diagnostic "
            "and dynamic prompt"
        ),

        exact_plan(
            BURST_TEST,
            [
                (
                    OLD_TEST_SIGNALS,
                    NEW_TEST_SIGNALS
                ),
                (
                    OLD_TEST_PRINT,
                    NEW_TEST_PRINT
                ),
            ],
            "Unread-row regression coverage"
        ),
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
        "\nUNREAD-ROW FIX "
        "INSTALLED SUCCESSFULLY"
    )


if __name__ == "__main__":
    main()