from providers.base_provider import BaseAIProvider


class MockProvider(BaseAIProvider):

    def generate_response(self, prompt):

        return "Test AI response working."