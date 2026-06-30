import base64
import urllib.request
import urllib.error
import gzip
import json
import time
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

# --- CONFIGURATION ---
BASE_URL = "https://cricyplayers.com/data/getData.php"
TOKEN = "cricfy2_get_data_token_123" # Le GETDATA_DEFAULT_TOKEN décrypté
V2_KEY = b"WT1sdkEvUlR4ckd2"
V2_IV = b"Q7sKcm9LR4VaX2pN"

# --- UTILITAIRES ---
def xor_hex(s: str) -> str:
    """Chiffre les paramètres de l'URL comme le fait l'application (xorHex)"""
    res = ""
    for c in s.encode('utf-8'):
        val = (c ^ 90) & 255
        res += f"{val:02x}"
    return res

def swap_pairs(s: str) -> str:
    """Inverse les caractères 2 par 2"""
    arr = list(s)
    i = 0
    while i + 1 < len(arr):
        arr[i], arr[i+1] = arr[i+1], arr[i]
        i += 2
    return "".join(arr)

def clean_base64(s: str) -> str:
    """Nettoie le Base64 final"""
    result = ''.join(c for c in s if c.isalnum() or c in ('+', '/'))
    missing = len(result) % 4
    if missing:
        result += '=' * (4 - missing)
    return result

def safe_b64decode(s: str) -> bytes:
    s = s.strip().replace('\n', '').replace('\r', '')
    missing = len(s) % 4
    if missing:
        s += '=' * (4 - missing)
    return base64.b64decode(s)

# --- DÉCHIFFREMENT ABSOLU ---
def decrypt_v2_full(encrypted_str: str) -> str:
    """Reproduit exactement la pipeline Java decodeV2 + decodeNativeStage"""
    try:
        # 1. Base64 Decode (Outer)
        outer_decoded = safe_b64decode(encrypted_str).decode('latin-1')
        
        # 2. SwapPairs & Reverse
        swapped = swap_pairs(outer_decoded)[::-1]
        
        # 3. Strip Signature
        if not swapped.endswith("abcdefghijklmnop"):
            return "Erreur : Signature de sécurité manquante."
        payload_b64 = swapped[:-16]
        
        # 4. Base64 Decode to AES bytes
        aes_bytes = safe_b64decode(payload_b64)
        
        # 5. AES-128-CBC Decrypt
        cipher = AES.new(V2_KEY, AES.MODE_CBC, V2_IV)
        decrypted_aes_bytes = unpad(cipher.decrypt(aes_bytes), AES.block_size)
        aes_str = decrypted_aes_bytes.decode('latin-1')
        
        # 6. Inner SwapPairs & Reverse
        swapped_inner = swap_pairs(aes_str)[::-1]
        
        # 7. Clean Base64 & Final Decode to JSON
        final_bytes = safe_b64decode(clean_base64(swapped_inner))
        
        return final_bytes.decode('utf-8', errors='ignore')
    except Exception as e:
        return f"Erreur de déchiffrement : {e}"

# --- MOTEUR DE TÉLÉCHARGEMENT ---
def fetch_secure_api(filename):
    # Ajout du préfixe "v2/" exigé par l'API
    path = f"v2/{filename}"
    
    # Génération des signatures de sécurité (hmac + key)
    timestamp = str(int(time.time()))
    hmac_plain = f"{timestamp}|{TOKEN}"
    
    key_hex = xor_hex(path)
    hmac_hex = xor_hex(hmac_plain)
    
    # URL finale signée
    url = f"{BASE_URL}?key={key_hex}&hmac={hmac_hex}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 Cricfy2/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate'
    }
    
    print(f"[*] Interrogation de l'API sécurisée pour '{filename}'...")
    req = urllib.request.Request(url, headers=headers)
    
    try:
        with urllib.request.urlopen(req) as response:
            raw_bytes = response.read()
            if response.info().get('Content-Encoding') == 'gzip' or raw_bytes.startswith(b'\x1f\x8b'):
                raw_bytes = gzip.decompress(raw_bytes)
            
            raw_data = raw_bytes.decode('utf-8', errors='ignore').strip()
            
            print("    Données reçues. Déchiffrement AES V2...")
            clear_text = decrypt_v2_full(raw_data)
            
            # Réparation éventuelle du JSON (la même fonction que Java `repairJsonTail`)
            try:
                json_data = json.loads(clear_text)
                clear_text = json.dumps(json_data, indent=2, ensure_ascii=False)
            except Exception:
                pass
            
            output_name = filename.replace(".txt", "_final.json")
            with open(output_name, "w", encoding="utf-8") as f:
                f.write(clear_text)
                
            print(f"    [+] Succès ! JSON parfait enregistré sous : '{output_name}'\n")
            
    except Exception as e:
        print(f"    [!] Erreur pour {filename} : {e}")

if __name__ == "__main__":
    fichiers = ["categories.txt", "event_cats.txt", "events.txt"]
    for f in fichiers:
        fetch_secure_api(f)