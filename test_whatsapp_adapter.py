import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import (  # noqa: E402
    ChannelAccount,
    OutboundMessage,
    WhatsAppWebAdapter,
)


class FakePage:
    def wait_for_timeout(self, milliseconds):
        return None


class FakeWhatsAppBot:
    def __init__(self):
        self.page = FakePage()
        self.started = False
        self.opened_url = None
        self.current_chat_name = "Test Customer"
        self.current_message = {
            "id": "old-message",
            "chat_identifier": "lid:test-customer",
            "text": "Old startup message",
            "kind": "text",
        }
        self.sent_messages = []
        self.sent_voice_paths = []
        self.searched_contacts = []
        self.outbound_counter = 0

    def start(self):
        self.started = True

    def open_whatsapp(self, url):
        self.opened_url = url

    def stop(self):
        self.started = False

    def get_current_chat_name(self):
        return self.current_chat_name

    def get_latest_chat_message(
        self,
        fallback_chat_identifier=""
    ):
        result = dict(self.current_message)

        if (
            not result.get("chat_identifier")
            and fallback_chat_identifier
        ):
            result["chat_identifier"] = (
                fallback_chat_identifier
            )

        return result

    def search_contact(self, contact_name):
        self.searched_contacts.append(
            contact_name
        )
        self.current_chat_name = contact_name

    def find_unread_chat(self):
        return None

    def open_chat(self, chat):
        return True

    def send_message(self, content):
        self.sent_messages.append(content)
        self.outbound_counter += 1
        self.current_message = {
            "id": f"outbound-{self.outbound_counter}",
            "chat_identifier": "lid:test-customer",
            "text": content,
            "kind": "text",
        }
        return True

    def send_voice_message(self, audio_path):
        self.sent_voice_paths.append(audio_path)
        self.outbound_counter += 1
        self.current_message = {
            "id": f"outbound-{self.outbound_counter}",
            "chat_identifier": "lid:test-customer",
            "text": "",
            "kind": "voice",
        }
        return True


def main():
    account = ChannelAccount(
        id=77,
        client_id=9001,
        platform="whatsapp",
        external_account_id="923000000000",
        account_name="Dynamic WhatsApp Account",
        status="active",
    )

    fake_bot = FakeWhatsAppBot()
    adapter = WhatsAppWebAdapter(
        account=account,
        session_path=(
            PROJECT_ROOT
            / "whatsapp_sessions"
            / "account_77"
        ),
        bot=fake_bot,
    )

    adapter.start()

    assert fake_bot.started is True
    assert fake_bot.opened_url == (
        "https://web.whatsapp.com"
    )

    # Startup message must be primed, not emitted as a new event.
    assert tuple(adapter.poll_events()) == ()

    fake_bot.current_message = {
        "id": "incoming-1",
        "chat_identifier": "lid:test-customer",
        "text": "Hello from WhatsApp",
        "kind": "text",
    }

    events = tuple(adapter.poll_events())

    assert len(events) == 1
    event = events[0]
    assert event.channel_account_id == 77
    assert event.external_user_id == (
        "lid:test-customer"
    )
    assert event.external_message_id == (
        "incoming-1"
    )
    assert event.message_type == "text"
    assert event.content == "Hello from WhatsApp"

    # Same external message must not be emitted twice in this runtime.
    assert tuple(adapter.poll_events()) == ()

    # Simulate a restart where WhatsApp opened without a verified active-chat
    # identity. Display name may locate a candidate, but stable LID verification
    # is still mandatory before delivery.
    adapter.active_chat_identifier = ""
    adapter.active_chat_name = ""

    text_result = adapter.send(
        OutboundMessage(
            channel_account_id=77,
            external_user_id="lid:test-customer",
            content="Hello from the automation core",
            message_type="text",
            reply_to_external_message_id=(
                event.external_message_id
            ),
            metadata={
                "target_display_name": "Test Customer",
            },
        )
    )

    assert text_result.success is True
    assert fake_bot.searched_contacts == [
        "Test Customer"
    ]
    assert text_result.external_message_id == (
        "outbound-1"
    )
    assert fake_bot.sent_messages == [
        "Hello from the automation core"
    ]

    # A same-name search candidate with the wrong stable identity must never
    # receive the recovered message.
    adapter.active_chat_identifier = ""
    adapter.active_chat_name = ""
    fake_bot.current_message = {
        "id": "wrong-chat-message",
        "chat_identifier": "lid:wrong-customer",
        "text": "Wrong same-name chat",
        "kind": "text",
    }
    rejected_result = adapter.send(
        OutboundMessage(
            channel_account_id=77,
            external_user_id="lid:test-customer",
            content="Must not be delivered",
            message_type="text",
            metadata={
                "target_display_name": "Test Customer",
            },
        )
    )
    assert rejected_result.success is False
    assert fake_bot.sent_messages == [
        "Hello from the automation core"
    ]

    fake_bot.current_message = {
        "id": "outbound-1",
        "chat_identifier": "lid:test-customer",
        "text": "Hello from the automation core",
        "kind": "text",
    }
    adapter._set_active_chat_identity(
        "Test Customer",
        "lid:test-customer"
    )

    # Adapter remembered its own outbound message, so it is not emitted back
    # into the core as a new inbound event.
    assert tuple(adapter.poll_events()) == ()

    voice_event = adapter.normalize_event(
        {
            "id": "incoming-voice-1",
            "chat_identifier": "lid:test-customer",
            "chat_name": "Test Customer",
            "text": "",
            "kind": "voice",
        }
    )

    assert voice_event.message_type == "audio"
    assert (
        voice_event.metadata["voice_message_id"]
        == "incoming-voice-1"
    )

    audio_path = str(
        PROJECT_ROOT / "fake-reply.ogg"
    )
    voice_result = adapter.send(
        OutboundMessage(
            channel_account_id=77,
            external_user_id="lid:test-customer",
            content="Voice reply",
            message_type="audio",
            metadata={
                "audio_path": audio_path,
            },
        )
    )

    assert voice_result.success is True
    assert voice_result.external_message_id == (
        "outbound-2"
    )
    assert fake_bot.sent_voice_paths == [
        audio_path
    ]

    adapter.stop()
    assert fake_bot.started is False

    print("Channel account ID: 77")
    print("Client ID: 9001")
    print("Platform: whatsapp")
    print("Inbound text normalized: 1")
    print("Inbound voice normalized: 1")
    print("Outbound text delivered: 1")
    print("Outbound voice delivered: 1")
    print("Recovery target opened and LID-verified: 1")
    print("Wrong same-name identity rejected: 1")
    print("Runtime duplicate suppressed: 1")
    print("\n✅ WHATSAPP ADAPTER TEST PASSED")


if __name__ == "__main__":
    main()
