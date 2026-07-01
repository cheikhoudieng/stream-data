"""
proxy.py — Proxy CORS + injection d'en-têtes pour flux HLS/segments.

Route les requêtes de lecture vidéo (manifestes .m3u8 + segments) à travers
le serveur pour appliquer des en-têtes que le navigateur interdit de définir
en JS (Referer, User-Agent, Cookie, Origin), et pour garantir le CORS peu
importe ce que renvoie le CDN d'origine.

Lancement dev  : python proxy.py
Lancement prod : gunicorn -c gunicorn_conf.py wsgi:app
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import os
import socket
from urllib.parse import unquote, urljoin, urlparse, quote

import requests
from flask import Flask, request, Response, stream_with_context, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix

# --------------------------------------------------------------------------
# Config (via variables d'environnement — jamais de secrets en dur)
# --------------------------------------------------------------------------

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*")  # ex: "https://tonsite.com,https://www.tonsite.com"
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "15"))
MAX_HEADERS_PARAM_LEN = int(os.environ.get("MAX_HEADERS_PARAM_LEN", "4096"))
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", str(64 * 1024)))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

# En-têtes qu'on ne relaie jamais depuis la requête entrante vers l'upstream
# (Host/Content-Length dépendent de la connexion locale, pas de l'upstream).
REQUEST_HEADERS_TO_SKIP = {"host", "connection", "content-length"}

# En-têtes de la réponse upstream qu'on ne recopie jamais tels quels : soit
# ils dépendent de l'encodage de transport (géré différemment ici),
# soit ils casseraient la réponse si copiés tels quels.
RESPONSE_HEADERS_TO_SKIP = {
    "content-encoding", "content-length", "transfer-encoding", "connection",
}

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s [proxy] %(message)s",
)
logger = logging.getLogger("proxy")


# --------------------------------------------------------------------------
# Garde-fou SSRF : ce endpoint accepte une URL arbitraire en paramètre, donc
# exposé publiquement il peut être détourné pour sonder ton réseau interne
# (169.254.169.254 metadata AWS/GCP, 127.0.0.1, IPs privées, etc.). On
# résout le hostname et on rejette toute IP non publique avant de fetcher.
# --------------------------------------------------------------------------

def _is_public_ip(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def validate_target_url(raw_url: str) -> str | None:
    """Retourne l'URL nettoyée si elle est acceptable, sinon None."""
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return None

    if parsed.scheme not in ("http", "https"):
        return None
    if not parsed.hostname:
        return None
    if not _is_public_ip(parsed.hostname):
        logger.warning("URL rejetée (IP non publique) : %s", parsed.hostname)
        return None

    return raw_url


# --------------------------------------------------------------------------
# Décodage du paramètre `headers`
# --------------------------------------------------------------------------

def decode_headers_param(param: str | None) -> dict:
    """Décode le paramètre `headers` (JSON base64, potentiellement encodé
    une fois de plus par la query string) construit côté client par
    encodeHeadersParam(). Best-effort : si le décodage échoue on continue
    sans ces en-têtes plutôt que de faire échouer toute la requête."""
    if not param:
        return {}
    if len(param) > MAX_HEADERS_PARAM_LEN:
        logger.warning("Paramètre headers trop long, ignoré (%d octets)", len(param))
        return {}

    for candidate in (param, unquote(param)):
        try:
            padded = candidate + "=" * (-len(candidate) % 4)
            decoded = base64.b64decode(padded, validate=False).decode("utf-8")
            parsed = json.loads(decoded)
            if isinstance(parsed, dict):
                # On force tout en str pour éviter d'injecter un type
                # inattendu dans un header HTTP sortant.
                return {str(k): str(v) for k, v in parsed.items()}
        except Exception:
            continue
    return {}


# --------------------------------------------------------------------------
# App factory
# --------------------------------------------------------------------------

