import os
import socket
from dataclasses import dataclass
from uuid import uuid4

from ai import AI
from channels import (
    ChannelEvent,
    OutboundMessage,
)
from memory import Memory


VOICE_REPLY_LANGUAGE_POLICY = (
    "\n\nVoice reply language policy:\n"
    "The latest customer message is a voice-note transcript. Determine "
    "the language from that latest transcript, not from older conversation "
    "history.\n"
    "- If it is English or mainly English, reply only in natural English.\n"
    "- If it is Urdu or mainly Urdu, including Roman Urdu, reply only in "
    "natural Pakistani Roman Urdu using Latin letters. Never use Urdu/Arabic "
    "or Devanagari script.\n"
    "- If it is mixed, follow the dominant language of the latest transcript; "
    "if genuinely unclear, use Roman Urdu.\n"
    "Return only the customer-facing answer. Do not mention language detection "
    "or transcription."
)


@dataclass(frozen=True)
class RecoveredReplyDispatch:
    source_event: ChannelEvent
    outbound: OutboundMessage


def build_ai_user_content(
    platform,
    history,
    event
):
    voice_language_policy = (
        VOICE_REPLY_LANGUAGE_POLICY
        if event.message_type == "audio"
        else ""
    )

    return (
        "Channel platform:\n"
        f"{platform}\n\n"
        "Recent conversation:\n"
        f"{history}\n\n"
        "Latest customer message:\n"
        f"{event.content}"
        f"{voice_language_policy}"
    )


