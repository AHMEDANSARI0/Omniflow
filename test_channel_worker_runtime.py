import sys
import threading
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import (  # noqa: E402
    ChannelEvent,
    DeliveryResult,
    OutboundMessage,
)
import run_channel as channel_runtime  # noqa: E402
from conversation import (  # noqa: E402
    RecoveredReplyDispatch,
    build_ai_user_content,
)
from run_channel import (  # noqa: E402
    deliver_outbound,
    recover_due_reply_jobs,
    transcribe_media_event,
)


class FakeAI:
    def __init__(self):
        self.deleted_paths = []
        self.voice_generation_calls = 0

    def transcribe_voice(self, media_path):
        assert media_path == "fake-input.ogg"
        return "Transcribed customer voice"

    def generate_voice_reply(self, content):
        self.voice_generation_calls += 1
        raise AssertionError(
            "Text reply mode must not generate outbound voice audio"
        )

    def delete_temp_file(self, path):
        self.deleted_paths.append(path)


class FakeMemory:
    def __init__(self):
        self.sent = []
        self.failed = []

    def mark_reply_sent(
        self,
        job_id,
        outbound_external_message_id=None
    ):
        self.sent.append(
            (
                job_id,
                outbound_external_message_id,
            )
        )
        return True

    def mark_reply_delivery_failed(
        self,
        job_id,
        error,
        retry_after_seconds=30
    ):
        self.failed.append(
            (
                job_id,
                error,
                retry_after_seconds,
            )
        )
        return True


class FakeManager:
    def __init__(self):
        self.ai = FakeAI()
        self.memory = FakeMemory()


class FakeRecoveryManager(FakeManager):
    def __init__(self, dispatches):
        super().__init__()
        self.dispatches = list(dispatches)
        self.recovery_calls = 0

    def recover_due_reply(
        self,
        channel_account_id
    ):
        assert channel_account_id == 55
        self.recovery_calls += 1

        if not self.dispatches:
            return None

        return self.dispatches.pop(0)


class FakeAdapter:
    def __init__(self):
        self.sent_types = []

    def download_media(self, event):
        assert event.message_type == "audio"
        return "fake-input.ogg"

    def send(self, outbound):
        self.sent_types.append(
            outbound.message_type
        )
        return DeliveryResult(
            success=True,
            external_message_id=(
                f"delivered-{outbound.message_type}"
            )
        )


class FakeLifecycleAdapter:
    def __init__(self):
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def poll_events(self):
        return ()

    def stop(self):
        self.stopped = True


class FakeLifecycleManager:
    def __init__(self):
        self.closed = False
        self.recovery_scans = 0

    def recover_due_reply(
        self,
        channel_account_id
    ):
        assert channel_account_id == 55
        self.recovery_scans += 1
        return None

    def close(self):
        self.closed = True


def verify_graceful_stop_cleanup():
    lifecycle_adapter = FakeLifecycleAdapter()
    lifecycle_manager = FakeLifecycleManager()
    stop_event = threading.Event()

    old_create_adapter = channel_runtime.create_adapter
    old_manager_class = channel_runtime.ConversationManager
    old_poll_interval = channel_runtime.POLL_INTERVAL_SECONDS

    channel_runtime.create_adapter = (
        lambda account: lifecycle_adapter
    )
    channel_runtime.ConversationManager = (
        lambda: lifecycle_manager
    )
    channel_runtime.POLL_INTERVAL_SECONDS = 0.02

    # Use the worker's injectable stop event instead of sending a real SIGINT
    # to the test process. On Windows/Python 3.13, os.kill(..., SIGINT) can
    # terminate the interpreter before assertions and cleanup logs are emitted.
    timer = threading.Timer(
        0.08,
        stop_event.set
    )

    try:
        timer.start()
        channel_runtime.run_worker(
            SimpleNamespace(
                id=55,
                client_id=7,
                platform="whatsapp",
                account_name="Fake lifecycle account",
            ),
            stop_event=stop_event,
        )
    finally:
        timer.cancel()
        channel_runtime.create_adapter = (
            old_create_adapter
        )
        channel_runtime.ConversationManager = (
            old_manager_class
        )
        channel_runtime.POLL_INTERVAL_SECONDS = (
            old_poll_interval
        )

    assert lifecycle_adapter.started is True
    assert lifecycle_adapter.stopped is True
    assert lifecycle_manager.closed is True
    assert lifecycle_manager.recovery_scans >= 1


