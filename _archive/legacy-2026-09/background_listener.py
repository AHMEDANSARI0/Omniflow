import time
from logger import Logger


class BackgroundListener:

    def __init__(self, bot):

        self.bot = bot
        self.logger = Logger()
        self.last_message = None

    def start(self):

        self.logger.log("Background Listener Started")

        while True:

            try:

                message = self.bot.read_last_message()

                if message and message != self.last_message:

                    self.last_message = message

                    self.logger.log(
                        f"New Message Detected: {message}"
                    )

                    return message

                time.sleep(2)

            except Exception as e:

                self.logger.log(f"Listener Error: {e}")

                time.sleep(2)