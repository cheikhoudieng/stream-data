#!/usr/bin/env python3
"""
Cricfy2 Decryptor (Ultimate Recursive Edition)
Intègre le téléchargement automatique et RÉCURSIF des sous-catégories (custom) et événements sportifs.
"""

import base64
import gzip
import json
import os
import time
import urllib.request
from urllib.error import URLError
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

# ═══════════════════════════════════════════════════════════════════
# 1. CONSTANTES DÉCODÉES ET CLÉS
# ═══════════════════════════════════════════════════════════════════

def reveal(hex_str: str, key: int) -> str:
    if not hex_str: return ""
    try:
        return bytes(int(hex_str[i:i+2], 16) ^ (key & 0xFF) for i in range(0, len(hex_str), 2)).decode("utf-8", errors="replace")
    except Exception:
        return ""

CONFIG_URL_1 = reveal("a4b8b8bcbff6e3e3bce2aba9a2b6a8a9bae2b4b5b6e3fee1b4a1a2a4adaee2a6bfa3a2", 0xCC)
CONFIG_URL_2 = reveal("afb3b3b7b4fde8e8a4e9b7aba6beb3a2ace9bfbebde8f5eabfaaa9afa6a5e9adb4a8a9", 0xC7)
TOKEN_DEFAULT = reveal("17491b48474e164e49494a4a4848184c46484e494b484c18474a4849444a494e464c46484b48481e474e4949474a44484a4a46484c49484e474a4b49474a49", 0x2F)

V2_KEY = b"WT1sdkEvUlR4ckd2"
V2_IV = b"Q7sKcm9LR4VaX2pN"

HEADERS = {
    "User-Agent": "Mozilla/5.0 Cricfy2/1.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
}
OUT_DIR = "cricfy_output"

# ═══════════════════════════════════════════════════════════════════
# 2. MOTEURS DE DÉCHIFFREMENT
# ═══════════════════════════════════════════════════════════════════

def cfg_material() -> bytes:
    A = bytes([0x1D, 0x58, 0x11, 0x68, 0x42, 0x07, 0x5B, 0x22, 0x71, 0x05, 0x2F, 0x60])
    B = bytes([0x47, 0x0C, 0x53, 0x2C, 0x09, 0x79, 0x24, 0x3A, 0x65, 0x16, 0x3F])
    C = bytes([0x06, 0x27, 0x5F, 0x0E, 0x4A, 0x34, 0x75, 0x1B, 0x44, 0x03, 0x56, 0x29, 0x6D])
    out = bytearray(32)
    for i in range(32):
        a, b, c = A[i % 12] & 0xFF, B[((i * 3) + 1) % 11] & 0xFF, C[((i * 5) + 2) % 13] & 0xFF
        s = i & 7
        b_rot = ((b << s) | (b >> (8 - s))) & 0xFF if s else b
        out[i] = (a ^ b_rot ^ c ^ 0x5A ^ i) & 0xFF
    return bytes(out)

_CFG_MATERIAL = cfg_material()

def open_config_text(raw: str) -> str:
    s = (raw or "").strip()
    if s.startswith("cfj1:"): s = s[5:]
    s = s.replace("\r", "").replace("\n", "").replace("\t", "").replace(" ", "")
    pad = (-len(s)) % 4
    data = base64.b64decode(s + "=" * pad)
    mat, ml, n = _CFG_MATERIAL, len(_CFG_MATERIAL), len(data)
    buf = bytearray(n)
    for i in range(n):
        buf[(n - 1) - i] = (mat[i % ml] ^ data[i] ^ ((i * 29 + 71) & 0xFF)) & 0xFF
    return buf.decode("utf-8", errors="replace").strip()

def swap_pairs(s: str) -> str:
    arr = list(s)
    i = 0
    while i + 1 < len(arr):
        arr[i], arr[i+1] = arr[i+1], arr[i]
        i += 2
    return "".join(arr)

def clean_base64(s: str) -> str:
    result = ''.join(c for c in s if c.isalnum() or c in ('+', '/'))
    missing = len(result) % 4
    if missing: result += '=' * (4 - missing)
    return result

