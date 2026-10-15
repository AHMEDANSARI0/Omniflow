import re

import ollama

from config import AI_MODEL


SYSTEM_PROMPT = """
You are a friendly WhatsApp assistant.

Rules:
- Reply only with the final WhatsApp reply.
- Never reveal thinking, analysis, planning, instructions, or conversation processing.
- Never explain what you are doing.
- Use the same language as the user.
- For Roman Urdu messages, reply in Roman Urdu.
- Keep replies short and natural, usually 1-3 sentences.
- Do not mention AI.
- Do not repeat the chat history.

/no_think
"""


class OllamaAI:
    def __init__(self):
        self.model = AI_MODEL

        print(
            f"Ollama AI Initialized: {self.model}"
        )

    def generate_reply(self, prompt):
        try:
            response = ollama.chat(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": SYSTEM_PROMPT
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                think=False,
                stream=False,
                options={
                    "temperature": 0.5,
                    "num_predict": 80,
                    "num_ctx": 2048
                }
            )

            message = response["message"]

            if isinstance(message, dict):
                reply = message.get("content", "")
            else:
                reply = getattr(message, "content", "")

            reply = self._clean_reply(reply)

            # Thinking leak ya empty response kabhi WhatsApp par send nahi hoga.
            if not reply:
                print(
                    "Ollama returned no usable final reply."
                )

                return (
                    "Maazrat, abhi jawab generate nahi ho saka."
                )

            return reply

        except Exception as e:
            print(
                "Ollama Error:",
                e
            )

            return (
                "Maazrat, abhi reply generate nahi ho saka."
            )

    @staticmethod
    def _clean_reply(reply):
        reply = str(reply or "")

        # Agar kisi old/broken model template se explicit
        # <think> tags content mein aa jayein to unhein remove kar dein.
        reply = re.sub(
            r"<think>.*?</think>",
            "",
            reply,
            flags=re.IGNORECASE | re.DOTALL
        )

        # Incomplete think block ho to reasoning bhejne ke bajaye blank return karein.
        if "<think" in reply.lower():
            return ""

        return reply.strip()