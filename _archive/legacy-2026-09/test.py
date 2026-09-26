from playwright.sync_api import sync_playwright

CONTACT_NAME = "Aqib Bhai UT"   # Apna exact contact name
MESSAGE = "Hello from my AI Bot"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir="./whatsapp_session",
        headless=False
    )

    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://web.whatsapp.com")

    # WhatsApp load hone ka wait
    page.wait_for_timeout(5000)

    # Search box
    search = page.get_by_role(
        "textbox",
        name="Search or start a new chat"
    )

    search.click()
    search.fill(CONTACT_NAME)

    # Search results ka wait
    page.wait_for_timeout(2000)

    # Contact open
    page.get_by_text(CONTACT_NAME).first.click()

    # Chat load hone ka wait
    page.wait_for_timeout(1000)

    # Message box
    message_box = page.get_by_test_id("conversation-compose-box-input")

    message_box.click()
    message_box.fill(MESSAGE)

    # Send button
    page.get_by_role("button", name="Send").click()

    print("Message Sent Successfully!")

    input("Press Enter to exit...")