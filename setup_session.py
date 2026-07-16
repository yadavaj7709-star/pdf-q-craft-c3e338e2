import os
import sys
from playwright.sync_api import sync_playwright

PROFILE_DIR = "C:/Users/Ajay.AJAY/.gemini/antigravity/scratch/chrome_profile"
SCREENSHOT_DIR = "C:/Users/Ajay.AJAY/.gemini/antigravity/brain/fb5a0422-59c7-457a-b6b1-c080ef5a060d"

def setup():
    print("Launching headed Chrome browser with advanced stealth settings...")
    
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(
                headless=False,
                channel="chrome",
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--use-fake-ui-for-media-stream",
                    "--disable-infobars"
                ]
            )
        except Exception as e:
            print(f"Failed to launch Chrome: {e}. Falling back to default Chromium...")
            browser = p.chromium.launch(
                headless=False,
                args=["--disable-blink-features=AutomationControlled"]
            )
            
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            timezone_id="Asia/Kolkata"
        )
        
        # Advanced stealth injection to bypass reCAPTCHA v3
        context.add_init_script("""
            // Hide webdriver
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            
            // Mock chrome object
            window.chrome = {
                runtime: {}
            };
            
            // Overwrite languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
            
            // Overwrite permissions
            const originalQuery = navigator.permissions.query;
            navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters);
        """)
        
        page = context.new_page()
        
        print("Navigating to https://learner.vierp.in/...")
        page.goto("https://learner.vierp.in/")
        page.wait_for_selector("input[type='text']")
        
        print("\n=== ACTION REQUIRED ===")
        print("A Google Chrome window should have opened on your screen.")
        print("Please enter your credentials and log in manually in that window.")
        print("Solve any Captcha challenges if they appear.")
        print("=======================\n")
        
        # Fill credentials
        page.fill("input[type='text']", "ajay.21810409@viit.ac.in")
        page.fill("input[type='password']", "Deadman@9527")
        print("Filled credentials.")
        page.wait_for_timeout(1000)
        
        # Click SIGN IN
        print("Clicking SIGN IN...")
        page.click("button:has-text('SIGN IN')")
        
        # Wait up to 5 minutes for login success
        logged_in = False
        for i in range(300):
            page.wait_for_timeout(1000)
            if "Dashboard" in page.url or "grade-card" in page.url:
                logged_in = True
                print(f"Success! Reached URL: {page.url}")
                page.wait_for_timeout(3000)
                break
                
            if i % 15 == 0 and i > 0:
                print(f"Waiting... ({i}s elapsed). Current URL: {page.url}")
                # Save screenshot of current state
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, f"setup_waiting_{i}.png"))
                
        if logged_in:
            state_path = "C:/Users/Ajay.AJAY/.gemini/antigravity/scratch/state.json"
            context.storage_state(path=state_path)
            print(f"Session state saved to {state_path}")
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "setup_success.png"))
        else:
            print("Failed to log in within 5 minutes.")
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "setup_failed_final.png"))
            
        browser.close()

if __name__ == "__main__":
    setup()
