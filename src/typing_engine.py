import random
import time

from config import TYPING_ENABLED


class TypingEngine:
    def __init__(self):
        pass

    def thinking_delay(self):
        # Fast mode: no artificial delay unless explicitly enabled.
        if not TYPING_ENABLED:
            return

        delay = random.uniform(0.15, 0.35)

        print(
            f"Thinking for {delay:.1f} seconds..."
        )

        time.sleep(delay)

    def typing_delay(self, message):
        # Keep a very short human-like animation when enabled.
        if not TYPING_ENABLED:
            return

        words = len((message or "").split())

        delay = max(
            0.25,
            min(words * 0.04, 0.8)
        )

        delay += random.uniform(0.05, 0.15)

        print(
            f"Typing for {delay:.1f} seconds..."
        )

        time.sleep(delay)