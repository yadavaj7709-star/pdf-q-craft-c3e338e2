import os
import sys
import json
import base64
import sqlite3
import shutil
import ctypes
from ctypes import wintypes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Windows DPAPI decrypt helper
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
    # Strip DPAPI prefix (first 5 bytes 'DPAPI')
    dpapi_key = encrypted_key[5:]
    master_key = dpapi_decrypt(dpapi_key)
    return master_key

def decrypt_cookie_value(encrypted_value, master_key):
    try:
        # Chrome cookies encrypted values start with prefix v10 or v11 (3 bytes)
        prefix = encrypted_value[:3]
        if prefix in (b'v10', b'v11'):
            nonce = encrypted_value[3:15] # 12 bytes IV
            ciphertext = encrypted_value[15:]
            aesgcm = AESGCM(master_key)
            decrypted = aesgcm.decrypt(nonce, ciphertext, None)
            return decrypted.decode('utf-8')
        else:
            # Fallback for unencrypted/legacy values
            return dpapi_decrypt(encrypted_value).decode('utf-8')
    except Exception as e:
        # If decryption fails, just return empty/None
        return None

def extract_cookies():
    user_data_path = "C:/Users/Ajay.AJAY/AppData/Local/Google/Chrome/User Data"
    cookies_db_path = os.path.join(user_data_path, "Default", "Network", "Cookies")
    
    if not os.path.exists(cookies_db_path):
        print(f"Chrome cookies database not found at {cookies_db_path}")
        return False
        
    # Copy file to avoid locks
    temp_db_path = "C:/Users/Ajay.AJAY/.gemini/antigravity/scratch/cookies.db"
    shutil.copy2(cookies_db_path, temp_db_path)
    
    try:
        master_key = get_chrome_key(user_data_path)
        print("Successfully decrypted Chrome master key.")
    except Exception as e:
        print("Failed to get Chrome key:", e)
        return False
        
    # Connect to sqlite db
    conn = sqlite3.connect(temp_db_path)
    cursor = conn.cursor()
    
    # Query cookies for vierp.in
    query = """
    SELECT host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly 
    FROM cookies 
    WHERE host_key LIKE '%vierp.in%'
    """
    
    try:
        cursor.execute(query)
        rows = cursor.fetchall()
    except Exception as e:
        print("Failed to query cookies database:", e)
        conn.close()
        return False
        
    playwright_cookies = []
    
    for row in rows:
        host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly = row
        decrypted_val = decrypt_cookie_value(encrypted_value, master_key)
        
        if decrypted_val:
            # Format expires_utc: Chrome stores UTC timestamp in microseconds since 1601-01-01.
            # Playwright expects expiration time in seconds since 1970-01-01.
            # 11644473600 is the difference in seconds between 1601 and 1970.
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
    
    if not playwright_cookies:
        print("No active login cookies for vierp.in found in Chrome.")
        print("Please open your Chrome browser, log in to https://learner.vierp.in/, and then run this extractor again.")
        return False
        
    # Save as Playwright state structure
    state_data = {
        "cookies": playwright_cookies,
        "origins": []
    }
    
    state_path = "C:/Users/Ajay.AJAY/.gemini/antigravity/scratch/state.json"
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state_data, f, indent=2)
        
    print(f"Success! Extracted {len(playwright_cookies)} cookies and saved state to {state_path}")
    return True

if __name__ == "__main__":
    extract_cookies()
