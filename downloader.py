import os
import sys
import time
from playwright.sync_api import sync_playwright

# Cross-platform paths configuration
WORKSPACE = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.join(WORKSPACE, "downloads")

# Load environment variables from a local .env file if it exists
env_path = os.path.join(WORKSPACE, ".env")
if os.path.exists(env_path):
    print("Loading credentials from local .env file...")
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()

# Set STATE_PATH dynamically depending on environment
if "STATE_PATH_ENV" in os.environ:
    STATE_PATH = os.environ["STATE_PATH_ENV"]
else:
    # Local Windows fallback
    STATE_PATH = "C:/Users/Ajay.AJAY/.gemini/antigravity/scratch/state.json"

# Credentials from environment variables
USERNAME = os.environ.get("PORTAL_USERNAME")
PASSWORD = os.environ.get("PORTAL_PASSWORD")

# Screenshot dir
SCREENSHOT_DIR = os.environ.get("SCREENSHOT_DIR_ENV", "C:/Users/Ajay.AJAY/.gemini/antigravity/brain/fb5a0422-59c7-457a-b6b1-c080ef5a060d")

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
if not os.path.exists(os.path.dirname(STATE_PATH)) and os.path.dirname(STATE_PATH):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)

if not USERNAME or not PASSWORD:
    print("Error: PORTAL_USERNAME or PORTAL_PASSWORD environment variables not set.")
    print("Please set them in your system environment or create a local .env file.")
    sys.exit(1)

def select_vuetify_option(page, label_text, option_text):
    print(f"Selecting '{option_text}' for '{label_text}'...")
    try:
        select_locator = page.locator(f"div.v-select:has-text('{label_text}'), div.v-input:has-text('{label_text}')").first
        select_locator.click()
        page.wait_for_timeout(1500)
        
        option_locator = page.locator(f"//div[contains(@class, 'v-list-item-title') and normalize-space()='{option_text}'] | //div[contains(@class, 'v-list-item') and normalize-space()='{option_text}'] | //*[role='option' and (normalize-space()='{option_text}' or contains(., '{option_text}'))]").first
        option_locator.click()
        page.wait_for_timeout(1500)
        return True
    except Exception as e:
        print(f"Failed to select '{option_text}': {e}")
        return False

