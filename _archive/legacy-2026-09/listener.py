import time


class MessageListener:

    def __init__(self, bot):
        self.bot = bot
        self.last_message = None

    def start(self):

        print("\n==============================")
        print("Message Listener Started")
        print("==============================")
        print("Waiting for new messages...\n")

        while True:

            try:

                current_message = self.bot.read_last_message()

                if current_message is None:
                    time.sleep(1)
                    continue

                # First run: sirf last message yaad rakho
                if self.last_message is None:
                    self.last_message = current_message

                # Agar message change hua hai
                elif current_message != self.last_message:

                    print("\n==============================")
                    print("NEW MESSAGE DETECTED")
                    print("==============================")
                    print(current_message)
                    print("==============================\n")

                    self.last_message = current_message

                # CPU kam use ho
                time.sleep(1)

            except KeyboardInterrupt:
                print("\nListener stopped.")
                break

            except Exception as e:
                print(f"\nListener Error: {e}")
                time.sleep(2)