from src.memory import Memory


memory = Memory()

test_user = "production_test_92345"

memory.save_message(
    test_user,
    "user",
    "Hello, this is a PostgreSQL test."
)

memory.save_message(
    test_user,
    "assistant",
    "Hello! PostgreSQL memory is working."
)

history = memory.get_last_messages(
    test_user,
    limit=5
)

print("\n===== MEMORY TEST =====")

for item in history:
    print(item)

memory.close()