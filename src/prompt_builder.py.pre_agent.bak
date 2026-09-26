from system_prompt import SYSTEM_PROMPT


class PromptBuilder:

    def __init__(self):
        pass

    def build(self, history, user_message):

        prompt = SYSTEM_PROMPT.strip()

        prompt += "\n\n"

        if history:

            prompt += "Conversation History:\n\n"

            for item in history:

                role = item["role"].capitalize()

                content = item["message"]

                prompt += f"{role}: {content}\n"

            prompt += "\n"

        prompt += f"User: {user_message}\n"

        prompt += "Assistant:"

        return prompt