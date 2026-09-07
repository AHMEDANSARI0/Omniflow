# import time

# from whatsapp import WhatsAppBot
# from conversation import ConversationManager
# from config import (
#     SESSION_PATH,
#     WHATSAPP_ACCOUNT_ID,
#     WHATSAPP_URL,
# )


# class WhatsAppAssistant:
#     POLL_INTERVAL_MS = 1500
#     UNREAD_RETRY_DELAY_SECONDS = 5

#     def __init__(self):
#         if WHATSAPP_ACCOUNT_ID is None:
#             raise RuntimeError(
#                 "WHATSAPP_ACCOUNT_ID is missing. "
#                 "Add it to your .env file."
#             )

#         self.whatsapp_account_id = WHATSAPP_ACCOUNT_ID
#         self.bot = WhatsAppBot(SESSION_PATH)
#         self.conversation = ConversationManager()

#         # {stable chat identifier: latest message ID already seen}
#         self.last_seen_message_id = {}

#         # WhatsApp's React data can temporarily omit the JID after rerenders.
#         # Reuse a previously verified identity only while the same visual chat
#         # remains active. A newly opened unread chat must resolve itself.
#         self.active_chat_name = ""
#         self.active_chat_identifier = ""

#         # Prevent WhatsApp's unread badge from causing the same still-loading
#         # chat to be clicked again every polling cycle.
#         self.unread_retry_after = 0.0

#     def _set_active_chat_identity(
#         self,
#         chat_name,
#         chat_identifier
#     ):
#         self.active_chat_name = chat_name
#         self.active_chat_identifier = chat_identifier

#     def _remember_current_last_message(self, chat_identifier):
#         latest = self.bot.get_latest_chat_message(
#             fallback_chat_identifier=chat_identifier
#         )

#         if latest:
#             self.last_seen_message_id[
#                 chat_identifier
#             ] = latest["id"]

#     def _prime_active_chat(self):
#         """Ignore the old message that was already open at startup."""
#         chat_name = self.bot.get_current_chat_name()
#         latest = self.bot.get_latest_chat_message()

#         if not chat_name or not latest:
#             return

#         message_id = latest["id"]
#         chat_identifier = (
#             latest.get("chat_identifier")
#             or ""
#         ).strip()

#         if not chat_identifier:
#             # Mark this unidentified message so the warning does not repeat
#             # on every polling cycle.
#             fallback_key = f"unidentified:{chat_name}"
#             self.last_seen_message_id[fallback_key] = message_id

#             print(
#                 "Could not extract a stable WhatsApp identifier "
#                 f"for active chat: {chat_name}"
#             )
#             return

#         self._set_active_chat_identity(
#             chat_name,
#             chat_identifier
#         )

#         self.last_seen_message_id[
#             chat_identifier
#         ] = message_id

#         print(
#             f"Watching active chat: {chat_name} "
#             f"[{chat_identifier}]"
#         )

#     def _remember_after_reply(self, chat_identifier):
#         """Remember the bot's own newly sent text or voice message."""
#         self.bot.page.wait_for_timeout(800)
#         self._remember_current_last_message(
#             chat_identifier
#         )

#     def _handle_text_message(
#         self,
#         chat_name,
#         chat_identifier,
#         message_id,
#         message
#     ):
#         reply = self.conversation.process(
#             self.whatsapp_account_id,
#             chat_identifier,
#             message,
#             whatsapp_message_id=message_id
#         )

#         if reply is None:
#             print(
#                 "Persistent duplicate protection skipped "
#                 f"message: {message_id}"
#             )
#             return

#         self.bot.send_message(reply)
#         self._remember_after_reply(
#             chat_identifier
#         )

#     def _handle_voice_message(
#         self,
#         chat_name,
#         chat_identifier,
#         message_id
#     ):
#         print("Voice note detected. Downloading audio...")

#         voice_input_path = self.bot.download_latest_voice_note(
#             message_id
#         )

#         if not voice_input_path:
#             self.bot.send_message(
#                 "Maazrat, voice note read nahi ho saki. "
#                 "Please text mein bhej dein."
#             )

#             self._remember_after_reply(
#                 chat_identifier
#             )
#             return

#         try:
#             transcript = self.conversation.ai.transcribe_voice(
#                 voice_input_path
#             )

#         finally:
#             self.conversation.ai.delete_temp_file(
#                 voice_input_path
#             )

#         if not transcript:
#             self.bot.send_message(
#                 "Maazrat, voice note samajh nahi aayi. "
#                 "Dobara thori clear bhej dein."
#             )

#             self._remember_after_reply(
#                 chat_identifier
#             )
#             return

#         print(f"Voice Transcript: {transcript}")

#         reply = self.conversation.process(
#             self.whatsapp_account_id,
#             chat_identifier,
#             transcript,
#             whatsapp_message_id=message_id
#         )

#         if reply is None:
#             print(
#                 "Persistent duplicate protection skipped voice "
#                 f"message: {message_id}"
#             )
#             return

#         voice_reply_path = self.conversation.ai.generate_voice_reply(
#             reply
#         )

#         if not voice_reply_path:
#             # Safe fallback if the TTS preview API is temporarily unavailable.
#             self.bot.send_message(reply)
#             self._remember_after_reply(
#                 chat_identifier
#             )
#             return

#         try:
#             sent = self.bot.send_voice_message(
#                 voice_reply_path
#             )

#         finally:
#             self.conversation.ai.delete_temp_file(
#                 voice_reply_path
#             )