def decrypt_v2_full(encrypted_str: str) -> str:
    try:
        missing = len(encrypted_str) % 4
        if missing: encrypted_str += '=' * (4 - missing)
        outer_decoded = base64.b64decode(encrypted_str).decode('latin-1')
        
        swapped = swap_pairs(outer_decoded)[::-1]
        
        if not swapped.endswith("abcdefghijklmnop"):
            return encrypted_str
        payload_b64 = swapped[:-16]
        
        aes_bytes = base64.b64decode(payload_b64.encode('latin-1'))
        
        cipher = AES.new(V2_KEY, AES.MODE_CBC, V2_IV)
        decrypted_aes_bytes = unpad(cipher.decrypt(aes_bytes), AES.block_size)
        aes_str = decrypted_aes_bytes.decode('latin-1')
        
        swapped_inner = swap_pairs(aes_str)[::-1]
        
        final_bytes = base64.b64decode(clean_base64(swapped_inner).encode('latin-1'))
        return final_bytes.decode('utf-8', errors='ignore')
    except Exception as e:
        return f"Erreur de déchiffrement AES : {e}"

def xor_hex(s: str) -> str:
    return "".join(f"{(b ^ 0x5A) & 0xFF:02x}" for b in s.encode("utf-8"))

# ═══════════════════════════════════════════════════════════════════
# 3. LOGIQUE RÉSEAU ET API
# ═══════════════════════════════════════════════════════════════════

def build_getdata_url(cfg: dict, host: str, path: str) -> str:
    base = cfg.get("getdata_base_url") or cfg.get("get_data_base_url") or cfg.get("signed_api_base_url")
    if not base:
        h = host if host.endswith("/") else host + "/"
        base = h[:-3] if h.lower().endswith("/v2/") else h

    endpoint = cfg.get("getdata_endpoint", "") or "getData.php"
    token = cfg.get("getdata_token") or cfg.get("signed_api_token") or TOKEN_DEFAULT

    prefix = cfg.get("getdata_path_prefix", "v2/")
    if not prefix.endswith("/"): prefix += "/"
    norm_path = path if path.startswith(prefix) else prefix + path.lstrip("/")

    key_param  = xor_hex(norm_path)
    hmac_param = xor_hex(f"{int(time.time())}|{token}")

    base = base if base.endswith("/") else base + "/"
    return f"{base}{endpoint}?key={key_param}&hmac={hmac_param}"

