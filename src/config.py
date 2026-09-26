import os

from dotenv import load_dotenv


load_dotenv()


# ==========================================
# WhatsApp AI Bot Configuration
# ==========================================

# Project Root Folder
BASE_DIR = os.path.dirname(
    os.path.dirname(
        os.path.abspath(__file__)
    )
)

# Database ID of the WhatsApp account used by this bot process.
_whatsapp_account_id = os.getenv(
    "WHATSAPP_ACCOUNT_ID",
    ""
).strip()

if _whatsapp_account_id:
    try:
        WHATSAPP_ACCOUNT_ID = int(
            _whatsapp_account_id
        )

    except ValueError as error:
        raise RuntimeError(
            "WHATSAPP_ACCOUNT_ID must be a valid integer"
        ) from error

else:
    WHATSAPP_ACCOUNT_ID = None

# Each database WhatsApp account receives its own persistent browser session.
# This allows multiple bot processes to run without sharing login state.
_whatsapp_session_path = os.getenv(
    "WHATSAPP_SESSION_PATH",
    ""
).strip()

if _whatsapp_session_path:
    if os.path.isabs(_whatsapp_session_path):
        SESSION_PATH = _whatsapp_session_path
    else:
        SESSION_PATH = os.path.join(
            BASE_DIR,
            _whatsapp_session_path
        )

elif WHATSAPP_ACCOUNT_ID is not None:
    SESSION_PATH = os.path.join(
        BASE_DIR,
        "whatsapp_sessions",
        f"account_{WHATSAPP_ACCOUNT_ID}"
    )

else:
    # main.py will reject a missing account ID before starting the browser.
    SESSION_PATH = os.path.join(
        BASE_DIR,
        "whatsapp_sessions",
        "unassigned"
    )

# Temporary voice input/output files
AUDIO_TEMP_DIR = os.path.join(
    BASE_DIR,
    "temp_audio"
)

# WhatsApp Web URL
WHATSAPP_URL = "https://web.whatsapp.com"

# Default Test Contact
CONTACT_NAME = "W"

# Default Test Message
TEST_MESSAGE = "Hello from my AI Bot"

# Browser Settings
HEADLESS = False

# Wait Times (milliseconds)
PAGE_LOAD_WAIT = 5000
SEARCH_WAIT = 2000
CHAT_LOAD_WAIT = 1000

# ==========================================
# Fast AI Router Configuration
# ==========================================

# Provider API keys stay in environment variables.
# Never put API keys in this file.

# Gemini models
GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.5-flash"
)

GEMINI_FAST_MODEL = os.getenv(
    "GEMINI_FAST_MODEL",
    "gemini-3.1-flash-lite"
)

# Gemini voice output
GEMINI_TTS_MODEL = os.getenv(
    "GEMINI_TTS_MODEL",
    "gemini-3.1-flash-tts-preview"
)

GEMINI_TTS_VOICE = os.getenv(
    "GEMINI_TTS_VOICE",
    "Puck"
)

# Free online Pakistani male preset voice. This is not a personal clone.
EDGE_TTS_VOICE = os.getenv(
    "EDGE_TTS_VOICE",
    "ur-PK-AsadNeural"
)

# OpenAI-compatible fallback provider model IDs.
GROQ_MODEL = os.getenv(
    "GROQ_MODEL",
    "openai/gpt-oss-20b"
)

# Groq voice fallback models.
GROQ_TRANSCRIPTION_MODEL = os.getenv(
    "GROQ_TRANSCRIPTION_MODEL",
    "whisper-large-v3-turbo"
)

GROQ_TTS_MODEL = os.getenv(
    "GROQ_TTS_MODEL",
    "canopylabs/orpheus-arabic-saudi"
)

GROQ_TTS_VOICE = os.getenv(
    "GROQ_TTS_VOICE",
    "fahad"
)

CEREBRAS_MODEL = os.getenv(
    "CEREBRAS_MODEL",
    "gpt-oss-120b"
)

OPENROUTER_MODEL = os.getenv(
    "OPENROUTER_MODEL",
    "openrouter/free"
)

# Keep short WhatsApp replies fast.
AI_REQUEST_TIMEOUT_SECONDS = 6
AI_MAX_OUTPUT_TOKENS = 80

# Set False for near-instant replies. Change to True later if you want
# a very short human-like typing animation.
TYPING_ENABLED = False

MEMORY_LIMIT = 6
DEBUG = True
    