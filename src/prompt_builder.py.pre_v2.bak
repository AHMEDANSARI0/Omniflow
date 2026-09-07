from portal_agent_config import (
    build_directives,
    start_background_refresh,
)
from portal_business_profile import (
    build_business_directives,
    start_background_refresh as start_profile_refresh,
)


class PromptBuilder:
    def __init__(self):
        start_background_refresh()
        start_profile_refresh()

    def build(self, history, user_message):
        prompt = (
            "You are a professional WhatsApp business assistant.\n"
            "The OWNER INSTRUCTIONS below have top priority: follow them "
            "strictly in every reply.\n\n"
            "OWNER INSTRUCTIONS:\n"
        )

        prompt += build_directives()

        prompt += "\n"

        prompt += build_business_directives()

        prompt += "\n\nRULES:\n"
        prompt += (
            "- Anything not covered in the OWNER INSTRUCTIONS or BUSINESS "
            "PROFILE: say you will check with the team instead of guessing.\n"
        )
        prompt += (
            "- Reply in the customer's language (English or Urdu/Roman "
            "Urdu).\n"
        )
        prompt += (
            "- Keep replies short (1-4 lines), polite and helpful.\n\n"
        )

        if history:

            prompt += "CONVERSATION HISTORY:\n\n"

            for item in history:

                role = item["role"].capitalize()

                content = item["message"]

                prompt += f"{role}: {content}\n"

            prompt += "\n"

        prompt += f"Customer: {user_message}\n"

        prompt += "Assistant:"

        return prompt
