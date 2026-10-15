import time
from pathlib import Path
from typing import Iterable, Optional

from .contracts import (
    ChannelAccount,
    ChannelAdapter,
    ChannelEvent,
    DeliveryResult,
    OutboundMessage,
)


class WhatsAppWebAdapter(ChannelAdapter):
    """
    WhatsApp Web/Playwright plugin for the generic channel contract.

    The automation core sees only ChannelEvent, OutboundMessage, and
    DeliveryResult. WhatsApp DOM/session behavior remains isolated here.
    """

    UNREAD_RETRY_DELAY_SECONDS = 5

    def __init__(
        self,
        account: ChannelAccount,
        session_path,
        whatsapp_url="https://web.whatsapp.com",
        bot=None
    ):
        super().__init__(account)

        if self.platform != "whatsapp":
            raise ValueError(
                "WhatsAppWebAdapter requires platform='whatsapp'"
            )

        self.session_path = str(
            Path(session_path)
        )
        self.whatsapp_url = whatsapp_url

        if bot is None:
            # Lazy import keeps the generic core and unit tests independent of
            # Playwright unless the WhatsApp adapter is actually instantiated.
            from whatsapp import WhatsAppBot

            bot = WhatsAppBot(
                self.session_path
            )

        self.bot = bot
        self.started = False

        self.last_seen_message_id = {}
        self.seen_message_ids = set()
        self.seen_message_order = []
        self.active_chat_name = ""
        self.active_chat_identifier = ""
        self.unread_retry_after = 0.0

    # ---------------------------------
    # Lifecycle
    # ---------------------------------

    def start(self):
        if self.started:
            return

        self.bot.start()
        self.bot.open_whatsapp(
            self.whatsapp_url
        )
        self.started = True
        self._prime_active_chat()

    def stop(self):
        if not self.started:
            return

        try:
            self.bot.stop()
        finally:
            self.started = False

    # ---------------------------------
    # Event Normalization
    # ---------------------------------

    def normalize_event(self, raw_payload):
        if not isinstance(raw_payload, dict):
            raise TypeError(
                "WhatsApp payload must be a dictionary"
            )

        kind = str(
            raw_payload.get("kind", "text")
        ).strip().lower()

        message_type = (
            "audio"
            if kind == "voice"
            else "text"
        )

        return ChannelEvent(
            channel_account_id=self.account.id,
            external_user_id=(
                raw_payload.get("chat_identifier")
                or ""
            ),
            external_message_id=(
                raw_payload.get("id")
                or ""
            ),
            content=(
                raw_payload.get("text")
                or ""
            ),
            message_type=message_type,
            event_type="message",
            display_name=raw_payload.get(
                "chat_name"
            ),
            metadata={
                "platform": "whatsapp",
                "raw_kind": kind,
                "raw_direction": raw_payload.get(
                    "direction",
                    "unknown"
                ),
                "voice_message_id": (
                    raw_payload.get("id")
                    if kind == "voice"
                    else None
                ),
            }
        )

    # ---------------------------------
    # Current Chat Identity
    # ---------------------------------

    def _set_active_chat_identity(
        self,
        chat_name,
        chat_identifier
    ):
        self.active_chat_name = chat_name
        self.active_chat_identifier = (
            chat_identifier
        )

    def _mark_message_seen(
        self,
        message_id
    ):
        message_id = str(
            message_id or ""
        ).strip()

        if not message_id:
            return

        if message_id in self.seen_message_ids:
            return

        self.seen_message_ids.add(message_id)
        self.seen_message_order.append(message_id)

        if len(self.seen_message_order) > 1000:
            oldest = self.seen_message_order.pop(0)
            self.seen_message_ids.discard(oldest)

    def _remember_latest(
        self,
        chat_identifier
    ):
        latest = self.bot.get_latest_chat_message(
            fallback_chat_identifier=(
                chat_identifier
            )
        )

        if latest:
            self.last_seen_message_id[
                chat_identifier
            ] = latest["id"]
            self._mark_message_seen(
                latest["id"]
            )

        return latest

    def _prime_active_chat(self):
        chat_name = self.bot.get_current_chat_name()

        if not chat_name:
            return

        latest = self.bot.get_latest_chat_message()

        if not latest:
            return

        chat_identifier = str(
            latest.get("chat_identifier")
            or ""
        ).strip()

        if not chat_identifier:
            return

        self._set_active_chat_identity(
            chat_name,
            chat_identifier
        )
        self.last_seen_message_id[
            chat_identifier
        ] = latest["id"]
        self._mark_message_seen(
            latest["id"]
        )

    def _read_current_events(
        self,
        allow_cached_identity,
        unread_limit=None
    ):
        """Read every new visible message after the per-chat DOM cursor."""
        chat_name = self.bot.get_current_chat_name()

        if not chat_name:
            return ()

        verified_fallback = ""

        if (
            allow_cached_identity
            and self.active_chat_identifier
            and self.active_chat_name == chat_name
        ):
            verified_fallback = (
                self.active_chat_identifier
            )

        get_visible = getattr(
            self.bot,
            "get_visible_chat_messages",
            None
        )

        get_stable_visible = getattr(
            self.bot,
            "get_stable_visible_chat_messages",
            None
        )

        if (
            unread_limit is not None
            and callable(get_stable_visible)
        ):
            visible_messages = get_stable_visible(
                fallback_chat_identifier=(
                    verified_fallback
                ),
                limit=100
            )
        elif callable(get_visible):
            visible_messages = get_visible(
                fallback_chat_identifier=(
                    verified_fallback
                ),
                limit=100
            )
        else:
            latest = self.bot.get_latest_chat_message(
                fallback_chat_identifier=(
                    verified_fallback
                )
            )
            visible_messages = (
                [latest]
                if latest
                else []
            )

        if not visible_messages:
            return ()

        chat_identifier = ""

        for raw_message in reversed(
            visible_messages
        ):
            candidate_identifier = str(
                raw_message.get("chat_identifier")
                or ""
            ).strip()

            if candidate_identifier:
                chat_identifier = candidate_identifier
                break

        if not chat_identifier:
            return ()

        # Every visible container is inside one active chat. Apply the stable
        # identity resolved from its newest message to temporary React gaps in
        # earlier containers from the same DOM snapshot.
        normalized_visible = []

        for raw_message in visible_messages:
            payload = dict(raw_message)
            payload["chat_identifier"] = (
                str(
                    payload.get("chat_identifier")
                    or chat_identifier
                ).strip()
            )

            if (
                payload["chat_identifier"]
                != chat_identifier
            ):
                continue

            normalized_visible.append(payload)

        if not normalized_visible:
            return ()

        cursor_message_id = (
            self.last_seen_message_id.get(
                chat_identifier
            )
        )
        cursor_index = None

        if cursor_message_id:
            for index in range(
                len(normalized_visible) - 1,
                -1,
                -1
            ):
                if (
                    normalized_visible[index].get("id")
                    == cursor_message_id
                ):
                    cursor_index = index
                    break

        if cursor_index is not None:
            candidates = normalized_visible[
                cursor_index + 1:
            ]
        else:
            unseen_candidates = [
                message
                for message in normalized_visible
                if message.get("id")
                not in self.seen_message_ids
            ]

            if unread_limit is not None:
                try:
                    unread_limit = max(
                        1,
                        int(unread_limit)
                    )
                except (TypeError, ValueError):
                    unread_limit = 1

                # WhatsApp's sidebar sometimes exposes only a binary unread
                # dot and reports count=1 even when several messages arrived.
                # In a chat with prior replies, every unseen inbound container
                # after the newest outbound container belongs to the current
                # unanswered burst. This is safer and more complete than
                # trusting the badge count. Database external-ID idempotency is
                # still the durable guard if a previously handled message is
                # present in the visible snapshot.
                last_outbound_index = None

                for index, message in enumerate(
                    normalized_visible
                ):
                    if message.get(
                        "direction",
                        "unknown"
                    ) == "outbound":
                        last_outbound_index = index

                burst_candidates = []
                selection_reason = "badge-tail"

                if last_outbound_index is not None:
                    burst_candidates = [
                        message
                        for message in normalized_visible[
                            last_outbound_index + 1:
                        ]
                        if (
                            message.get("id")
                            not in self.seen_message_ids
                            and message.get(
                                "direction",
                                "unknown"
                            ) != "outbound"
                        )
                    ]

                if burst_candidates:
                    candidates = burst_candidates
                    selection_reason = "outbound-boundary"
                else:
                    inbound_candidates = [
                        message
                        for message in unseen_candidates
                        if message.get(
                            "direction",
                            "unknown"
                        ) != "outbound"
                    ]
                    present_at_start = [
                        message
                        for message in inbound_candidates
                        if message.get(
                            "present_at_settle_start",
                            True
                        )
                    ]
                    badge_candidates = present_at_start[
                        -unread_limit:
                    ]
                    late_candidates = [
                        message
                        for message in inbound_candidates
                        if message.get(
                            "present_at_settle_start"
                        ) is False
                    ]
                    latest_timestamp = next(
                        (
                            str(
                                message.get(
                                    "timestamp_label"
                                )
                                or ""
                            ).strip()
                            for message in reversed(
                                inbound_candidates
                            )
                            if str(
                                message.get(
                                    "timestamp_label"
                                )
                                or ""
                            ).strip()
                        ),
                        ""
                    )
                    timestamp_candidates = []

                    if latest_timestamp:
                        for message in reversed(
                            inbound_candidates
                        ):
                            timestamp_label = str(
                                message.get(
                                    "timestamp_label"
                                )
                                or ""
                            ).strip()

                            if timestamp_label == latest_timestamp:
                                timestamp_candidates.append(
                                    message
                                )
                            elif timestamp_candidates:
                                break

                        timestamp_candidates.reverse()

                    selected_ids = {
                        str(message.get("id") or "").strip()
                        for message in (
                            badge_candidates
                            + late_candidates
                            + timestamp_candidates
                        )
                        if str(
                            message.get("id")
                            or ""
                        ).strip()
                    }

                    if selected_ids:
                        candidates = [
                            message
                            for message in inbound_candidates
                            if str(
                                message.get("id")
                                or ""
                            ).strip() in selected_ids
                        ]

                        if timestamp_candidates:
                            selection_reason = (
                                "settled-recent-timestamp"
                            )
                        elif late_candidates:
                            selection_reason = (
                                "badge-tail-plus-late"
                            )
                    else:
                        candidates = inbound_candidates[
                            -unread_limit:
                        ]

                direction_counts = {
                    "inbound": 0,
                    "outbound": 0,
                    "unknown": 0,
                }

                for message in normalized_visible:
                    direction = message.get(
                        "direction",
                        "unknown"
                    )

                    if direction not in direction_counts:
                        direction = "unknown"

                    direction_counts[direction] += 1

                print(
                    "WhatsApp unread burst snapshot: "
                    f"visible={len(normalized_visible)}, "
                    f"inbound={direction_counts['inbound']}, "
                    f"outbound={direction_counts['outbound']}, "
                    f"unknown={direction_counts['unknown']}, "
                    "last_outbound_position="
                    + (
                        str(last_outbound_index + 1)
                        if last_outbound_index is not None
                        else "none"
                    )
                    + f", selected={len(candidates)}, "
                    f"strategy={selection_reason}"
                )
            else:
                # For a manually opened/new chat with no prior cursor, preserve
                # startup safety by considering only the newest unseen message.
                candidates = unseen_candidates[-1:]

        self._set_active_chat_identity(
            chat_name,
            chat_identifier
        )
        events = []

        for raw_message in candidates:
            message_id = str(
                raw_message.get("id")
                or ""
            ).strip()

            if not message_id:
                continue

            # Advance and mark before dispatch. Database external-message
            # idempotency remains the durable second line of protection.
            self.last_seen_message_id[
                chat_identifier
            ] = message_id
            already_seen = (
                message_id
                in self.seen_message_ids
            )
            self._mark_message_seen(
                message_id
            )

            if already_seen:
                continue

            if raw_message.get(
                "direction",
                "unknown"
            ) == "outbound":
                continue

            payload = dict(raw_message)
            payload["chat_name"] = chat_name
            payload["chat_identifier"] = (
                chat_identifier
            )
            events.append(
                self.normalize_event(payload)
            )

        return tuple(events)

    # ---------------------------------
    # Polling Input
    # ---------------------------------

    def poll_events(self) -> Iterable[ChannelEvent]:
        if not self.started:
            raise RuntimeError(
                "WhatsApp adapter is not started"
            )

        active_events = self._read_current_events(
            allow_cached_identity=True
        )

        if active_events:
            self.unread_retry_after = 0.0
            return active_events

        now = time.monotonic()

        if now < self.unread_retry_after:
            return ()

        unread_chat = self.bot.find_unread_chat()

        if not unread_chat:
            return ()

        if not self.bot.open_chat(unread_chat):
            self.unread_retry_after = (
                now
                + self.UNREAD_RETRY_DELAY_SECONDS
            )
            return ()

        unread_events = self._read_current_events(
            allow_cached_identity=False,
            unread_limit=getattr(
                self.bot,
                "last_unread_count",
                1
            )
        )

        if not unread_events:
            self.unread_retry_after = (
                time.monotonic()
                + self.UNREAD_RETRY_DELAY_SECONDS
            )
            return ()

        self.unread_retry_after = 0.0
        return unread_events

    # ---------------------------------
    # Media Download
    # ---------------------------------

    def download_media(
        self,
        event: ChannelEvent
    ) -> Optional[str]:
        if event.channel_account_id != self.account.id:
            return None

        if event.message_type != "audio":
            return None

        voice_message_id = event.metadata.get(
            "voice_message_id"
        ) or event.external_message_id

        return self.bot.download_latest_voice_note(
            voice_message_id
        )

    # ---------------------------------
    # Outbound Delivery Routing
    # ---------------------------------

    def _open_and_verify_delivery_target(
        self,
        external_user_id,
        display_name
    ):
        """
        Use a display name only to locate a UI candidate, then require the
        opened chat's stable JID/LID to match before permitting delivery.

        A display name is never accepted as identity and a same-name wrong chat
        is opened at most as a rejected candidate; no message is sent to it.
        """
        display_name = str(
            display_name or ""
        ).strip()

        if not display_name:
            print(
                "WhatsApp recovery routing unavailable: target display "
                "name is missing; stable identity guard remains active"
            )
            return False

        try:
            opened = self.bot.search_contact(
                display_name
            )

            if opened is False:
                print(
                    "WhatsApp recovery target search returned no "
                    "matching sidebar candidate"
                )
                return False

        except Exception as error:
            print(
                "WhatsApp recovery target search failed: "
                f"{error}"
            )
            return False

        for _ in range(6):
            chat_name = self.bot.get_current_chat_name()
            latest = self.bot.get_latest_chat_message()

            if latest:
                resolved_identifier = str(
                    latest.get("chat_identifier")
                    or ""
                ).strip()

                if resolved_identifier:
                    self._set_active_chat_identity(
                        chat_name or display_name,
                        resolved_identifier
                    )
                    self.last_seen_message_id[
                        resolved_identifier
                    ] = latest["id"]

                    if (
                        resolved_identifier
                        == external_user_id
                    ):
                        print(
                            "WhatsApp recovery target verified: "
                            f"{resolved_identifier}"
                        )
                        return True

                    print(
                        "WhatsApp recovery target rejected: "
                        f"expected={external_user_id}, "
                        f"resolved={resolved_identifier}"
                    )
                    return False

            if getattr(self.bot, "page", None):
                self.bot.page.wait_for_timeout(500)
            else:
                time.sleep(0.5)

        return False

    # ---------------------------------
    # Outbound Delivery
    # ---------------------------------

    def send(
        self,
        message: OutboundMessage
    ) -> DeliveryResult:
        if not self.started:
            return DeliveryResult(
                success=False,
                error="WhatsApp adapter is not started"
            )

        if (
            message.channel_account_id
            != self.account.id
        ):
            return DeliveryResult(
                success=False,
                error="Channel account mismatch"
            )

        if (
            self.active_chat_identifier
            != message.external_user_id
        ):
            self._open_and_verify_delivery_target(
                message.external_user_id,
                message.metadata.get(
                    "target_display_name"
                )
            )

        if not self.active_chat_identifier:
            return DeliveryResult(
                success=False,
                error=(
                    "No verified active WhatsApp chat identity is available"
                )
            )

        if (
            self.active_chat_identifier
            != message.external_user_id
        ):
            return DeliveryResult(
                success=False,
                error=(
                    "Target WhatsApp chat is not currently active"
                )
            )

        try:
            if message.message_type == "text":
                sent = self.bot.send_message(
                    message.content
                )

            elif message.message_type == "audio":
                audio_path = message.metadata.get(
                    "audio_path"
                )

                if not audio_path:
                    return DeliveryResult(
                        success=False,
                        error=(
                            "audio_path metadata is required "
                            "for WhatsApp audio delivery"
                        )
                    )

                sent = self.bot.send_voice_message(
                    audio_path
                )

            else:
                return DeliveryResult(
                    success=False,
                    error=(
                        "WhatsApp Web adapter does not yet support "
                        f"outbound type: {message.message_type}"
                    )
                )

            if not sent:
                return DeliveryResult(
                    success=False,
                    error="WhatsApp delivery returned false"
                )

            if getattr(self.bot, "page", None):
                self.bot.page.wait_for_timeout(800)

            latest = self._remember_latest(
                message.external_user_id
            )

            return DeliveryResult(
                success=True,
                external_message_id=(
                    latest.get("id")
                    if latest
                    else None
                ),
                metadata={
                    "platform": "whatsapp",
                    "delivery_mode": "web_automation",
                }
            )

        except Exception as error:
            return DeliveryResult(
                success=False,
                error=str(error),
                metadata={
                    "platform": "whatsapp",
                }
            )