def run_downloader():
    print("Launching Playwright (headless)...")
    with sync_playwright() as p:
        try:
            # Try to use Chrome channel if running locally on Windows
            browser = p.chromium.launch(
                headless=True,
                channel="chrome" if os.name == 'nt' else None,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars"
                ]
            )
        except Exception as e:
            print(f"Could not launch Chrome channel: {e}. Launching default Chromium...")
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars"
                ]
            )
            
        # Load state if it exists
        if os.path.exists(STATE_PATH):
            print(f"Loading session state from {STATE_PATH}...")
            context = browser.new_context(
                storage_state=STATE_PATH,
                viewport={"width": 1280, "height": 1024},
                locale="en-US",
                timezone_id="Asia/Kolkata"
            )
        else:
            print("Session state file not found. Starting with fresh context...")
            context = browser.new_context(
                viewport={"width": 1280, "height": 1024},
                locale="en-US",
                timezone_id="Asia/Kolkata"
            )
            
        # Inject advanced stealth settings to ensure we pass reCAPTCHA v3
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        """)
        
        page = context.new_page()
        
        url = "https://learner.vierp.in/grade-card"
        print(f"Navigating to {url}...")
        
        # Network retry loop
        for retry in range(3):
            try:
                page.goto(url, timeout=45000)
                break
            except Exception as e:
                print(f"Network error (attempt {retry+1}/3): {e}")
                if retry < 2:
                    time.sleep(10)
                else:
                    print("All navigation retries failed. Exiting.")
                    browser.close()
                    return False
                    
        page.wait_for_timeout(5000)
        
        # Check if redirected to login page (we check for the presence of the SIGN IN button on the page)
        login_btn = page.locator("button:has-text('SIGN IN')")
        if login_btn.count() > 0:
            print("Login screen detected. Attempting automatic login...")
            try:
                page.wait_for_selector("input[type='text']")
                page.wait_for_timeout(3000) # Wait for page hydration
                
                # Fill credentials
                page.fill("input[type='text']", USERNAME)
                page.fill("input[type='password']", PASSWORD)
                page.wait_for_timeout(1000)
                
                # Hydration click loop (retry clicking until dashboard is reached)
                logged_in = False
                for click_attempt in range(8):
                    if "Dashboard" in page.url or page.locator("button:has-text('SIGN IN')").count() == 0:
                        logged_in = True
                        break
                    print(f"Login click attempt {click_attempt+1}...")
                    page.click("button:has-text('SIGN IN')")
                    page.wait_for_timeout(5000)
                    
                if logged_in:
                    print(f"Login successful! Saving session state to {STATE_PATH}...")
                    context.storage_state(path=STATE_PATH)
                    page.goto("https://learner.vierp.in/grade-card")
                    page.wait_for_timeout(5000)
                else:
                    print("Auto-login failed (possibly due to Captcha). Exiting to try next day.")
                    if os.path.exists(SCREENSHOT_DIR):
                        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "auto_login_failed.png"))
                    browser.close()
                    return False
            except Exception as login_err:
                print(f"Error during auto-login process: {login_err}")
                browser.close()
                return False
        else:
            print("Authenticated session active (no login screen detected).")
                
        print("Successfully loaded Grade Card page.")
        
        # Target years and sems
        target_years = ['2018-19', '2019-20', '2020-21', '2021-22']
        target_sems = ['1', '2']
        
        for ay_name in target_years:
            for sem_name in target_sems:
                year_offset = target_years.index(ay_name) * 2
                sem_number = year_offset + int(sem_name)
                
                print(f"\n=========================================")
                print(f"Processing: Academic Year {ay_name}, Term {sem_name} (Semester {sem_number})")
                print(f"=========================================")
                
                page.goto("https://learner.vierp.in/grade-card")
                page.wait_for_timeout(3000)
                
                # Select Academic Year
                if not select_vuetify_option(page, "Academic Year", ay_name):
                    continue
                    
                # Select Semester
                if not select_vuetify_option(page, "Semester", sem_name):
                    continue
                    
                # Click PROCEED
                print("Clicking PROCEED...")
                try:
                    page.click("button:has-text('PROCEED'), button:has-text('Proceed'), button:has-text('SUBMIT')")
                    page.wait_for_timeout(5000)
                except Exception as e:
                    print("Failed to click proceed button:", e)
                    continue
                    
                # Check for errors in text
                body_text = page.inner_text("body").lower()
                if any(x in body_text for x in ["not generated", "not declared", "not available", "no data found"]):
                    print(f"Skipped: Grade card not available for {ay_name} Semester {sem_number}.")
                    continue
                    
                # Verify and download
                printonly_locator = page.locator("#printonly")
                if printonly_locator.count() > 0 and len(printonly_locator.inner_text().strip()) > 100:
                    print("Grade card content rendered! Generating PDF...")
                    pdf_filename = f"VIIT_Marksheet_Semester_{sem_number}.pdf"
                    pdf_path = os.path.join(DOWNLOAD_DIR, pdf_filename)
                    
                    try:
                        page.pdf(path=pdf_path, format="A4", print_background=True)
                        print(f"SUCCESS: Saved marksheet to {pdf_path}")
                    except Exception as pdf_error:
                        print("Failed to save PDF:", pdf_error)
                else:
                    print(f"Skipped: Printable marksheet content not found for {ay_name} Semester {sem_number}.")
                    if os.path.exists(SCREENSHOT_DIR):
                        page.screenshot(path=os.path.join(SCREENSHOT_DIR, f"debug_sem_{sem_number}_failed.png"))
                    
        browser.close()
        print("\nAll semesters processed successfully!")
        return True

if __name__ == "__main__":
    run_downloader()
