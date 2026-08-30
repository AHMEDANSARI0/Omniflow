from datetime import datetime
import os


class Logger:

    def __init__(self):

        os.makedirs("logs", exist_ok=True)

        self.log_file = os.path.join(
            "logs",
            f"{datetime.now().strftime('%Y-%m-%d')}.log"
        )

    def log(self, message):

        time = datetime.now().strftime("%H:%M:%S")

        text = f"[{time}] {message}"

        print(text)

        with open(self.log_file, "a", encoding="utf-8") as file:
            file.write(text + "\n")