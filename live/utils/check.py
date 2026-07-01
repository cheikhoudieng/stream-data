import urllib.request
import urllib.error
import gzip
import os
import sys
# --- EXEMPLES DE LIENS QUE VOUS POUVEZ ENTRER ---
# URL_CIBLE = "https://26hrwgorfcmh.windows-devs.top/AccessLog2/83_FHD/apache.m3u8|Referer=https://26hrwgorfcmh.windows-devs.top/"
# URL_CIBLE = "http://193.47.62.44/hls/RGREGREQZ.m3u8|User-Agent=Mozilla/5.0...&Referer=http://www.fawanews.sc/&Origin=http://www.fawanews.sc/"

URL_CIBLE = "https://26hrwgorfcmh.windows-devs.top/AccessLog2/83_FHD/apache.m3u8|Referer=https://26hrwgorfcmh.windows-devs.top/"

OUTPUT_FILENAME = "flux_valide.m3u8"

def parse_custom_link(raw_string):
    """
    Sépare l'URL des en-têtes et construit le dictionnaire de Headers.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    if not raw_string:
        return "", headers
    
    if "|" not in raw_string:
        return raw_string.strip(), headers
        
    parts = raw_string.split("|")
    url = parts[0].strip()
    headers_string = parts[1].strip()
    
    # Gère le séparateur interne '&'
    pairs = headers_string.split("&")
    for pair in pairs:
        if "=" in pair:
            key, val = pair.split("=", 1)
            key_lower = key.lower()
            if key_lower in ("referer", "referrer"):
                headers["Referer"] = val
            elif key_lower == "user-agent":
                headers["User-Agent"] = val
            elif key_lower == "origin":
                headers["Origin"] = val
            elif key_lower == "cookie":
                headers["Cookie"] = val
            else:
                headers[key] = val
    return url, headers

def make_absolute_urls(m3u8_content, base_url):
    """
    Si les liens de segments (.ts) à l'intérieur du fichier sont relatifs 
    (ex: "segment_001.ts"), cette fonction les transforme en liens absolus 
    (ex: "https://serveur.com/segment_001.ts") pour que le fichier soit lisible localement.
    """
    # Déterminer l'URL de base du dossier
    if "/" in base_url:
        base_dir = base_url.rsplit('/', 1)[0] + "/"
    else:
        base_dir = base_url
        
    lines = m3u8_content.splitlines()
    new_lines = []
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Si la ligne est un lien de segment et qu'elle n'est pas déjà absolue (http/https)
        if not line.startswith("#") and not (line.startswith("http://") or line.startswith("https://")):
            new_lines.append(base_dir + line)
        else:
            new_lines.append(line)
            
    return "\n".join(new_lines)

def download_stream_playlist(raw_string, out_file):
    url, headers = parse_custom_link(raw_string)
    if not url:
        print("[!] Erreur : Lien invalide.")
        return

    print(f"[*] Analyse du lien...")
    print(f"    ➔ URL de base  : {url}")
    print(f"    ➔ En-têtes appliqués :")
    for k, v in headers.items():
        print(f"       - {k}: {v}")

    req = urllib.request.Request(url, headers=headers)
    
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw_bytes = response.read()
            
            # Décompression Gzip automatique si le serveur l'a compressé
            if response.info().get('Content-Encoding') == 'gzip' or raw_bytes.startswith(b'\x1f\x8b'):
                raw_bytes = gzip.decompress(raw_bytes)
                
            m3u8_text = raw_bytes.decode('utf-8', errors='ignore')
            
            # Réécriture des URL relatives en URL absolues (Crucial pour la lecture locale)
            final_m3u8 = make_absolute_urls(m3u8_text, url)
            
            with open(out_file, "w", encoding="utf-8") as f:
                f.write(final_m3u8)
                
            print(f"\n[✓] Succès ! Le fichier de playlist à jour a été créé : '{out_file}'")
            print("[*] Vous pouvez maintenant ouvrir ce fichier directement dans VLC ou votre lecteur !")
            
    except urllib.error.HTTPError as e:
        print(f"[!] Erreur du serveur (HTTP {e.code}) : {e.reason}")
        print("    Vérifiez que le Referer ou le User-Agent n'a pas expiré.")
    except Exception as e:
        print(f"[!] Erreur : {e}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        lien = sys.argv[1]
    else:
        lien = input("Collez le lien m3u8 brut (avec les '|') : ")
        
    download_stream_playlist(lien, OUTPUT_FILENAME)