from .contracts import (
    ChannelAccount,
    ChannelAdapter,
    ChannelEvent,
    DeliveryResult,
    OutboundMessage,
)
from .registry import AdapterRegistry


__all__ = [
    "AdapterRegistry",
    "ChannelAccount",
    "ChannelAdapter",
    "ChannelEvent",
    "DeliveryResult",
    "OutboundMessage",
    "WhatsAppWebAdapter",
]


def __getattr__(name):
    """
    Load optional platform adapters lazily.

    Generic core imports must continue working even when a platform-specific
    adapter or one of its optional dependencies is unavailable.
    """
    if name == "WhatsAppWebAdapter":
        from .whatsapp_web import WhatsAppWebAdapter

        return WhatsAppWebAdapter

    raise AttributeError(
        f"module {__name__!r} has no attribute {name!r}"
    )
