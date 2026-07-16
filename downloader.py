import os
import sys
import time
import json
import base64
import sqlite3
import shutil
import ctypes
from ctypes import wintypes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
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
    STATE_PATH = os.path.join(WORKSPACE, "state.json")

# Credentials from environment variables
USERNAME = os.environ.get("PORTAL_USERNAME")
PASSWORD = os.environ.get("PORTAL_PASSWORD")

# Screenshot dir
SCREENSHOT_DIR = os.environ.get("SCREENSHOT_DIR_ENV", "C:/Users/Ajay.AJAY/.gemini/antigravity/brain/fb5a0422-59c7-457a-b6b1-c080ef5a060d")

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
if SCREENSHOT_DIR and not os.path.exists(SCREENSHOT_DIR):
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# Windows DPAPI decrypt helper (only for local Windows decryption)
class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(encrypted_bytes):
    crypt32 = ctypes.windll.crypt32
    LocalFree = ctypes.windll.kernel32.LocalFree
    
    in_blob = DATA_BLOB(len(encrypted_bytes), ctypes.create_string_buffer(encrypted_bytes))
    out_blob = DATA_BLOB()
    
    if crypt32.CryptUnprotectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        decrypted_bytes = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        LocalFree(out_blob.pbData)
        return decrypted_bytes
    else:
        raise Exception("DPAPI Decryption failed")

def get_chrome_key(user_data_path):
    local_state_path = os.path.join(user_data_path, "Local State")
    if not os.path.exists(local_state_path):
        raise FileNotFoundError(f"Local State file not found at {local_state_path}")
        
    with open(local_state_path, "r", encoding="utf-8") as f:
        local_state = json.load(f)
        
    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    dpapi_key = encrypted_key[5:]
    master_key = dpapi_decrypt(dpapi_key)
    return master_key

def decrypt_cookie_value(encrypted_value, master_key):
    try:
        prefix = encrypted_value[:3]
        if prefix in (b'v10', b'v11'):
            nonce = encrypted_value[3:15]
            ciphertext = encrypted_value[15:]
            aesgcm = AESGCM(master_key)
            decrypted = aesgcm.decrypt(nonce, ciphertext, None)
            return decrypted.decode('utf-8')
        else:
            return dpapi_decrypt(encrypted_value).decode('utf-8')
    except Exception:
        return None

