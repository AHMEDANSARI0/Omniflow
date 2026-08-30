import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import (  # noqa: E402
    AdapterRegistry,
    ChannelAccount,
    ChannelAdapter,
    ChannelEvent,
    DeliveryResult,
    OutboundMessage,
)


PLATFORMS = (
    "whatsapp",
    "instagram",
    "facebook",
    "telegram",
)


class FakeAdapter(ChannelAdapter):
    def normalize_event(self, raw_payload):
        return ChannelEvent(
            channel_account_id=self.account.id,
            external_user_id=raw_payload["user_id"],
            external_message_id=raw_payload["message_id"],
            content=raw_payload["content"],
            message_type=raw_payload.get(
                "message_type",
                "text"
            ),
            metadata={
                "normalized_by": self.platform,
                "client_id": self.account.client_id,
            }
        )

    def send(self, message):
        if (
            message.channel_account_id
            != self.account.id
        ):
            return DeliveryResult(
                success=False,
                error="Channel account mismatch"
            )

        return DeliveryResult(
            success=True,
            external_message_id=(
                f"{self.platform}-out-"
                f"{self.account.id}"
            ),
            metadata={
                "client_id": self.account.client_id,
            }
        )


def main():
    registry = AdapterRegistry()

    for platform in PLATFORMS:
        registry.register(
            platform,
            lambda account: FakeAdapter(account)
        )

    assert registry.registered_platforms() == tuple(
        sorted(PLATFORMS)
    )

    # Simulate 1,000 dynamic clients. No client or channel account ID is
    # hardcoded in the registry or adapter implementation.
    accounts = []

    for client_id in range(1, 1001):
        platform = PLATFORMS[
            (client_id - 1) % len(PLATFORMS)
        ]

        accounts.append(
            ChannelAccount(
                id=10000 + client_id,
                client_id=client_id,
                platform=platform,
                external_account_id=(
                    f"{platform}-account-{client_id}"
                ),
                account_name=(
                    f"Client {client_id} {platform}"
                ),
                status="active",
            )
        )

    normalized_events = 0
    successful_deliveries = 0

    for account in accounts:
        adapter = registry.create(account)

        event = adapter.normalize_event(
            {
                "user_id": f"user-{account.client_id}",
                "message_id": (
                    f"message-{account.id}"
                ),
                "content": (
                    f"Hello from client "
                    f"{account.client_id}"
                ),
            }
        )

        assert (
            event.channel_account_id
            == account.id
        )
        assert (
            event.metadata["client_id"]
            == account.client_id
        )
        assert (
            event.metadata["normalized_by"]
            == account.platform
        )

        normalized_events += 1

        result = adapter.send(
            OutboundMessage(
                channel_account_id=account.id,
                external_user_id=(
                    f"user-{account.client_id}"
                ),
                content="Automated reply",
                reply_to_external_message_id=(
                    event.external_message_id
                ),
            )
        )

        assert result.success is True
        assert result.external_message_id
        assert (
            result.metadata["client_id"]
            == account.client_id
        )

        successful_deliveries += 1

    assert normalized_events == 1000
    assert successful_deliveries == 1000

    print("Registered platforms:")

    for platform in registry.registered_platforms():
        print(f"  - {platform}")

    print(f"Dynamic clients tested: {len(accounts)}")
    print(f"Normalized events: {normalized_events}")
    print(f"Successful deliveries: {successful_deliveries}")
    print("\nCHANNEL CONTRACT TEST PASSED")


if __name__ == "__main__":
    main()
