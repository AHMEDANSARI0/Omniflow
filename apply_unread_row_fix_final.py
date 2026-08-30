from pathlib import Path
import py_compile
import shutil


ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "src" / "whatsapp.py"

NEW_METHOD = '''    def find_unread_chat(self):
        """Return a visible clickable sidebar row with an unread badge."""
        try:
            selectors = [
                "#pane-side span[aria-label*='unread' i]",
                "#pane-side [data-testid='icon-unread-count']",
                "#pane-side [data-testid='cell-unread-count']",
            ]

            unread_element = None

            for selector in selectors:
                candidates = self.page.locator(selector)

                for index in range(
                    candidates.count() - 1,
                    -1,
                    -1
                ):
                    candidate = candidates.nth(index)

                    try:
                        if candidate.is_visible():
                            unread_element = candidate
                            break
                    except Exception:
                        continue

                if unread_element is not None:
                    break

            if unread_element is None:
                return None

            self.last_unread_count = 1

            try:
                unread_text = " ".join(
                    value
                    for value in (
                        unread_element.inner_text(),
                        unread_element.get_attribute(
                            "aria-label"
                        ),
                    )
                    if value
                )

                numbers = [
                    int(value)
                    for value in re.findall(
                        r"\\d+",
                        unread_text
                    )
                ]

                if numbers:
                    self.last_unread_count = max(
                        1,
                        max(numbers)
                    )

            except Exception:
                self.last_unread_count = 1

            self.logger.log(
                "Unread indicator found: "
                f"count={self.last_unread_count}"
            )

            parent_selectors = [
                (
                    "xpath=ancestor::*"
                    "[@data-testid='cell-frame-container'][1]"
                ),
                "xpath=ancestor::*[@role='row'][1]",
                "xpath=ancestor::*[@role='listitem'][1]",
                "xpath=ancestor::*[@role='gridcell'][1]",
                "xpath=ancestor::*[@role='button'][1]",
                "xpath=ancestor::div[@tabindex][1]",
            ]

            for selector in parent_selectors:
                parents = unread_element.locator(
                    selector
                )

                if parents.count() == 0:
                    continue

                candidate = parents.first

                try:
                    if candidate.is_visible():
                        return candidate
                except Exception:
                    continue

            ancestors = unread_element.locator(
                "xpath=ancestor::*"
            )

            for index in range(
                min(ancestors.count(), 12)
            ):
                candidate = ancestors.nth(index)

                try:
                    if not candidate.is_visible():
                        continue

                    box = candidate.bounding_box()

                    if (
                        box
                        and box.get("width", 0) >= 220
                        and 36
                        <= box.get("height", 0)
                        <= 140
                    ):
                        return candidate

                except Exception:
                    continue

            self.logger.log(
                "Unread indicator had no "
                "clickable chat-row ancestor"
            )

            return None

        except Exception as error:
            self.logger.log(
                f"Unread Detection Error: {error}"
            )

            return None

'''


def main():
    print(
        "Installing final unread-row locator fix"
    )

    print(
        f"Project root: {ROOT}"
    )

    if not TARGET.is_file():
        raise RuntimeError(
            f"Missing file: {TARGET}"
        )

    source = TARGET.read_text(
        encoding="utf-8"
    )

    start_marker = (
        "    def find_unread_chat(self):"
    )

    end_marker = (
        "    # ---------------------------------\n"
        "    # Open Chat"
    )

    if source.count(start_marker) != 1:
        raise RuntimeError(
            "Expected exactly one "
            "find_unread_chat method; "
            "no change made"
        )

    start = source.index(start_marker)

    end = source.find(
        end_marker,
        start
    )

    if end < 0:
        raise RuntimeError(
            "Open Chat boundary was not found; "
            "no change made"
        )

    updated = (
        source[:start]
        + NEW_METHOD
        + source[end:]
    )

    required = (
        "#pane-side "
        "span[aria-label*='unread' i]",

        "xpath=ancestor::*"
        "[@role='row'][1]",

        "candidate.bounding_box()",
    )

    for signal in required:
        if signal not in updated:
            raise RuntimeError(
                "Internal patch validation "
                f"failed: {signal}"
            )

    backup = TARGET.with_suffix(
        TARGET.suffix
        + ".before_final_unread_fix.bak"
    )

    if not backup.exists():
        shutil.copy2(
            TARGET,
            backup
        )

    temporary = TARGET.with_suffix(
        TARGET.suffix
        + ".final_unread_fix.tmp"
    )

    try:
        temporary.write_text(
            updated,
            encoding="utf-8"
        )

        py_compile.compile(
            str(temporary),
            doraise=True
        )

        temporary.replace(TARGET)

        py_compile.compile(
            str(TARGET),
            doraise=True
        )

    except Exception:
        if temporary.exists():
            temporary.unlink()

        TARGET.write_text(
            source,
            encoding="utf-8"
        )

        raise

    installed = TARGET.read_text(
        encoding="utf-8"
    )

    for signal in required:
        if signal not in installed:
            TARGET.write_text(
                source,
                encoding="utf-8"
            )

            raise RuntimeError(
                "Post-write validation failed "
                "and was rolled back: "
                f"{signal}"
            )

    print(
        f"Backup: {backup}"
    )

    print(
        "Source validation: passed"
    )

    print(
        "Compile check: passed"
    )

    print(
        "FINAL UNREAD-ROW FIX "
        "INSTALLED SUCCESSFULLY"
    )


if __name__ == "__main__":
    main()