def create_app() -> Flask:
    app = Flask(__name__)
    # Derrière un reverse proxy (nginx, Render, Fly.io...) pour que
    # request.headers reflète le vrai client, pas le proxy interne.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    session = requests.Session()

    def cors_headers(resp: Response) -> Response:
        origin = request.headers.get("Origin")
        if ALLOWED_ORIGINS == "*":
            resp.headers["Access-Control-Allow-Origin"] = "*"
        elif origin and origin in ALLOWED_ORIGINS.split(","):
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
        return resp

    @app.route("/api/proxy", methods=["GET", "OPTIONS"])
    def proxy():
        if request.method == "OPTIONS":
            return cors_headers(Response(status=204))

        raw_url = request.args.get("url")
        headers_param = request.args.get("headers")

        if not raw_url:
            return cors_headers(jsonify(error="Paramètre 'url' manquant")), 400

        try:
            target_url = unquote(raw_url)
        except Exception:
            return cors_headers(jsonify(error="URL invalide")), 400

        target_url = validate_target_url(target_url)
        if not target_url:
            return cors_headers(jsonify(error="URL non autorisée")), 400

        custom_headers = decode_headers_param(headers_param)

        # Node/Python côté serveur n'ont pas la liste d'en-têtes interdits
        # du navigateur : Referer, User-Agent, Cookie, Origin passent sans
        # problème ici.
        upstream_headers = dict(custom_headers)
        if "Range" in request.headers:
            upstream_headers["Range"] = request.headers["Range"]
        upstream_headers.setdefault(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )

        try:
            upstream = session.get(
                target_url,
                headers=upstream_headers,
                stream=True,
                timeout=UPSTREAM_TIMEOUT,
                allow_redirects=True,
            )
        except requests.exceptions.Timeout:
            logger.warning("Timeout upstream : %s", target_url)
            return cors_headers(jsonify(error="Timeout en amont")), 504
        except requests.RequestException as e:
            logger.error("Erreur upstream : %s — %s", target_url, e)
            return cors_headers(jsonify(error=f"Erreur proxy : {e}")), 502

        content_type = upstream.headers.get("content-type", "")
        is_manifest = (
            target_url.split("?")[0].lower().endswith(".m3u8")
            or "mpegurl" in content_type
        )

        if is_manifest:
            resp = _handle_manifest(upstream, target_url, headers_param)
        else:
            resp = _handle_binary(upstream)

        return cors_headers(resp)

    def _handle_manifest(upstream: requests.Response, target_url: str, headers_param: str | None) -> Response:
        # Réécrit chaque ligne de playlist (segments + sous-playlists) pour
        # qu'elle repasse par ce même proxy AVEC les mêmes en-têtes — sinon
        # seul le manifeste serait débloqué et les segments resteraient
        # bloqués par CORS ou rejetés faute de Referer/User-Agent valide.
        try:
            text = upstream.text
        finally:
            upstream.close()

        base = target_url.rsplit("/", 1)[0] + "/"
        headers_query = f"&headers={quote(headers_param)}" if headers_param else ""

        rewritten_lines = []
        for line in text.split("\n"):
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#"):
                rewritten_lines.append(line)
                continue
            absolute = trimmed if trimmed.startswith("http") else urljoin(base, trimmed)
            rewritten_lines.append(
                f"/api/proxy?url={quote(absolute, safe='')}{headers_query}"
            )

        return Response(
            "\n".join(rewritten_lines),
            status=200,
            mimetype="application/vnd.apple.mpegurl",
        )

    def _handle_binary(upstream: requests.Response) -> Response:
        # Segments / fichiers binaires (y compris progressive mp4) :
        # streamés chunk par chunk, avec le statut d'origine (200 ou 206
        # partiel) — indispensable pour que le seek fonctionne côté lecteur.
        def generate():
            try:
                for chunk in upstream.iter_content(chunk_size=CHUNK_SIZE):
                    if chunk:
                        yield chunk
            finally:
                upstream.close()

        resp = Response(stream_with_context(generate()), status=upstream.status_code)
        for k, v in upstream.headers.items():
            if k.lower() not in RESPONSE_HEADERS_TO_SKIP:
                resp.headers[k] = v
        return resp

    @app.route("/healthz")
    def healthz():
        return jsonify(status="ok"), 200

    @app.errorhandler(404)
    def not_found(_e):
        return cors_headers(jsonify(error="Not found")), 404

    @app.errorhandler(500)
    def server_error(e):
        logger.exception("Erreur non gérée")
        return cors_headers(jsonify(error="Erreur interne")), 500

    return app


app = create_app()

if __name__ == "__main__":
    # Dev uniquement — en prod, utiliser gunicorn (voir wsgi.py + gunicorn_conf.py).
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)