#         if not sent:
#             # Do not lose a valid AI answer if WhatsApp upload fails.
#             self.bot.send_message(reply)

#         self._remember_after_reply(
#             chat_identifier
#         )

#     def _process_new_last_message(
#         self,
#         allow_cached_identity=True
#     ):
#         """
#         Text input -> text reply
#         Voice note input -> Gemini transcription -> voice reply

#         WhatsApp can temporarily omit the JID/LID after a React rerender. For
#         the same continuously active chat, a previously verified identifier is
#         safe to reuse. The fallback is disabled immediately after opening an
#         unread chat so a different contact can never inherit the old identity.
#         """
#         chat_name = self.bot.get_current_chat_name()

#         if not chat_name:
#             return False

#         verified_fallback = ""

#         if (
#             allow_cached_identity
#             and self.active_chat_identifier
#             and self.active_chat_name == chat_name
#         ):
#             verified_fallback = self.active_chat_identifier

#         latest = self.bot.get_latest_chat_message(
#             fallback_chat_identifier=verified_fallback
#         )

#         if not latest:
#             return False

#         message_id = latest["id"]

#         # The bot's own outgoing message was already recorded by
#         # _remember_after_reply(). Ignore it even if WhatsApp temporarily
#         # stopped exposing the chat identifier.
#         if message_id in self.last_seen_message_id.values():
#             return False

#         chat_identifier = (
#             latest.get("chat_identifier")
#             or ""
#         ).strip()

#         if chat_identifier:
#             self._set_active_chat_identity(
#                 chat_name,
#                 chat_identifier
#             )

#         elif (
#             allow_cached_identity
#             and self.active_chat_identifier
#             and self.active_chat_name == chat_name
#         ):
#             chat_identifier = self.active_chat_identifier

#             print(
#                 "WhatsApp identity temporarily unavailable; "
#                 f"using verified active-chat ID: {chat_identifier}"
#             )

#         else:
#             fallback_key = f"unidentified:{chat_name}"

#             if (
#                 self.last_seen_message_id.get(
#                     fallback_key
#                 )
#                 == message_id
#             ):
#                 return False

#             self.last_seen_message_id[
#                 fallback_key
#             ] = message_id

#             print(
#                 "Skipped message because no verified WhatsApp "
#                 f"identifier was available for: {chat_name}"
#             )
#             return False

#         if (
#             self.last_seen_message_id.get(
#                 chat_identifier
#             )
#             == message_id
#         ):
#             return False

#         # Mark first to prevent duplicate replies while processing.
#         self.last_seen_message_id[
#             chat_identifier
#         ] = message_id

#         if latest["kind"] == "voice":
#             print(f"\nNew Voice Note From: {chat_name}")
#             print(f"Chat Identifier: {chat_identifier}")

#             self._handle_voice_message(
#                 chat_name,
#                 chat_identifier,
#                 message_id
#             )

#         else:
#             message = latest["text"]

#             print(f"\nNew Message From: {chat_name}")
#             print(f"Chat Identifier: {chat_identifier}")
#             print(f"Message: {message}")

#             self._handle_text_message(
#                 chat_name,
#                 chat_identifier,
#                 message_id,
#                 message
#             )

#         return True

#     def run(self):
#         self.bot.start()
#         self.bot.open_whatsapp(WHATSAPP_URL)

#         print("\nAI Assistant Running...\n")
#         print(
#             f"WhatsApp Account ID: {self.whatsapp_account_id}"
#         )
#         print(
#             "Text -> text reply | Voice note -> voice reply\n"
#         )

#         self._prime_active_chat()

#         try:
#             while True:
#                 # Always check active chat first. WhatsApp instantly marks an
#                 # open chat as read, so unread badges cannot detect it.
#                 active_message_processed = (
#                     self._process_new_last_message()
#                 )

#                 if active_message_processed:
#                     self.unread_retry_after = 0.0

#                 now = time.monotonic()

#                 if now >= self.unread_retry_after:
#                     unread_chat = self.bot.find_unread_chat()

#                     if unread_chat and self.bot.open_chat(unread_chat):
#                         # A newly opened chat must provide its own verified
#                         # JID/LID; never reuse the previous contact identity.
#                         unread_message_processed = (
#                             self._process_new_last_message(
#                                 allow_cached_identity=False
#                             )
#                         )

#                         if unread_message_processed:
#                             self.unread_retry_after = 0.0
#                         else:
#                             # Let the newly opened React tree finish loading
#                             # before considering another click on the badge.
#                             self.unread_retry_after = (
#                                 time.monotonic()
#                                 + self.UNREAD_RETRY_DELAY_SECONDS
#                             )

#                 self.bot.page.wait_for_timeout(
#                     self.POLL_INTERVAL_MS
#                 )

#         except KeyboardInterrupt:
#             print("\nStopping AI Assistant...")

#         finally:
#             try:
#                 self.conversation.memory.close()
#             finally:
#                 self.bot.stop()


# if __name__ == "__main__":
#     assistant = WhatsAppAssistant()
#     assistant.run()


"""Disabled legacy launcher.

The production runtime is account-scoped and adapter-based. Keeping the old
direct WhatsApp loop executable would bypass distributed leases, generic reply
recovery, and supervisor lifecycle controls.
"""


LEGACY_LAUNCHER_DISABLED = True


def main():
    print(
        "Legacy src/main.py launcher is disabled. "
        "From the project root use: python run_channel.py "
        "<channel_account_id>"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

