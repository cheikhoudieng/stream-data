// /api/proxy.js — proxy CORS + injection d'en-têtes pour flux HLS/segments.
// Déploie ce fichier tel quel dans le dossier /api à la racine du projet Vercel.

export const config = {
  api: {
    responseLimit: false, // autorise les segments vidéo volumineux
  },
};

// Décode le paramètre `headers` (JSON base64, potentiellement encodé une
// fois de plus par la query string) construit côté client par
// encodeHeadersParam(). Best-effort : si le décodage échoue, on continue
// sans ces en-têtes plutôt que de faire échouer toute la requête.
function decodeHeadersParam(param) {
  if (!param) return {};
  const tryDecode = (value) => {
    try {
      const json = Buffer.from(value, 'base64').toString('utf-8');
      const parsed = JSON.parse(json);
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return null;
    }
  };

  // req.query est déjà URL-décodé par Vercel/Node, mais on retente un
  // decodeURIComponent au cas où la valeur ait été double-encodée.
  return tryDecode(param) || tryDecode(decodeURIComponent(param)) || {};
}

export default async function handler(req, res) {
  const { url, headers: headersParam } = req.query;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    return res.status(204).end();
  }

  if (!url) return res.status(400).send('Paramètre "url" manquant');

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
  } catch {
    return res.status(400).send('URL invalide');
  }

  const customHeaders = decodeHeadersParam(headersParam);

  try {
    // Node/serverless n'a pas la liste d'en-têtes interdits du navigateur :
    // Referer, User-Agent, Cookie, Origin passent sans problème ici.
    const upstreamHeaders = { ...customHeaders };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const upstream = await fetch(targetUrl, { headers: upstreamHeaders });
    const contentType = upstream.headers.get('content-type') || '';
    const isManifest =
      targetUrl.split('?')[0].toLowerCase().endsWith('.m3u8') ||
      contentType.includes('mpegurl');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

    if (isManifest) {
      // Réécrit chaque ligne de playlist (segments + sous-playlists) pour
      // qu'elle repasse par ce même proxy AVEC les mêmes en-têtes, sinon
      // seul le manifeste serait débloqué et les segments resteraient soit
      // bloqués par CORS, soit rejetés faute de Referer/User-Agent valide.
      const text = await upstream.text();
      const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const headersQuery = headersParam ? `&headers=${encodeURIComponent(headersParam)}` : '';

      const rewritten = text
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          const absolute = trimmed.startsWith('http') ? trimmed : base + trimmed;
          return `/api/proxy?url=${encodeURIComponent(absolute)}${headersQuery}`;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(rewritten);
    }

    // Segments / fichiers binaires (y compris progressive mp4) : on relaie
    // tel quel, en streamant, avec le statut d'origine (200 ou 206 partiel).
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) return;
      res.setHeader(key, value);
    });

    const arrayBuffer = await upstream.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    res.status(502).send('Erreur proxy : ' + e.message);
  }
}