from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Mapping, Optional


SUPPORTED_MESSAGE_TYPES = {
    "text",
    "audio",
    "image",
    "video",
    "document",
    "location",
    "contact",
    "interactive",
    "event",
}


@dataclass(frozen=True)
class ChannelAccount:
    """Database-backed tenant/channel account configuration."""

    id: int
    client_id: int
    platform: str
    external_account_id: str
    account_name: str
    status: str = "active"
    metadata: Mapping[str, Any] = field(
        default_factory=dict
    )

    def __post_init__(self):
        platform = str(self.platform or "").strip().lower()
        external_account_id = str(
            self.external_account_id or ""
        ).strip()

        if self.id <= 0:
            raise ValueError(
                "Channel account ID must be positive"
            )

        if self.client_id <= 0:
            raise ValueError(
                "Client ID must be positive"
            )

        if not platform:
            raise ValueError(
                "Channel platform is required"
            )

        if not external_account_id:
            raise ValueError(
                "External account ID is required"
            )

        object.__setattr__(self, "platform", platform)
        object.__setattr__(
            self,
            "external_account_id",
            external_account_id
        )


@dataclass(frozen=True)
class ChannelEvent:
    """Normalized inbound event emitted by any platform adapter."""

    channel_account_id: int
    external_user_id: str
    external_message_id: str
    content: str
    message_type: str = "text"
    event_type: str = "message"
    display_name: Optional[str] = None
    occurred_at: Optional[datetime] = None
    metadata: Mapping[str, Any] = field(
        default_factory=dict
    )

    def __post_init__(self):
        external_user_id = str(
            self.external_user_id or ""
        ).strip()
        external_message_id = str(
            self.external_message_id or ""
        ).strip()
        message_type = str(
            self.message_type or ""
        ).strip().lower()

        if self.channel_account_id <= 0:
            raise ValueError(
                "channel_account_id must be positive"
            )

        if not external_user_id:
            raise ValueError(
                "external_user_id is required"
            )

        if not external_message_id:
            raise ValueError(
                "external_message_id is required"
            )

        if message_type not in SUPPORTED_MESSAGE_TYPES:
            raise ValueError(
                f"Unsupported message type: {message_type}"
            )

        if self.content is None:
            raise ValueError(
                "Event content cannot be None"
            )

        object.__setattr__(
            self,
            "external_user_id",
            external_user_id
        )
        object.__setattr__(
            self,
            "external_message_id",
            external_message_id
        )
        object.__setattr__(
            self,
            "message_type",
            message_type
        )


@dataclass(frozen=True)
class OutboundMessage:
    """Platform-neutral reply produced by the automation core."""

    channel_account_id: int
    external_user_id: str
    content: str
    message_type: str = "text"
    reply_to_external_message_id: Optional[str] = None
    metadata: Mapping[str, Any] = field(
        default_factory=dict
    )

    def __post_init__(self):
        message_type = str(
            self.message_type or ""
        ).strip().lower()

        if self.channel_account_id <= 0:
            raise ValueError(
                "channel_account_id must be positive"
            )

        if not str(self.external_user_id or "").strip():
            raise ValueError(
                "external_user_id is required"
            )

        if self.content is None:
            raise ValueError(
                "Outbound content cannot be None"
            )

        if message_type not in SUPPORTED_MESSAGE_TYPES:
            raise ValueError(
                f"Unsupported message type: {message_type}"
            )

        object.__setattr__(
            self,
            "message_type",
            message_type
        )


@dataclass(frozen=True)
class DeliveryResult:
    """Normalized result returned by every platform adapter send call."""

    success: bool
    external_message_id: Optional[str] = None
    error: Optional[str] = None
    metadata: Mapping[str, Any] = field(
        default_factory=dict
    )


class ChannelAdapter(ABC):
    """
    Contract implemented by WhatsApp, Instagram, Facebook, Telegram, etc.

    Webhook-based adapters normally call normalize_event from an HTTP handler.
    Polling/browser adapters may also implement poll_events.
    """

    def __init__(self, account: ChannelAccount):
        if account.status.lower() != "active":
            raise ValueError(
                f"Channel account {account.id} is not active"
            )

        self.account = account

    @property
    def platform(self):
        return self.account.platform

    def start(self):
        """Optional lifecycle hook for browser/socket-based adapters."""

    def stop(self):
        """Optional lifecycle hook for browser/socket-based adapters."""

    @abstractmethod
    def normalize_event(
        self,
        raw_payload: Any
    ) -> ChannelEvent:
        """Convert a platform payload into one normalized ChannelEvent."""

    @abstractmethod
    def send(
        self,
        message: OutboundMessage
    ) -> DeliveryResult:
        """Deliver one normalized outbound message through the platform."""

    def poll_events(self) -> Iterable[ChannelEvent]:
        """
        Optional pull interface for browser/polling adapters.

        Webhook adapters do not need to override this method.
        """
        return ()

    def download_media(
        self,
        event: ChannelEvent
    ) -> Optional[str]:
        """
        Optional media materialization hook.

        Returns a temporary local path when the adapter must download media
        before the automation core can transcribe or inspect it.
        """
        return None
