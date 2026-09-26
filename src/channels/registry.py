from threading import RLock
from typing import Callable, Dict

from .contracts import ChannelAccount, ChannelAdapter


AdapterFactory = Callable[
    [ChannelAccount],
    ChannelAdapter,
]


class AdapterRegistry:
    """Thread-safe platform-to-adapter factory registry."""

    def __init__(self):
        self._factories: Dict[str, AdapterFactory] = {}
        self._lock = RLock()

    @staticmethod
    def _normalize_platform(platform):
        normalized = str(
            platform or ""
        ).strip().lower()

        if not normalized:
            raise ValueError(
                "Platform name is required"
            )

        return normalized

    def register(
        self,
        platform,
        factory,
        replace=False
    ):
        platform = self._normalize_platform(
            platform
        )

        if not callable(factory):
            raise TypeError(
                "Adapter factory must be callable"
            )

        with self._lock:
            if (
                platform in self._factories
                and not replace
            ):
                raise ValueError(
                    f"Adapter already registered: {platform}"
                )

            self._factories[platform] = factory

    def unregister(self, platform):
        platform = self._normalize_platform(
            platform
        )

        with self._lock:
            self._factories.pop(
                platform,
                None
            )

    def create(
        self,
        account: ChannelAccount
    ) -> ChannelAdapter:
        platform = self._normalize_platform(
            account.platform
        )

        with self._lock:
            factory = self._factories.get(
                platform
            )

        if factory is None:
            raise LookupError(
                f"No adapter registered for platform: {platform}"
            )

        adapter = factory(account)

        if not isinstance(adapter, ChannelAdapter):
            raise TypeError(
                "Adapter factory returned an invalid object"
            )

        if adapter.account.id != account.id:
            raise ValueError(
                "Adapter account does not match requested account"
            )

        return adapter

    def registered_platforms(self):
        with self._lock:
            return tuple(
                sorted(self._factories)
            )