def resolve_content_url(cfg: dict, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"): return path
    host = cfg.get("api2") or cfg.get("api_url") or cfg.get("api_host", "")
    mode = cfg.get("Mode", "").lower()
    
    if mode == "genz" or cfg.get("getdata_enabled"):
        return build_getdata_url(cfg, host, path)
    
    host = host if host.endswith("/") else host + "/"
    return host + path.lstrip("/")

def _fetch_bytes(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw

def _parse_text(text: str) -> object:
    text = (text or "").strip()
    if not text: return None

    if text.startswith("{") or text.startswith("["):
        try: return json.loads(text)
        except: pass

    if text.startswith("cfj1:"):
        try:
            decoded = open_config_text(text)
            return json.loads(decoded)
        except: pass
    
    try:
        decoded_v2 = decrypt_v2_full(text)
        if decoded_v2 and (decoded_v2.startswith("{") or decoded_v2.startswith("[")):
            return json.loads(decoded_v2)
        return decoded_v2
    except:
        return text

# ═══════════════════════════════════════════════════════════════════
# 4. EXÉCUTION & SAUVEGARDE RÉCURSIVE
# ═══════════════════════════════════════════════════════════════════

def fetch_remote_config() -> dict | None:
    for url in filter(None, [CONFIG_URL_1, CONFIG_URL_2]):
        print(f"  [GET] config → {url}")
        try:
            text = _fetch_bytes(url).decode("utf-8", errors="ignore")
            cfg  = _parse_text(text)
            if isinstance(cfg, dict) and cfg.get("enabled", True):
                return cfg
        except Exception as e:
            pass
    return None

def download(cfg: dict, path: str) -> object:
    url = resolve_content_url(cfg, path)
    try:
        raw_bytes = _fetch_bytes(url)
        text = raw_bytes.decode("latin-1", errors="ignore")
        return _parse_text(text)
    except URLError as e:
        print(f"    [réseau] {e.reason}")
        return None
    except Exception as e:
        print(f"    [erreur] {e}")
        return None

def save(path_name: str, data: object) -> str:
    # Normalise le nom de chemin (ex: "channels/S29s.txt" -> "channels/S29s.json")
    normalized = path_name.replace("\\", "/").strip("/")
    if normalized.endswith(".txt"):
        normalized = normalized[:-4] + ".json"
    
    out_path = os.path.join(OUT_DIR, normalized)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    
    with open(out_path, "w", encoding="utf-8") as f:
        if isinstance(data, (dict, list)):
            json.dump(data, f, ensure_ascii=False, indent=2)
        else:
            f.write(str(data))
    return out_path

# Set pour mémoriser les fichiers déjà téléchargés (évite les boucles infinies)
visited_files = set()

def crawl_recursive(cfg: dict, data: object, level: int = 0):
    """
    Parcourt n'importe quel objet JSON.
    Si c'est un tableau, parcourt chaque élément.
    S'il détecte une catégorie 'custom' ou un événement contenant des '.txt', 
    il les télécharge et s'appelle lui-même.
    """
    indent = "  " * (level + 1)
    
    if isinstance(data, list):
        for item in data:
            crawl_recursive(cfg, item, level)
            
    elif isinstance(data, dict):
        # 1. Vérifier si c'est une Catégorie (cat -> type: custom -> api: .txt)
        cat_raw = data.get("cat")
        if cat_raw:
            cat_obj = cat_raw
            if isinstance(cat_raw, str):
                try:
                    cat_obj = json.loads(cat_raw.replace("\\/", "/"))
                except Exception:
                    pass
            
            if isinstance(cat_obj, dict) and cat_obj.get("type") == "custom":
                api_path = cat_obj.get("api", "")
                if api_path and isinstance(api_path, str) and api_path.endswith(".txt"):
                    if api_path not in visited_files:
                        visited_files.add(api_path)
                        cat_name = cat_obj.get("name", "Unknown Category")
                        print(f"{indent}📂 [DÉCOUVERTE] Catégorie '{cat_name}' ➔ {api_path}")
                        
                        sub_data = download(cfg, api_path)
                        if sub_data is not None:
                            saved_file = save(api_path, sub_data)
                            print(f"{indent}  ✓ Sauvegardé dans: {saved_file}")
                            # Appel récursif !
                            crawl_recursive(cfg, sub_data, level + 1)

        # 2. Vérifier si c'est un Événement Sportif (links -> .txt)
        links_path = data.get("links")
        if links_path and isinstance(links_path, str) and links_path.endswith(".txt"):
            if links_path not in visited_files:
                visited_files.add(links_path)
                
                # Tenter d'extraire un joli nom pour l'affichage
                ev_name = "Unknown Event"
                ev_raw = data.get("event")
                if isinstance(ev_raw, str):
                    try:
                        ev_obj = json.loads(ev_raw.replace("\\/", "/"))
                        ev_name = ev_obj.get("eventDetails", {}).get("eventName", ev_name)
                        team_a = ev_obj.get("teamA", {}).get("name", "")
                        team_b = ev_obj.get("teamB", {}).get("name", "")
                        if team_a and team_b: ev_name += f" ({team_a} vs {team_b})"
                    except: pass

                print(f"{indent}🔗 [DÉCOUVERTE] Événement '{ev_name}' ➔ {links_path}")
                
                sub_data = download(cfg, links_path)
                if sub_data is not None:
                    saved_file = save(links_path, sub_data)
                    print(f"{indent}  ✓ Sauvegardé dans: {saved_file}")
                    # Appel récursif au cas où les liens pointeraient eux-mêmes sur d'autres choses
                    crawl_recursive(cfg, sub_data, level + 1)

# ═══════════════════════════════════════════════════════════════════
# 5. MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 70)
    print("  CRICFY2 DECRYPTOR ULTIMATE (Recursive Crawler / AES V2 + XOR)")
    print("=" * 70)

    # 1. Config distante
    print("\n[1/3] Récupération de la configuration globale…")
    cfg = fetch_remote_config()
    if not cfg:
        print("  ✗ Impossible de récupérer la config")
        raise SystemExit(1)
    
    save("_config.json", cfg)
    print("  ✓ Config sauvegardée")

    # 2. Fichiers racines
    print("\n[2/3] Téléchargement des points d'entrée principaux…")
    CONTENT_FILES = ["events.txt", "event_cats.txt", "categories.txt"]
    root_data = {}
    
    for f in CONTENT_FILES:
        print(f"  → Récupération de {f}")
        visited_files.add(f)
        data = download(cfg, f)
        if data is not None:
            save(f, data)
            root_data[f] = data
            print(f"    ✓ Succès ({len(data) if isinstance(data, list) else 1} entrées)")

    # 3. Crawler Récursif (Magie)
    print("\n[3/3] Début du Crawler Récursif (Sous-catégories et Événements)…")
    for f, data in root_data.items():
        print(f"\n  🔍 Analyse de la racine '{f}' :")
        crawl_recursive(cfg, data, level=0)

    print(f"\n{'=' * 70}")
    print(f"  🎉 Terminé ! Tous les fichiers sont déchiffrés dans le dossier : ./{OUT_DIR}/")
    print(f"     Fichiers uniques téléchargés : {len(visited_files)}")
    print("=" * 70)