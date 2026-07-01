/**
 * Cloudflare Worker — Media Proxy
 *
 * Responsabilités :
 *  1. Ajouter des headers "forbidden" (Referer, User-Agent, Cookie, Origin)
 *     que le navigateur interdit côté client mais que le Worker peut envoyer.
 *  2. Garantir CORS sur toutes les réponses (manifests, segments, clés).
 *  3. Réécrire les URLs de segments dans les manifests HLS (.m3u8) pour
 *     qu'ils passent eux aussi par ce proxy (single-hop, pas de double-proxy).
 *  4. Passer les requêtes DASH telles quelles (Shaka gère ses propres retries).
 *
 * Déploiement :
 *   wrangler deploy
 *
 * Variable d'environnement attendue côté Vercel :
 *   VITE_PROXY_URL=https://proxy.yourdomain.workers.dev
 * export CLOUDFLARE_API_TOKEN="VOTRE_JETON_COPIÉ_ICI"
 */

const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Décoder le paramètre `headers` : base64(encodeURIComponent(JSON)) → objet */
function decodeHeadersParam(param: string | null): Record<string, string> {
  if (!param) return {};
  try {
    const base64 = decodeURIComponent(param);
    const json = atob(base64);
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Réécrire les lignes d'un manifest HLS pour router chaque segment / sous-playlist
 * à travers ce même proxy avec les mêmes headers.
 * Les lignes de tags (#EXT-X-...) et lignes vides sont laissées intactes.
 */
function rewriteM3U8(
  text: string,
  targetUrl: string,
  proxyBase: string,
  headersParam: string | null
): string {
  const base = new URL(targetUrl);
  const baseDir = base.href.substring(0, base.href.lastIndexOf('/') + 1);

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      // URL relative → absolue
      const absolute = trimmed.startsWith('http')
        ? trimmed
        : new URL(trimmed, baseDir).href;

      // Déjà proxié (ne doit pas arriver en pratique, mais sécurité)
      if (absolute.includes('/proxy?url=')) return line;

      let proxied = `${proxyBase}?url=${encodeURIComponent(absolute)}`;
      if (headersParam) proxied += `&headers=${headersParam}`;
      return proxied;
    })
    .join('\n');
}

export default {
  async fetch(request: Request): Promise<Response> {
    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get('url');
    const headersParam = reqUrl.searchParams.get('headers');

    if (!targetUrl) {
      return new Response('Missing `url` query parameter', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    // Whitelist basique : n'accepter que http(s)
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return new Response('Invalid url scheme', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    // Construire les headers vers l'origine
    const extraHeaders = decodeHeadersParam(headersParam);
    const outgoingHeaders: Record<string, string> = {
      'User-Agent': extraHeaders['User-Agent'] ?? DEFAULT_UA,
    };
    for (const [k, v] of Object.entries(extraHeaders)) {
      outgoingHeaders[k] = v;
    }

    // Range forwarding (segments téléchargés en morceaux par les players)
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) outgoingHeaders['Range'] = rangeHeader;

    let originResponse: Response;
    try {
      originResponse = await fetch(targetUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: outgoingHeaders,
        // Pas de cache CF pour les streams live
        cf: { cacheEverything: false },
        redirect: 'follow',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Upstream fetch failed: ${msg}`, {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
      });
    }

    // Headers de réponse nettoyés (supprimer ceux qui causeraient des conflits)
    const responseHeaders = new Headers(CORS_HEADERS);
    const PASSTHROUGH = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ];
    for (const h of PASSTHROUGH) {
      const v = originResponse.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }
    responseHeaders.set('Cache-Control', 'no-cache, no-store');

    // HEAD → pas de body
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders,
      });
    }

    const contentType = originResponse.headers.get('content-type') ?? '';
    const isM3U8 =
      targetUrl.toLowerCase().includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl');

    // Manifest HLS : réécrire les segments
    if (isM3U8 && originResponse.ok) {
      const text = await originResponse.text();
      const proxyBase = `${reqUrl.origin}/proxy`;
      const rewritten = rewriteM3U8(text, targetUrl, proxyBase, headersParam);

      responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
      return new Response(rewritten, {
        status: 200,
        headers: responseHeaders,
      });
    }

    // Tout le reste (segments TS/fMP4, DASH manifests, clés) : stream direct
    return new Response(originResponse.body, {
      status: originResponse.status,
      headers: responseHeaders,
    });
  },
};