class ConversationManager:
    """Platform-neutral AI conversation processor."""

    def __init__(
        self,
        ai=None,
        memory=None,
        worker_id=None
    ):
        self.ai = ai or AI()
        self.memory = memory or Memory()
        self.worker_id = (
            worker_id
            or (
                f"{socket.gethostname()}:"
                f"{os.getpid()}:"
                f"{uuid4().hex[:8]}"
            )
        )

    def process_event(
        self,
        event: ChannelEvent
    ):
        if not isinstance(event, ChannelEvent):
            raise TypeError(
                "process_event requires a ChannelEvent"
            )

        history = self.memory.get_last_messages(
            event.channel_account_id,
            event.external_user_id,
            limit=5
        )

        self.memory.save_user_message(
            event.channel_account_id,
            event.external_user_id,
            event.content,
            external_message_id=(
                event.external_message_id
            ),
            message_type=event.message_type,
            metadata=dict(event.metadata),
            display_name=event.display_name
        )

        claim = self.memory.claim_reply_job(
            event.channel_account_id,
            event.external_user_id,
            event.external_message_id,
            worker_id=self.worker_id
        )

        if claim is None:
            raise RuntimeError(
                "Inbound message exists without a reply job"
            )

        if claim["action"] in {
            "skip",
            "retry_later",
        }:
            print(
                "Reply job not dispatched: "
                f"job={claim['job_id']}, "
                f"action={claim['action']}, "
                f"status={claim['status']}"
            )
            return None

        context = self.memory.get_channel_context(
            event.channel_account_id,
            event.external_user_id
        )

        if context is None:
            raise RuntimeError(
                "Channel context could not be resolved"
            )

        if claim["action"] == "send_cached":
            reply = claim["reply_text"]

        else:
            user_content = build_ai_user_content(
                context["platform"],
                history,
                event
            )

            try:
                reply = self.ai.generate_reply(
                    user_content
                )
                reply = (reply or "").strip()

                if not reply:
                    raise RuntimeError(
                        "AI provider returned an empty reply"
                    )

                self.memory.save_ai_reply_and_mark_ready(
                    event.channel_account_id,
                    event.external_user_id,
                    claim["job_id"],
                    self.worker_id,
                    reply,
                    message_type="text",
                    metadata={
                        "source_platform": context["platform"],
                        "source_message_type": (
                            event.message_type
                        ),
                    }
                )

            except Exception as error:
                self.memory.mark_reply_generation_failed(
                    claim["job_id"],
                    self.worker_id,
                    error
                )
                raise

        return OutboundMessage(
            channel_account_id=(
                event.channel_account_id
            ),
            external_user_id=(
                event.external_user_id
            ),
            content=reply,
            message_type="text",
            reply_to_external_message_id=(
                event.external_message_id
            ),
            metadata={
                "reply_job_id": claim["job_id"],
                "client_id": context["client_id"],
                "customer_id": context["customer_id"],
                "platform": context["platform"],
                "target_display_name": event.display_name,
                "cached_reply": (
                    claim["action"] == "send_cached"
                ),
            }
        )

    def recover_due_reply(
        self,
        channel_account_id,
        external_user_id=None
    ):
        """
        Claim and prepare one due persisted reply without an adapter replay.

        This is the restart path for pending, failed, reply-ready, and stale
        processing jobs. A cached reply is delivered without another AI call.
        """
        claim = self.memory.claim_next_due_reply_job(
            channel_account_id,
            worker_id=self.worker_id,
            external_user_id=external_user_id
        )

        if claim is None:
            return None

        event_metadata = dict(
            claim["inbound_metadata"]
        )
        event_metadata["recovered_reply_job"] = True

        event = ChannelEvent(
            channel_account_id=channel_account_id,
            external_user_id=(
                claim["external_user_id"]
            ),
            external_message_id=(
                claim["external_message_id"]
            ),
            content=claim["content"],
            message_type=claim["message_type"],
            event_type="message",
            display_name=claim["display_name"],
            metadata=event_metadata,
        )

        context = {
            "client_id": claim["client_id"],
            "platform": claim["platform"],
            "customer_id": claim["customer_id"],
        }

        if claim["action"] == "send_cached":
            reply = str(
                claim["reply_text"] or ""
            ).strip()

            if not reply:
                error = RuntimeError(
                    "Recovered cached reply is empty"
                )
                self.memory.mark_reply_generation_failed(
                    claim["job_id"],
                    self.worker_id,
                    error
                )
                raise error

        else:
            history = self.memory.get_last_messages(
                channel_account_id,
                event.external_user_id,
                limit=5
            )
            user_content = build_ai_user_content(
                context["platform"],
                history,
                event
            )

            try:
                reply = self.ai.generate_reply(
                    user_content
                )
                reply = (reply or "").strip()

                if not reply:
                    raise RuntimeError(
                        "AI provider returned an empty reply"
                    )

                self.memory.save_ai_reply_and_mark_ready(
                    channel_account_id,
                    event.external_user_id,
                    claim["job_id"],
                    self.worker_id,
                    reply,
                    message_type="text",
                    metadata={
                        "source_platform": context["platform"],
                        "source_message_type": (
                            event.message_type
                        ),
                        "recovered_reply_job": True,
                    }
                )

            except Exception as error:
                self.memory.mark_reply_generation_failed(
                    claim["job_id"],
                    self.worker_id,
                    error
                )
                raise

        outbound = OutboundMessage(
            channel_account_id=channel_account_id,
            external_user_id=event.external_user_id,
            content=reply,
            message_type="text",
            reply_to_external_message_id=(
                event.external_message_id
            ),
            metadata={
                "reply_job_id": claim["job_id"],
                "client_id": context["client_id"],
                "customer_id": context["customer_id"],
                "platform": context["platform"],
                "target_display_name": event.display_name,
                "cached_reply": (
                    claim["action"] == "send_cached"
                ),
                "recovered_reply_job": True,
                "previous_job_status": (
                    claim["previous_status"]
                ),
            }
        )

        return RecoveredReplyDispatch(
            source_event=event,
            outbound=outbound
        )

    # Compatibility helper for non-adapter callers during migration.
    def process(
        self,
        channel_account_id,
        external_user_id,
        content,
        external_message_id,
        message_type="text",
        metadata=None
    ):
        event = ChannelEvent(
            channel_account_id=channel_account_id,
            external_user_id=external_user_id,
            external_message_id=external_message_id,
            content=content,
            message_type=message_type,
            metadata=metadata or {}
        )

        outbound = self.process_event(event)

        if outbound is None:
            return None

        return outbound.content

    def close(self):
        self.memory.close()
