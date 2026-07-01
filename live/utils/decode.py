#!/usr/bin/env python3
"""
Cricfy2 Decryptor (Ultimate Edition - Full Database Generator)
Génère un seul fichier JSON massif et structuré pour la création d'applications.
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
    except Exception:
        return encrypted_str

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

def _fetch_bytes(url: str, timeout: int = 15) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw

def parse_json_safely(text: str) -> object:
    text = str(text).strip()
    if not text: return None
    if text.startswith("{") or text.startswith("["):
        try: return json.loads(text)
        except: pass
    if text.startswith("cfj1:"):
        try: return json.loads(open_config_text(text))
        except: pass
    try:
        dec = decrypt_v2_full(text)
        if dec and (dec.startswith("{") or dec.startswith("[")):
            return json.loads(dec)
        return dec
    except:
        return text

def download_and_parse(cfg: dict, path: str) -> object:
    url = resolve_content_url(cfg, path)
    try:
        raw_bytes = _fetch_bytes(url)
        return parse_json_safely(raw_bytes.decode("latin-1", errors="ignore"))
    except Exception:
        return None

# ═══════════════════════════════════════════════════════════════════
# 4. CONSTRUCTION DE LA BASE DE DONNÉES UNIFIÉE
# ═══════════════════════════════════════════════════════════════════

def build_complete_database(cfg: dict) -> dict:
    database = {
        "metadata": {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": "Cricfy2",
        },
        "live_tv": [],
        "sports_tournaments": {},
        "sports_events": []
    }

    print("\n[1/3] Téléchargement des Live TV Categories...")
    cats_data = download_and_parse(cfg, "categories.txt")
    if isinstance(cats_data, list):
        for item in cats_data:
            if not isinstance(item, dict): continue
            
            # Convertir le champ 'cat' qui est un string JSON en objet dict
            cat_obj = item.get("cat")
            if isinstance(cat_obj, str):
                cat_obj = parse_json_safely(cat_obj)
            
            if isinstance(cat_obj, dict):
                structured_cat = {
                    "id": item.get("id"),
                    "order_index": item.get("order_index"),
                    "name": cat_obj.get("name"),
                    "logo": cat_obj.get("logo"),
                    "type": cat_obj.get("type"),
                    "playlist_url": cat_obj.get("api") if cat_obj.get("type") == "m3u" else None,
                    "channels": []
                }

                # Si type custom, on télécharge les sous-chaines et on les intègre
                if cat_obj.get("type") == "custom" and cat_obj.get("api"):
                    print(f"  ➔ Extraction des chaînes pour: {structured_cat['name']}")
                    channels = download_and_parse(cfg, cat_obj.get("api"))
                    if isinstance(channels, list):
                        structured_cat["channels"] = channels
                        
                database["live_tv"].append(structured_cat)

    print("\n[2/3] Téléchargement des Sports Tournaments (Mapping)...")
    tournaments_data = download_and_parse(cfg, "event_cats.txt")
    if isinstance(tournaments_data, dict):
        database["sports_tournaments"] = tournaments_data
        print(f"  ➔ {len(tournaments_data)} tournois/sports mappés.")

    print("\n[3/3] Téléchargement des Sports Events & Streams...")
    events_data = download_and_parse(cfg, "events.txt")
    if isinstance(events_data, list):
        for i, ev in enumerate(events_data):
            if not isinstance(ev, dict): continue
            
            # Convertir le champ 'event' qui est un string JSON en objet dict
            event_obj = ev.get("event")
            if isinstance(event_obj, str):
                event_obj = parse_json_safely(event_obj)
            
            if isinstance(event_obj, dict):
                structured_event = {
                    "id": ev.get("id"),
                    "order_index": ev.get("order_index"),
                    "category": event_obj.get("eventDetails", {}).get("category"),
                    "event_name": event_obj.get("eventDetails", {}).get("eventName"),
                    "event_logo": event_obj.get("eventDetails", {}).get("eventLogo"),
                    "team_a": event_obj.get("teamA"),
                    "team_b": event_obj.get("teamB"),
                    "date": event_obj.get("date"),
                    "time": event_obj.get("time"),
                    "end_date": event_obj.get("end_date"),
                    "end_time": event_obj.get("end_time"),
                    "streams": []
                }

                # Récupération des streams associés à l'événement
                links_path = event_obj.get("links")
                if links_path and isinstance(links_path, str) and links_path.endswith(".txt"):
                    print(f"  ➔ Fetch streams [{i+1}/{len(events_data)}]: {structured_event['event_name']}")
                    streams = download_and_parse(cfg, links_path)
                    
                    # Les streams sont souvent retournés sous forme de string JSON qu'il faut re-parser
                    if isinstance(streams, str):
                        streams = parse_json_safely(streams)

                    if isinstance(streams, list):
                        structured_event["streams"] = streams
                        
                database["sports_events"].append(structured_event)
                time.sleep(0.1) # Petit délai pour ne pas saturer l'API

    return database

# ═══════════════════════════════════════════════════════════════════
# 5. MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 65)
    print("  CRICFY2 DECRYPTOR ULTIMATE - FULL JSON API GENERATOR")
    print("=" * 65)

    cfg = None
    for url in filter(None, [CONFIG_URL_1, CONFIG_URL_2]):
        print(f"[*] Fetching config: {url}")
        try:
            raw = _fetch_bytes(url).decode("utf-8", errors="ignore")
            cfg = parse_json_safely(raw)
            if isinstance(cfg, dict) and cfg.get("enabled", True):
                break
        except Exception:
            pass

    if not cfg:
        print("✗ Impossible de récupérer la config.")
        exit(1)

    # Lancement de la construction de la base de données
    complete_db = build_complete_database(cfg)

    # Sauvegarde du super-JSON
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, "cricfy_database.json")
    
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(complete_db, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 65}")
    print(f"✅ SUCCÈS ! La base de données complète a été générée :")
    print(f"📂 Chemin : {out_path}")
    print(f"📊 Statistiques :")
    print(f"   - Catégories Live TV : {len(complete_db['live_tv'])}")
    print(f"   - Événements Sportifs : {len(complete_db['sports_events'])}")
    print("=" * 65)