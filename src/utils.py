import re
import time
import random


class Utils:

    @staticmethod
    def clean_text(text):

        if not text:
            return ""

        text = re.sub(r"\s+", " ", text)

        return text.strip()

    @staticmethod
    def contains_url(text):

        return bool(
            re.search(
                r"(https?://\S+|www\.\S+)",
                text
            )
        )

    @staticmethod
    def random_delay(min_seconds=0.5, max_seconds=2):

        delay = random.uniform(min_seconds, max_seconds)

        time.sleep(delay)

    @staticmethod
    def is_empty(text):

        return text.strip() == ""