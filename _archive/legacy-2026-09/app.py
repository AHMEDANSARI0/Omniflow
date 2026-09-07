# from whatsapp import WhatsAppBot
# from conversation import ConversationManager
# from config import SESSION_PATH, WHATSAPP_URL


# class WhatsAppAssistant:
#     POLL_INTERVAL_MS = 1500

#     def __init__(self):
#         self.bot = WhatsAppBot(SESSION_PATH)
#         self.conversation = ConversationManager()

#         # {chat_name: latest message ID already seen in that chat}
#         self.last_seen_message_id = {}

#     def _remember_current_last_message(self, chat_name):
#         latest = self.bot.get_latest_chat_message()

#         if latest:
#             self.last_seen_message_id[chat_name] = latest["id"]

#     def _prime_active_chat(self):
#         """Ignore the old message that was already open at startup."""
#         chat_name = self.bot.get_current_chat_name()

#         if not chat_name:
#             return

#         self._remember_current_last_message(chat_name)

#         print(
#             f"Watching active chat: {chat_name}"
#         )

#     def _remember_after_reply(self, chat_name):
#         """Remember the bot's own newly sent text or voice message."""
#         self.bot.page.wait_for_timeout(800)
#         self._remember_current_last_message(chat_name)

#     def _handle_text_message(self, chat_name, message):
#         reply = self.conversation.process(
#             chat_name,
#             message
#         )

#         self.bot.send_message(reply)
#         self._remember_after_reply(chat_name)

#     def _handle_voice_message(self, chat_name, message_id):
#         print("Voice note detected. Downloading audio...")

#         voice_input_path = self.bot.download_latest_voice_note(
#             message_id
#         )

#         if not voice_input_path:
#             self.bot.send_message(
#                 "Maazrat, voice note read nahi ho saki. "
#                 "Please text mein bhej dein."
#             )

#             self._remember_after_reply(chat_name)
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

#             self._remember_after_reply(chat_name)
#             return

#         print(f"Voice Transcript: {transcript}")

#         reply = self.conversation.process(
#             chat_name,
#             transcript
#         )

#         voice_reply_path = self.conversation.ai.generate_voice_reply(
#             reply
#         )

#         if not voice_reply_path:
#             # Safe fallback if the TTS preview API is temporarily unavailable.
#             self.bot.send_message(reply)
#             self._remember_after_reply(chat_name)
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

#         self._remember_after_reply(chat_name)

#     def _process_new_last_message(self):
#         """
#         Text input -> text reply
#         Voice note input -> Gemini transcription -> voice reply
#         """
#         chat_name = self.bot.get_current_chat_name()
#         latest = self.bot.get_latest_chat_message()

#         if not chat_name or not latest:
#             return False

#         message_id = latest["id"]

#         if self.last_seen_message_id.get(chat_name) == message_id:
#             return False

#         # Mark first to prevent duplicate replies while processing.
#         self.last_seen_message_id[chat_name] = message_id

#         if latest["kind"] == "voice":
#             print(f"\nNew Voice Note From: {chat_name}")

#             self._handle_voice_message(
#                 chat_name,
#                 message_id
#             )

#         else:
#             message = latest["text"]

#             print(f"\nNew Message From: {chat_name}")
#             print(f"Message: {message}")

#             self._handle_text_message(
#                 chat_name,
#                 message
#             )

#         return True

#     def run(self):
#         self.bot.start()
#         self.bot.open_whatsapp(WHATSAPP_URL)

#         print("\nAI Assistant Running...\n")
#         print(
#             "Text -> text reply | Voice note -> voice reply\n"
#         )

#         self._prime_active_chat()

#         try:
#             while True:
#                 # Always check active chat first. WhatsApp instantly marks an
#                 # open chat as read, so unread badges cannot detect it.
#                 self._process_new_last_message()

#                 unread_chat = self.bot.find_unread_chat()

#                 if unread_chat and self.bot.open_chat(unread_chat):
#                     self._process_new_last_message()

#                 self.bot.page.wait_for_timeout(
#                     self.POLL_INTERVAL_MS
#                 )

#         except KeyboardInterrupt:
#             print("\nStopping AI Assistant...")

#         finally:
#             self.bot.stop()


# if __name__ == "__main__":
#     assistant = WhatsAppAssistant()
#     assistant.run()


"""Disabled legacy compatibility entry point.

Use the generic account-scoped launcher from the project root.
"""

try:
    from .main import main
except ImportError:
    from main import main


LEGACY_LAUNCHER_DISABLED = True


if __name__ == "__main__":
    raise SystemExit(main())
