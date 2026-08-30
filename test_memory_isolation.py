from src.memory import Memory


ACCOUNT_1_ID = 1
ACCOUNT_4_ID = 4

# Same user/phone for both WhatsApp accounts
TEST_USER = "production_test_92345"


memory = Memory()

try:
    # Account 1 messages
    memory.save_user_message(
        ACCOUNT_1_ID,
        TEST_USER,
        "Hello from account 1"
    )

    memory.save_ai_message(
        ACCOUNT_1_ID,
        TEST_USER,
        "Reply from account 1"
    )

    # Account 4 messages
    memory.save_user_message(
        ACCOUNT_4_ID,
        TEST_USER,
        "Hello from account 4"
    )

    memory.save_ai_message(
        ACCOUNT_4_ID,
        TEST_USER,
        "Reply from account 4"
    )

    account_1_history = memory.get_last_messages(
        ACCOUNT_1_ID,
        TEST_USER,
        limit=10
    )

    account_4_history = memory.get_last_messages(
        ACCOUNT_4_ID,
        TEST_USER,
        limit=10
    )

    print("\nACCOUNT 1 HISTORY:")
    print(account_1_history)

    print("\nACCOUNT 4 HISTORY:")
    print(account_4_history)

    account_1_text = str(account_1_history)
    account_4_text = str(account_4_history)

    assert "Hello from account 1" in account_1_text
    assert "Hello from account 4" not in account_1_text

    assert "Hello from account 4" in account_4_text
    assert "Hello from account 1" not in account_4_text

    print("\n MEMORY ISOLATION TEST PASSED")

finally:
    memory.close()