def try_extract_local_chrome_cookies():
    """
    Attempts to read and decrypt active session cookies from the local Chrome installation.
    Fails gracefully if Chrome is running (database locked) or if run in non-Windows environment.
    """
    if os.name != 'nt':
        return False
        
    user_data_path = "C:/Users/Ajay.AJAY/AppData/Local/Google/Chrome/User Data"
    cookies_db_path = os.path.join(user_data_path, "Default", "Network", "Cookies")
    
    if not os.path.exists(cookies_db_path):
        return False
        
    temp_db_path = os.path.join(WORKSPACE, "temp_cookies.db")
    
    try:
        # Attempt copy (will raise PermissionError if Chrome has exclusive lock)
        shutil.copy2(cookies_db_path, temp_db_path)
    except Exception as e:
        print(f"Notice: Google Chrome is currently open/locked ({e}). Using cached session.")
        return False
        
    try:
        master_key = get_chrome_key(user_data_path)
        conn = sqlite3.connect(temp_db_path)
        cursor = conn.cursor()
        
        query = """
        SELECT host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly 
        FROM cookies 
        WHERE host_key LIKE '%vierp.in%'
        """
        cursor.execute(query)
        rows = cursor.fetchall()
        
        playwright_cookies = []
        for row in rows:
            host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly = row
            decrypted_val = decrypt_cookie_value(encrypted_value, master_key)
            
            if decrypted_val:
                expires_seconds = (expires_utc / 1000000) - 11644473600 if expires_utc > 0 else -1
                cookie_dict = {
                    "name": name,
                    "value": decrypted_val,
                    "domain": host_key,
                    "path": path,
                    "httpOnly": bool(is_httponly),
                    "secure": bool(is_secure),
                    "sameSite": "Lax"
                }
                if expires_seconds > 0:
                    cookie_dict["expires"] = expires_seconds
                playwright_cookies.append(cookie_dict)
                
        conn.close()
        
        # Clean up temp db file
        if os.path.exists(temp_db_path):
            os.remove(temp_db_path)
            
        if playwright_cookies:
            state_data = {
                "cookies": playwright_cookies,
                "origins": []
            }
            with open(STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(state_data, f, indent=2)
            print(f"Successfully extracted {len(playwright_cookies)} fresh cookies from Google Chrome.")
            return True
    except Exception as err:
        print(f"Warning: Failed to extract Chrome cookies: {err}")
        if os.path.exists(temp_db_path):
            try:
                os.remove(temp_db_path)
            except Exception:
                pass
    return False

def select_vuetify_option(page, label_text, option_text):
    print(f"Selecting '{option_text}' for '{label_text}'...")
    try:
        select_locator = page.locator(f"div.v-select:has-text('{label_text}'), div.v-input:has-text('{label_text}')").first
        select_locator.click(timeout=5000)
        page.wait_for_timeout(1000)
        
        option_locator = page.locator(f"//div[contains(@class, 'v-list-item-title') and normalize-space()='{option_text}'] | //div[contains(@class, 'v-list-item') and normalize-space()='{option_text}'] | //*[role='option' and (normalize-space()='{option_text}' or contains(., '{option_text}'))]").first
        option_locator.click(timeout=5000)
        page.wait_for_timeout(1000)
        return True
    except Exception as e:
        print(f"Failed to select '{option_text}': {e}")
        return False

def run_downloader():
    # 1. Attempt to extract fresh cookies from the user's active Chrome profile
    try_extract_local_chrome_cookies()

    # Determine headless mode based on environment
    is_headless = "GITHUB_ACTIONS" in os.environ
    print(f"Launching Playwright (headless={is_headless})...")
    
    with sync_playwright() as p:
        try:
            # Try to use Chrome channel if running locally on Windows
            browser = p.chromium.launch(
                headless=is_headless,
                channel="chrome" if os.name == 'nt' else None,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars"
                ]
            )
        except Exception as e:
            print(f"Could not launch Chrome channel: {e}. Launching default Chromium...")
            browser = p.chromium.launch(
                headless=is_headless,
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
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 1024},
                locale="en-US",
                timezone_id="Asia/Kolkata"
            )
        else:
            print("Session state file not found. Starting with fresh context...")
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 1024},
                locale="en-US",
                timezone_id="Asia/Kolkata"
            )
            
        # Advanced stealth injection to bypass reCAPTCHA v3 (working logic from setup_session)
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
                    
        # Wait for either the SIGN IN button (login screen) or the Academic Year dropdown (grade card screen) to appear
        print("Waiting for page hydration...")
        try:
            page.wait_for_selector(
                "button:has-text('SIGN IN'), div.v-select:has-text('Academic Year'), div.v-input:has-text('Academic Year')", 
                timeout=20000
            )
        except Exception as e:
            print(f"Warning: Timeout waiting for page content to hydrate: {e}")
            if SCREENSHOT_DIR:
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "hydration_failed.png"))
            
        # Check if login button is present
        login_btn = page.locator("button:has-text('SIGN IN')")
        if login_btn.count() > 0:
            print("Login screen detected. Session is unauthenticated.")
            if USERNAME and PASSWORD:
                print("Attempting automatic login...")
                try:
                    page.wait_for_selector("input[type='text']")
                    page.wait_for_timeout(3000)
                    
                    # Fill credentials with human-like typing delays to bypass reCAPTCHA v3
                    print("Typing username...")
                    page.locator("input[type='text']").click()
                    page.type("input[type='text']", USERNAME, delay=120)
                    page.wait_for_timeout(1000)
                    
                    print("Typing password...")
                    page.locator("input[type='password']").click()
                    page.type("input[type='password']", PASSWORD, delay=150)
                    page.wait_for_timeout(1500)
                    
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
                        try:
                            page.wait_for_selector("div.v-select:has-text('Academic Year'), div.v-input:has-text('Academic Year')", timeout=15000)
                        except Exception:
                            pass
                    else:
                        print("Auto-login failed (possibly due to Captcha). Exiting to try next day.")
                        if SCREENSHOT_DIR:
                            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "auto_login_failed.png"))
                        browser.close()
                        return False
                except Exception as login_err:
                    print(f"Error during auto-login process: {login_err}")
                    browser.close()
                    return False
            else:
                print("Error: No credentials available for auto-login fallback.")
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
                    if SCREENSHOT_DIR:
                        page.screenshot(path=os.path.join(SCREENSHOT_DIR, f"debug_sem_{sem_number}_failed.png"))
                    
        browser.close()
        print("\nAll semesters processed successfully!")
        return True

if __name__ == "__main__":
    run_downloader()
