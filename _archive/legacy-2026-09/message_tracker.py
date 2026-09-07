import json
import os


class MessageTracker:

    def __init__(self, file_path="data/last_messages.json"):

        self.file_path = file_path

        if not os.path.exists(self.file_path):

            with open(self.file_path, "w", encoding="utf-8") as file:

                json.dump({}, file, indent=4)

    def load(self):

        with open(self.file_path, "r", encoding="utf-8") as file:

            return json.load(file)

    def save(self, data):

        with open(self.file_path, "w", encoding="utf-8") as file:

            json.dump(data, file, indent=4, ensure_ascii=False)

    def is_new_message(self, user, message):

        data = self.load()

        last_message = data.get(user)

        if last_message == message:
            return False

        data[user] = message

        self.save(data)

        return True

    def clear(self):

        self.save({})