def main():
    adapter = FakeAdapter()
    manager = FakeManager()

    audio_event = ChannelEvent(
        channel_account_id=55,
        external_user_id="external-user-55",
        external_message_id="external-message-55",
        content="",
        message_type="audio",
    )

    prepared_event = transcribe_media_event(
        adapter,
        manager,
        audio_event
    )

    assert prepared_event.content == (
        "Transcribed customer voice"
    )
    assert prepared_event.metadata[
        "transcribed"
    ] is True
    assert "fake-input.ogg" in (
        manager.ai.deleted_paths
    )

    voice_prompt = build_ai_user_content(
        "whatsapp",
        [],
        prepared_event
    )
    assert "reply only in natural English" in (
        voice_prompt
    )
    assert "Pakistani Roman Urdu" in voice_prompt
    assert "using Latin letters" in voice_prompt
    assert "not from older conversation history" in (
        voice_prompt
    )

    text_prompt = build_ai_user_content(
        "whatsapp",
        [],
        ChannelEvent(
            channel_account_id=55,
            external_user_id="external-user-55",
            external_message_id="text-message-55",
            content="Normal text message",
            message_type="text",
        )
    )
    assert "Voice reply language policy" not in (
        text_prompt
    )

    outbound = OutboundMessage(
        channel_account_id=55,
        external_user_id="external-user-55",
        content="Automation reply",
        message_type="text",
        reply_to_external_message_id=(
            audio_event.external_message_id
        ),
        metadata={
            "reply_job_id": 999,
        }
    )

    delivered = deliver_outbound(
        adapter,
        manager,
        prepared_event,
        outbound
    )

    assert delivered is True
    assert adapter.sent_types == ["text"]
    assert manager.memory.sent == [
        (999, "delivered-text")
    ]
    assert manager.memory.failed == []
    assert manager.ai.voice_generation_calls == 0
    assert manager.ai.deleted_paths == [
        "fake-input.ogg"
    ]

    recovery_event = ChannelEvent(
        channel_account_id=55,
        external_user_id="recovery-user-55",
        external_message_id="recovery-message-55",
        content="Persisted inbound content",
        message_type="text",
        metadata={
            "recovered_reply_job": True,
        },
    )
    recovery_outbound = OutboundMessage(
        channel_account_id=55,
        external_user_id="recovery-user-55",
        content="Persisted cached answer",
        message_type="text",
        reply_to_external_message_id=(
            "recovery-message-55"
        ),
        metadata={
            "reply_job_id": 1001,
            "previous_job_status": "reply_ready",
            "cached_reply": True,
            "recovered_reply_job": True,
        },
    )
    recovery_manager = FakeRecoveryManager(
        [
            RecoveredReplyDispatch(
                source_event=recovery_event,
                outbound=recovery_outbound,
            )
        ]
    )
    recovery_adapter = FakeAdapter()
    recovery_result = recover_due_reply_jobs(
        recovery_adapter,
        recovery_manager,
        SimpleNamespace(id=55),
        max_jobs=5,
    )

    assert recovery_result == {
        "recovered": 1,
        "delivered": 1,
        "batch_full": False,
    }
    assert recovery_manager.recovery_calls == 2
    assert recovery_adapter.sent_types == ["text"]
    assert recovery_manager.memory.sent == [
        (1001, "delivered-text")
    ]
    assert recovery_manager.ai.voice_generation_calls == 0

    verify_graceful_stop_cleanup()

    print("Dynamic channel account: 55")
    print("Inbound audio transcribed: 1")
    print("Outbound text delivered: 1")
    print("Outbound voice generation calls: 0")
    print("Voice language policy verified: English/Roman Urdu")
    print("Due reply recovered without inbound polling: 1")
    print("Recovered cached reply delivered: 1")
    print("Reply jobs marked sent: 2")
    print("Temporary inbound media cleaned: 1")
    print("Graceful stop-event cleanup: 1")
    print("\nCHANNEL WORKER RUNTIME TEST PASSED")


if __name__ == "__main__":
    main()
