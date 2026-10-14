from playwright.sync_api import sync_playwright

print("VERSION 2 RUNNING")

with sync_playwright() as p:

    browser = p.chromium.launch(headless=False)

    page = browser.new_page()

    page.goto("https://google.com")

    print(page.title())

    browser.close()