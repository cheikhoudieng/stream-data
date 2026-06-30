// /api/proxy.js — proxy CORS pour flux HLS/segments + binaires
// Déploie ce fichier tel quel dans le dossier /api à la racine du projet Vercel.

export const config = {
  api: {
    responseLimit: false, // autorise les segments vidéo volumineux
  },
};

export default async function handler(req, res) {
  const { url } = req.query;

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

  try {
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;
    // Ajoute ici d'éventuels en-têtes requis par la source (User-Agent custom, Referer, etc.)
    // upstreamHeaders['Referer'] = 'https://exemple.com';

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
      // qu'elle repasse par ce même proxy, sinon seul le manifeste serait
      // débloqué et les segments resteraient bloqués par CORS.
      const text = await upstream.text();
      const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const rewritten = text
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          const absolute = trimmed.startsWith('http') ? trimmed : base + trimmed;
          return `/api/proxy?url=${encodeURIComponent(absolute)}`;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(rewritten);
    }

    // Segments / fichiers binaires : on relaie tel quel, en streamant.
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