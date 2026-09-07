import asyncio
import os
import re
from portal_agent_config import (
    build_directives,
)
from portal_business_profile import (
    build_business_directives,
)


def PORTAL_SYSTEM_PROMPT():
    """Portal-driven system prompt — OWNER INSTRUCTIONS top priority."""
    sections = [
        "You are a professional WhatsApp business assistant.",
        "The OWNER INSTRUCTIONS below have top priority: follow them "
        "strictly in every reply.",
        "",
        "OWNER INSTRUCTIONS:",
        build_directives(),
    ]

    business = build_business_directives()

    if business:
        sections.append("")
        sections.append(business)

    sections.append("")
    sections.append("RULES:")
    sections.append(
        "- Anything not covered above: say you will check with the team "
        "instead of guessing."
    )
    sections.append(
        "- Reply in the customer's language (English or Urdu/Roman Urdu)."
    )
    sections.append(
        "- Keep replies short (1-4 lines), polite and helpful. No emojis "
        "unless the customer uses them."
    )

    return "\n".join(sections)

import time
import uuid
from pathlib import Path

from config import (
    AI_MAX_OUTPUT_TOKENS,
    AI_REQUEST_TIMEOUT_SECONDS,
    AUDIO_TEMP_DIR,
    CEREBRAS_MODEL,
    EDGE_TTS_VOICE,
    GEMINI_FAST_MODEL,
    GEMINI_MODEL,
    GROQ_MODEL,
    GROQ_TRANSCRIPTION_MODEL,
    GROQ_TTS_MODEL,
    GROQ_TTS_VOICE,
    OPENROUTER_MODEL,
)
from gemini_ai import GeminiAI

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

try:
    from groq import Groq
except ImportError:
    Groq = None

try:
    import edge_tts
except ImportError:
    edge_tts = None


SAFE_FALLBACK_REPLY = (
    "Thora busy hun, aik minute baad dobara message karna 🙂"
)


class AI:
    """
    Fast multi-provider AI router.

    Text queue:
    Groq -> Cerebras -> Gemini Flash -> Gemini Flash-Lite -> OpenRouter.

    A provider that returns quota, timeout, server, or auth errors is put on a
    cooldown and the next provider is tried immediately. Technical errors never
    go to WhatsApp users.
    """

    def __init__(self):
        self.gemini = GeminiAI()
        self.providers = []
        self.groq_audio = self._create_groq_audio_client()

        # Groq is first because it is the quickest successful provider in
        # this bot's current free setup.
        self._add_openai_provider(
            name="Groq GPT-OSS 20B",
            env_name="GROQ_API_KEY",
            base_url="https://api.groq.com/openai/v1",
            model=GROQ_MODEL,
        )

        self._add_openai_provider(
            name="Cerebras GPT-OSS 120B",
            env_name="CEREBRAS_API_KEY",
            base_url="https://api.cerebras.ai/v1",
            model=CEREBRAS_MODEL,
        )

        self.providers.append({
            "name": "Gemini 3.5 Flash",
            "kind": "gemini",
            "model": GEMINI_MODEL,
            "blocked_until": 0.0,
        })

        self.providers.append({
            "name": "Gemini 3.1 Flash-Lite",
            "kind": "gemini",
            "model": GEMINI_FAST_MODEL,
            "blocked_until": 0.0,
        })

        self._add_openai_provider(
            name="OpenRouter Free Router",
            env_name="OPENROUTER_API_KEY",
            base_url="https://openrouter.ai/api/v1",
            model=OPENROUTER_MODEL,
            headers={
                "HTTP-Referer": "https://localhost",
                "X-OpenRouter-Title": "WhatsApp AI Bot",
            },
        )

        enabled = ", ".join(
            provider["name"]
            for provider in self.providers
        )

        print(f"AI Router Ready: {enabled}")

    def _create_groq_audio_client(self):
        api_key = os.getenv("GROQ_API_KEY", "").strip()

        if not api_key:
            return None

        if Groq is None:
            print(
                "AI Router: Groq voice fallback skipped "
                "(install package: python -m pip install -U groq)"
            )

            return None

        return Groq(api_key=api_key)

    def _add_openai_provider(
        self,
        name,
        env_name,
        base_url,
        model,
        headers=None,
    ):
        api_key = os.getenv(env_name, "").strip()

        if not api_key:
            print(f"AI Router: {name} skipped ({env_name} missing)")
            return

        if OpenAI is None:
            print(
                f"AI Router: {name} skipped "
                "(install package: python -m pip install -U openai)"
            )
            return

        client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=AI_REQUEST_TIMEOUT_SECONDS,
            max_retries=0,
            default_headers=headers or {},
        )

        self.providers.append({
            "name": name,
            "kind": "openai",
            "model": model,
            "client": client,
            "blocked_until": 0.0,
        })

    @staticmethod
    def _extract_content(response):
        choices = getattr(response, "choices", None) or []

        if not choices:
            return ""

        content = getattr(
            choices[0].message,
            "content",
            "",
        ) or ""

        if isinstance(content, list):
            content = "".join(
                str(part.get("text", ""))
                if isinstance(part, dict)
                else str(part)
                for part in content
            )

        return str(content).strip()

    def _call_openai_provider(self, provider, prompt):
        response = provider["client"].chat.completions.create(
            model=provider["model"],
            messages=[
                {
                    "role": "system",
                    "content": PORTAL_SYSTEM_PROMPT(),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            temperature=0.55,
            max_tokens=AI_MAX_OUTPUT_TOKENS,
        )

        reply = self._extract_content(response)

        if not reply:
            raise ValueError("Provider returned an empty response.")

        return reply

    def _call_provider(self, provider, prompt):
        if provider["kind"] == "gemini":
            return self.gemini.generate_reply(
                prompt,
                model=provider["model"],
            )

        return self._call_openai_provider(
            provider,
            prompt,
        )

    @staticmethod
    def _cooldown_seconds(error):
        text = str(error).lower()

        if "429" in text or "resource_exhausted" in text:
            match = re.search(
                r"retry(?:delay| after)?[^0-9]*(\d+)",
                text,
            )

            if match:
                return max(15, min(int(match.group(1)) + 2, 300))

            return 60

        if "402" in text or "payment_required" in text:
            # This provider needs billing; skip it for the rest of the day.
            return 86400

        if "401" in text or "403" in text or "api key" in text:
            return 3600

        if "timeout" in text or "timed out" in text:
            return 30

        return 20

    def generate_reply(self, message):
        now = time.monotonic()

        for provider in self.providers:
            if now < provider["blocked_until"]:
                remaining = int(
                    provider["blocked_until"] - now
                )

                print(
                    f"AI Router: {provider['name']} skipped "
                    f"({remaining}s cooldown)"
                )

                continue

            started_at = time.monotonic()

            try:
                reply = self._call_provider(
                    provider,
                    message,
                )

                elapsed = time.monotonic() - started_at

                print(
                    f"AI Router: {provider['name']} replied "
                    f"in {elapsed:.1f}s"
                )

                return reply

            except Exception as error:
                cooldown = self._cooldown_seconds(error)
                provider["blocked_until"] = (
                    time.monotonic() + cooldown
                )

                short_error = " ".join(
                    str(error).split()
                )[:180]

                print(
                    f"AI Router: {provider['name']} failed; "
                    f"next provider in queue. "
                    f"Cooldown {cooldown}s. Error: {short_error}"
                )

        print(
            "AI Router: all providers unavailable; "
            "using safe fallback reply."
        )

        return SAFE_FALLBACK_REPLY

    # ---------------------------------
    # Voice Transcription Failover
    # ---------------------------------
    def _transcribe_with_groq(self, audio_path):
        if self.groq_audio is None:
            return ""

        try:
            with open(audio_path, "rb") as audio_file:
                transcription = self.groq_audio.audio.transcriptions.create(
                    file=(
                        Path(audio_path).name,
                        audio_file.read(),
                    ),
                    model=GROQ_TRANSCRIPTION_MODEL,
                    prompt=(
                        "Transcribe Urdu and English speech accurately. "
                        "Output only spoken words."
                    ),
                    response_format="json",
                    temperature=0.0,
                )

            transcript = (
                getattr(transcription, "text", "")
                or ""
            ).strip()

            if transcript:
                print(
                    "Voice Router: Groq Whisper transcription succeeded"
                )

            return transcript

        except Exception as error:
            print(
                f"Voice Router: Groq Whisper failed: "
                f"{type(error).__name__}: {error}"
            )

            return ""

    def transcribe_voice(self, audio_path):
        # Groq Whisper is first because it is fast and avoids Gemini quota.
        transcript = self._transcribe_with_groq(audio_path)

        if transcript:
            return transcript

        print("Voice Router: falling back to Gemini transcription")
        return self.gemini.transcribe_voice(audio_path)

    # ---------------------------------
    # Voice TTS Failover
    # ---------------------------------
    def _generate_groq_voice(self, reply_text):
        if self.groq_audio is None:
            return ""

        wav_path = None

        try:
            audio_dir = Path(AUDIO_TEMP_DIR)
            audio_dir.mkdir(parents=True, exist_ok=True)

            file_id = uuid.uuid4().hex
            wav_path = audio_dir / f"groq_reply_{file_id}.wav"
            ogg_path = audio_dir / f"groq_reply_{file_id}.ogg"

            # Groq's current Arabic voice is the closest available cloud
            # fallback for Urdu/Roman Urdu if Gemini TTS is unavailable.
            response = self.groq_audio.audio.speech.create(
                model=GROQ_TTS_MODEL,
                voice=GROQ_TTS_VOICE,
                input=reply_text[:200],
                response_format="wav",
            )

            response.write_to_file(str(wav_path))
            self.gemini._convert_wav_to_opus(
                wav_path,
                ogg_path,
            )

            if wav_path.exists():
                wav_path.unlink()

            print("Voice Router: Groq TTS fallback succeeded")

            return str(ogg_path)

        except Exception as error:
            print(
                f"Voice Router: Groq TTS failed: "
                f"{type(error).__name__}: {error}"
            )

            if wav_path and wav_path.exists():
                wav_path.unlink()

            return ""

    async def _save_edge_voice(self, reply_text, output_path):
        communicate = edge_tts.Communicate(
            text=reply_text,
            voice=EDGE_TTS_VOICE,
            rate="+0%",
        )

        await communicate.save(str(output_path))

    def _generate_edge_voice(self, reply_text):
        """Free Pakistani male preset voice; no API key or local model."""
        if edge_tts is None:
            print(
                "Voice Router: Edge TTS skipped "
                "(install package: python -m pip install -U edge-tts)"
            )
            return ""

        mp3_path = None

        try:
            audio_dir = Path(AUDIO_TEMP_DIR)
            audio_dir.mkdir(parents=True, exist_ok=True)

            file_id = uuid.uuid4().hex
            mp3_path = audio_dir / f"edge_reply_{file_id}.mp3"
            ogg_path = audio_dir / f"edge_reply_{file_id}.ogg"

            asyncio.run(
                self._save_edge_voice(reply_text, mp3_path)
            )

            self.gemini._convert_wav_to_opus(
                mp3_path,
                ogg_path,
            )

            if mp3_path.exists():
                mp3_path.unlink()

            print(
                f"Voice Router: Edge TTS succeeded ({EDGE_TTS_VOICE})"
            )

            return str(ogg_path)

        except Exception as error:
            print(
                f"Voice Router: Edge TTS failed: "
                f"{type(error).__name__}: {error}"
            )

            if mp3_path and mp3_path.exists():
                mp3_path.unlink()

            return ""

    def generate_voice_reply(self, reply_text):
        # Free Pakistani male preset first. It avoids Gemini TTS quota.
        voice_path = self._generate_edge_voice(reply_text)

        if voice_path:
            return voice_path

        voice_path = self.gemini.generate_voice_reply(reply_text)

        if voice_path:
            return voice_path

        return self._generate_groq_voice(reply_text)

    def delete_temp_file(self, file_path):
        self.gemini.delete_temp_file(file_path)