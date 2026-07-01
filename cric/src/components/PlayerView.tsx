import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Lock, Unlock, PictureInPicture, Tv, Captions, Languages, RefreshCw, Settings } from 'lucide-react';
import { EventItem } from '../types';

interface Source {
  url: string;
  format: string;
  drmType: string;
  licenseUrl: string;
  clearkeys: string;
  headers: Record<string, string>;
  resizeMode: 'contain' | 'cover' | 'fill';
  label: string;
}

interface TrackOption {
  id: number | string;
  label: string;
  language?: string;
}

const resizeModes = ['contain', 'cover', 'fill'] as const;
const resizeLabels = { contain: 'AJUSTER', cover: 'ZOOM', fill: 'REMPLIR' };

const MAX_AUTO_RETRIES = 5;
const MAX_SOFT_RECOVERIES = 3; // network/media recoveries before a full reload
const STALL_CHECK_MS = 3000;
const STALL_TICKS_BEFORE_ACTION = 3; // ~9s stuck before we nudge
const MAX_NUDGES_BEFORE_RELOAD = 2;
const CONTROLS_HIDE_MS = 3500;
const RESUME_STORAGE_PREFIX = 'cicaw_pos_';
const VOLUME_STORAGE_KEY = 'cicaw_player_volume';

const FORBIDDEN_HEADERS = [
  'user-agent', 'referer', 'cookie', 'host', 'origin', 'content-length',
  'connection', 'via', 'accept-charset', 'accept-encoding', 'date', 'dnt', 'expect', 'keep-alive',
  'trailer', 'transfer-encoding', 'upgrade'
];

let shakaPolyfillsInstalled = false;
function ensureShakaPolyfills() {
  if (!shakaPolyfillsInstalled) {
    shaka.polyfill.installAll();
    shakaPolyfillsInstalled = true;
  }
}

function safeStorageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeStorageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* quota / privacy mode — ignore */ }
}
function safeStorageRemove(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}
function positionKey(url: string) {
  return RESUME_STORAGE_PREFIX + encodeURIComponent(url).slice(0, 180);
}

function fmtTime(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function hexToBase64Url(hex: string) {
  hex = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseClearkeyLines(text: string) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [kid, k] = line.split(':').map(s => s.trim());
    return { kid, k };
  }).filter(p => p.kid && p.k);
}

function detectFormat(url: string, override: string) {
  if (override && override !== 'auto') return override;
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.m3u8')) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  return 'progressive';
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A subset of Referer/User-Agent/Cookie/Origin cannot be set by browser JS
// at all (Fetch spec "forbidden request headers") — trying to set them via
// hls.js xhrSetup or Shaka's request filter is silently ignored. The only
// way to apply them is server-side, via our /api/proxy function.
const BROWSER_FORBIDDEN_HEADERS = ['user-agent', 'referer', 'cookie', 'origin', 'host'];

interface ParsedLink {
  url: string;
  headers: Record<string, string>;
}

// Mirrors the backend's parse_custom_link(raw_string): splits
// "https://host/path.m3u8|Referer=https://x.com&User-Agent=Foo&X-Token=abc"
// into a clean URL plus a headers map. Unknown keys are kept as-is so
// arbitrary custom headers (tokens, signatures, etc.) also pass through.
function parseCustomLink(raw: string): ParsedLink {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
  if (!raw) return { url: '', headers };

  const pipeIdx = raw.indexOf('|');
  if (pipeIdx < 0) return { url: raw.trim(), headers: {} };

  const url = raw.slice(0, pipeIdx).trim();
  const headersString = raw.slice(pipeIdx + 1).trim();

  headersString.split('&').forEach(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) return;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (!key) return;
    const keyLower = key.toLowerCase();
    if (keyLower === 'referer' || keyLower === 'referrer') headers['Referer'] = val;
    else if (keyLower === 'user-agent') headers['User-Agent'] = val;
    else if (keyLower === 'origin') headers['Origin'] = val;
    else if (keyLower === 'cookie') headers['Cookie'] = val;
    else headers[key] = val;
  });

  return { url, headers };
}

// UTF-8 safe base64 encoding for header values (accents, etc.) that then
// gets URL-encoded once more so it survives as a single query param.
function encodeHeadersParam(headers: Record<string, string>): string {
  const json = JSON.stringify(headers);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return encodeURIComponent(base64);
}

// Routes a source through our serverless proxy (/api/proxy.js) so that
// forbidden headers get applied server-side, and so CORS is guaranteed
// regardless of whether the origin CDN sends Access-Control-Allow-Origin.
function buildProxiedUrl(url: string, headers: Record<string, string>): string {
  const hasHeaders = Object.keys(headers).length > 0;
  const base = `/api/proxy?url=${encodeURIComponent(url)}`;
  return hasHeaders ? `${base}&headers=${encodeHeadersParam(headers)}` : base;
}

// Friendly, non-technical messages for the small set of native
// HTMLMediaElement error codes — shown to the user instead of "code 3".
function mediaErrorMessage(code?: number) {
  switch (code) {
    case 1: return 'Lecture interrompue.';
    case 2: return 'Erreur réseau pendant le chargement.';
    case 3: return 'Le flux est corrompu ou mal encodé.';
    case 4: return "Ce format n'est pas supporté par votre navigateur.";
    default: return 'Erreur de lecture inconnue.';
  }
}

export interface StreamSource {
  url: string;
  name: string;
  type: string;
  drmType?: string;
  clearkeys?: string;
  licenseUrl?: string;
}

export function PlayerView({ 
  initialStreams,
  events = [],
  onPlayStream,
  categoryLogos = {}
}: { 
  initialStreams?: StreamSource[] | null;
  events?: EventItem[];
  onPlayStream?: (streams: StreamSource[]) => void;
  categoryLogos?: Record<string, string>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const tracksMenuRef = useRef<HTMLDivElement>(null);
  
  const hlsRef = useRef<any>(null);
  const shakaRef = useRef<any>(null);
  const isMountedRef = useRef(true);

  const [sources, setSources] = useState<Source[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  const [volume, setVolume] = useState(1);

  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [qualityLevels, setQualityLevels] = useState<TrackOption[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<number | string>(-1);
  const [activeAudioId, setActiveAudioId] = useState<number | string>(-1);
  const [activeQualityId, setActiveQualityId] = useState<number | string>(-1);
  const [tracksMenuOpen, setTracksMenuOpen] = useState<'subtitles' | 'audio' | 'quality' | null>(null);

  const [retryAttempt, setRetryAttempt] = useState(0);
  const [friendlyError, setFriendlyError] = useState('');
  const retryCountRef = useRef(0);
  const networkErrorCountRef = useRef(0);
  const mediaErrorCountRef = useRef(0);
  const stallTicksRef = useRef(0);
  const nudgeAttemptsRef = useRef(0);
  const lastTimeRef = useRef(0);
  const lastSaveRef = useRef(0);

  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [status, setStatus] = useState<'ARRÊTÉ' | 'CHARGEMENT' | 'LECTURE' | 'PAUSE' | 'TERMINÉ' | 'ERREUR'>('ARRÊTÉ');

  const sourcesRef = useRef<Source[]>([]);
  const activeIndexRef = useRef(-1);
  const loadSourceRef = useRef<((idx: number, isRetry?: boolean) => void) | undefined>(undefined);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Restore persisted volume once on mount
  useEffect(() => {
    const saved = safeStorageGet(VOLUME_STORAGE_KEY);
    if (saved !== null) {
      const v = parseFloat(saved);
      if (!isNaN(v) && v >= 0 && v <= 1) setVolume(v);
    }
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (initialStreams && initialStreams.length > 0) {
      const parsedSources: Source[] = initialStreams.map((is, idx) => {
        // "https://host/x.m3u8|Referer=...&User-Agent=...&X-Token=..."
        const { url: cleanUrl, headers: parsedHeaders } = parseCustomLink(is.url);
        const needsHeaders = Object.keys(parsedHeaders).length > 0;
        const format = detectFormat(cleanUrl, is.type || 'auto');

        // Referer/User-Agent/Cookie/Origin can never be set from browser JS,
        // so any link carrying headers must go through the serverless proxy
        // (which also guarantees CORS regardless of the origin CDN).
        //
        // HLS and progressive (single file) sources are proxied wholesale at
        // the top URL — for HLS the proxy also rewrites every segment/sub
        // playlist URL inside the manifest text to keep the same headers.
        //
        // DASH is different: Shaka resolves <BaseURL>/SegmentTemplate paths
        // relative to whatever URL it thinks the manifest came from. If we
        // proxy the top URL, that resolution breaks. Instead we keep the
        // real URL here and let Shaka's own request filter (set up in
        // loadSource) rewrite each already-resolved segment/manifest
        // request through the proxy at fetch time.
        const shouldProxyTopUrl = needsHeaders && format !== 'dash';
        const playbackUrl = shouldProxyTopUrl ? buildProxiedUrl(cleanUrl, parsedHeaders) : cleanUrl;

        return {
          url: playbackUrl,
          format,
          drmType: is.drmType || 'none',
          licenseUrl: is.licenseUrl || '',
          clearkeys: is.clearkeys || '',
          // Only DASH still needs headers on the Source: HLS/progressive
          // already have them baked into the proxied URL above.
          headers: format === 'dash' ? parsedHeaders : {},
          resizeMode: 'contain',
          label: is.name || `Server ${idx + 1}`
        };
      });
      
      setSources(parsedSources);
      sourcesRef.current = parsedSources;
      loadSource(0);
    }
  }, [initialStreams]); // eslint-disable-line react-hooks/exhaustive-deps

  const addLog = useCallback((msg: string, level: 'info' | 'warn' | 'error' | 'ok' = 'info') => {
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
  }, []);

  const destroyEngines = useCallback(() => {
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (e) {}
      hlsRef.current = null;
    }
    if (shakaRef.current) {
      try { shakaRef.current.destroy(); } catch (e) {}
      shakaRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch (e) {}
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    setIsPlaying(false);
  }, []);

  const attemptPlay = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {
        addLog('Lecture automatique bloquée par le navigateur — cliquez sur lecture.', 'warn');
        setIsLoading(false);
      });
    }
  }, [addLog]);

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Auto-retry: fires immediately (no delay) on unrecoverable fatal errors,
  // up to MAX_AUTO_RETRIES, then surfaces a manual retry button.
  const scheduleRetry = useCallback((idx: number) => {
    if (!isMountedRef.current || idx < 0) return;
    if (retryCountRef.current >= MAX_AUTO_RETRIES) {
      addLog(`Échec après ${MAX_AUTO_RETRIES} tentatives automatiques.`, 'error');
      setRetryAttempt(retryCountRef.current);
      setFriendlyError(`Impossible de lire ce flux après ${MAX_AUTO_RETRIES} tentatives.`);
      setStatus('ERREUR');
      setIsLoading(false);
      return;
    }
    retryCountRef.current += 1;
    setRetryAttempt(retryCountRef.current);
    addLog(`Reconnexion automatique (tentative ${retryCountRef.current}/${MAX_AUTO_RETRIES})...`, 'warn');
    loadSourceRef.current?.(idx, true);
  }, [addLog]);

  const refreshHlsTracks = useCallback((hls: any) => {
    const subs: TrackOption[] = (hls.subtitleTracks || []).map((t: any) => ({
      id: t.id,
      label: t.name || t.lang || `Sous-titres ${t.id + 1}`,
      language: t.lang
    }));
    setSubtitleTracks(subs);
    setActiveSubtitleId(hls.subtitleTrack);

    const auds: TrackOption[] = (hls.audioTracks || []).map((t: any) => ({
      id: t.id,
      label: t.name || t.lang || `Audio ${t.id + 1}`,
      language: t.lang
    }));
    setAudioTracks(auds);
    setActiveAudioId(hls.audioTrack);
  }, []);

  const refreshHlsQualities = useCallback((hls: any) => {
    const levels: TrackOption[] = (hls.levels || []).map((lvl: any, i: number) => ({
      id: i,
      label: lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate || 0) / 1000)} kbps`
    }));
    setQualityLevels(levels);
    setActiveQualityId(hls.autoLevelEnabled ? -1 : hls.currentLevel);
  }, []);

  const refreshShakaTracks = useCallback((player: any, preferredLanguage?: string) => {
    try {
      const texts = player.getTextTracks();
      setSubtitleTracks(texts.map((t: any) => ({
        id: t.id,
        label: t.label || t.language || `Sous-titres ${t.id}`,
        language: t.language
      })));
      setActiveSubtitleId(-1); // sous-titres masqués par défaut

      const variants = player.getVariantTracks();
      const seenLangs = new Set<string>();
      const auds: TrackOption[] = [];
      variants.forEach((t: any) => {
        if (!t.language || seenLangs.has(t.language)) return;
        seenLangs.add(t.language);
        auds.push({ id: t.language, label: t.language });
      });
      setAudioTracks(auds);
      const activeVariant = variants.find((t: any) => t.active);
      const language = preferredLanguage || (activeVariant ? activeVariant.language : undefined);
      setActiveAudioId(activeVariant ? activeVariant.language : -1);

      // Quality levels are scoped to the current audio language, since
      // Shaka variant tracks bundle audio+video together.
      const filtered = language ? variants.filter((t: any) => t.language === language) : variants;
      const seenHeights = new Set<number>();
      const qualities: TrackOption[] = [];
      filtered.forEach((t: any) => {
        if (t.height && !seenHeights.has(t.height)) {
          seenHeights.add(t.height);
          qualities.push({ id: t.id, label: `${t.height}p` });
        }
      });
      qualities.sort((a, b) => parseInt(b.label) - parseInt(a.label));
      setQualityLevels(qualities);
      const abrEnabled = player.getConfiguration().abr.enabled;
      setActiveQualityId(abrEnabled ? -1 : (activeVariant ? activeVariant.id : -1));
    } catch (e) {
      addLog('Impossible de récupérer les pistes audio/sous-titres/qualité.', 'warn');
    }
  }, [addLog]);

  const loadSource = useCallback(async (idx: number, isRetry = false) => {
    const source = sourcesRef.current[idx];
    if (!source || !isMountedRef.current) return;

    if (!isRetry) {
      retryCountRef.current = 0;
      networkErrorCountRef.current = 0;
      mediaErrorCountRef.current = 0;
      stallTicksRef.current = 0;
      nudgeAttemptsRef.current = 0;
      setRetryAttempt(0);
      setFriendlyError('');
    }

    setActiveIndex(idx);
    destroyEngines();
    setIsLoading(true);
    setStatus('CHARGEMENT');
    setSubtitleTracks([]);
    setAudioTracks([]);
    setQualityLevels([]);
    setActiveSubtitleId(-1);
    setActiveAudioId(-1);
    setActiveQualityId(-1);
    setTracksMenuOpen(null);

    if (videoRef.current) {
      videoRef.current.style.objectFit = source.resizeMode;
      videoRef.current.volume = volume;
    }

    if (source.format === 'hls') {
      if (Hls.isSupported()) {
        const hlsConfig: any = {
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
          enableWorker: true,
          lowLatencyMode: true,
          capLevelToPlayerSize: true, // évite de charger une qualité plus grande que la taille réelle du lecteur
          xhrSetup: (xhr: XMLHttpRequest) => {
            Object.entries(source.headers).forEach(([k, v]) => {
              try { xhr.setRequestHeader(k, v as string); } catch (e) {}
            });
          }
        };

        if (source.drmType !== 'none' && source.licenseUrl) {
          hlsConfig.emeEnabled = true;
          const sysMap: Record<string, string> = { widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready', clearkey: 'org.w3.clearkey' };
          hlsConfig.drmSystems = {
            [sysMap[source.drmType]]: { licenseUrl: source.licenseUrl }
          };
          addLog('Configuration DRM HLS (EME) activée.', 'ok');
        }

        const hls = new Hls(hlsConfig);
        hlsRef.current = hls;
        
        hls.on(Hls.Events.ERROR, (evt: any, data: any) => {
          if (!isMountedRef.current) return;

          if (!data.fatal) {
            // Non-fatal hiccups (dropped frames, single segment 404, etc.)
            // are normal on live/flaky streams — log only, HLS.js self-heals.
            return;
          }

          addLog(`Erreur HLS fatale : ${data.type} — ${data.details}`, 'error');

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              networkErrorCountRef.current += 1;
              if (networkErrorCountRef.current <= MAX_SOFT_RECOVERIES) {
                addLog('Erreur réseau — relance du chargement sans réinitialiser le lecteur...', 'warn');
                hls.startLoad();
                return;
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              mediaErrorCountRef.current += 1;
              if (mediaErrorCountRef.current <= MAX_SOFT_RECOVERIES) {
                addLog('Erreur média — tentative de récupération...', 'warn');
                hls.recoverMediaError();
                return;
              }
              break;
          }
          // Recovery attempts exhausted, or an unrecoverable error type — full reload.
          scheduleRetry(idx);
        });

        // Subtitle/audio tracks and quality levels are discovered from the
        // manifest and stay in sync with currentTime automatically — HLS.js
        // feeds them into the video element's native TextTrack cues, which
        // the browser renders against video.currentTime on every frame.
        hls.on(Hls.Events.MANIFEST_PARSED, () => { refreshHlsTracks(hls); refreshHlsQualities(hls); });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => refreshHlsTracks(hls));
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => refreshHlsTracks(hls));
        hls.on(Hls.Events.LEVEL_SWITCHED, () => refreshHlsQualities(hls));
        
        hls.loadSource(source.url);
        hls.attachMedia(videoRef.current!);
      } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = source.url;
        addLog('Lecture HLS native (Safari Apple).', 'ok');
      } else {
        addLog('HLS non supporté par ce navigateur.', 'error');
        setFriendlyError('Ce navigateur ne supporte pas la lecture HLS.');
        setStatus('ERREUR');
        setIsLoading(false);
        return;
      }
      attemptPlay();
    } else if (source.format === 'dash') {
      ensureShakaPolyfills();
      if (!shaka.Player.isBrowserSupported()) {
        addLog('Navigateur non supporté par Shaka Player', 'error');
        setFriendlyError("Ce navigateur n'est pas supporté pour la lecture DASH.");
        setStatus('ERREUR');
        setIsLoading(false);
        return;
      }

      const player = new shaka.Player(videoRef.current!);
      shakaRef.current = player;

      // Referer/User-Agent/Cookie/Origin sont des "forbidden request headers" —
      // Shaka appelle fetch()/XHR en interne, donc les assigner à
      // request.headers ici serait silencieusement ignoré par le navigateur,
      // exactement comme pour hls.js. La seule solution est de réécrire l'URI
      // déjà résolue (placeholders $Number$ etc. déjà substitués par Shaka
      // avant que ce filtre ne s'exécute) pour passer par notre proxy.
      //
      // Limité à MANIFEST/SEGMENT — les requêtes LICENSE sont des POST avec
      // un corps binaire (challenge DRM) que notre proxy GET-only ne peut
      // pas relayer.
      //
      // Piège : Shaka résout les chemins relatifs (<BaseURL>, SegmentTemplate)
      // d'un MPD contre response.uri de la requête MANIFEST. Comme le
      // manifeste est en réalité fetché via /api/proxy?url=..., response.uri
      // pointerait vers le chemin du proxy — cassant toute résolution
      // relative contre le vrai dossier du CDN. On garde donc une map
      // proxied → original (uniquement pour les manifestes, pas les
      // segments, pour ne pas la faire grossir sans borne sur un live) et on
      // restaure l'URI dans le response filter avant que le parseur DASH de
      // Shaka ne la lise.
      if (Object.keys(source.headers).length > 0) {
        const NetworkingEngine = shaka.net.NetworkingEngine;
        const netEngine = player.getNetworkingEngine();
        const manifestUriMap = new Map<string, string>();

        netEngine.registerRequestFilter((type: any, request: any) => {
          if (type !== NetworkingEngine.RequestType.MANIFEST && type !== NetworkingEngine.RequestType.SEGMENT) return;
          request.uris = request.uris.map((uri: string) => {
            if (uri.includes('/api/proxy')) return uri;
            const proxied = buildProxiedUrl(uri, source.headers);
            if (type === NetworkingEngine.RequestType.MANIFEST) manifestUriMap.set(proxied, uri);
            return proxied;
          });
        });

        netEngine.registerResponseFilter((type: any, response: any) => {
          if (type !== NetworkingEngine.RequestType.MANIFEST) return;
          const original = manifestUriMap.get(response.uri);
          if (original) {
            response.uri = original;
            // Certaines versions de Shaka gardent aussi originalUri séparément
            // pour la résolution relative — on la met à jour par sécurité.
            if ('originalUri' in response) response.originalUri = original;
          }
        });
      }

      player.addEventListener('error', (e: any) => {
        if (!isMountedRef.current) return;
        const error = e.detail;
        // Shaka has its own internal retry (via retryParameters below) for
        // recoverable network hiccups, so we only escalate on CRITICAL.
        if (error.severity === shaka.util.Error.Severity.RECOVERABLE) {
          addLog('Erreur récupérable Shaka : ' + error.code, 'warn');
          return;
        }
        addLog('Erreur Shaka critique : ' + error.code, 'error');
        scheduleRetry(idx);
      });

      const retryParameters = { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 0 };
      const shakaConfig: any = {
        streaming: {
          bufferingGoal: 30,
          rebufferingGoal: 2,
          bufferBehind: 30,
          retryParameters,
        },
        manifest: { retryParameters }
      };
      if (source.drmType === 'clearkey' && source.clearkeys) {
        const clearKeysMap: Record<string, string> = {};
        parseClearkeyLines(source.clearkeys).forEach(p => {
          clearKeysMap[p.kid] = p.k;
        });

        shakaConfig.drm = { clearKeys: clearKeysMap };
        shakaConfig.manifest.dash = { ignoreDrmInfo: true };
        addLog('Forçage des clés ClearKey (ignoreDrmInfo activé).', 'ok');
      } else if (source.drmType !== 'none' && source.licenseUrl) {
        const sysMap: Record<string, string> = { widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready' };
        shakaConfig.drm = { servers: { [sysMap[source.drmType]]: source.licenseUrl } };
      }

      player.configure(shakaConfig);

      player.load(source.url).then(() => {
        if (!isMountedRef.current) return;
        addLog('DASH chargé avec succès.', 'ok');
        // Shaka's own text/caption renderer is driven off video.currentTime
        // internally, so once a track is selected it stays frame-accurate
        // with the timeline without any extra wiring on our side.
        refreshShakaTracks(player);
        attemptPlay();
      }).catch((e: any) => {
        if (!isMountedRef.current) return;
        addLog('Erreur de chargement DASH : ' + e.message, 'error');
        scheduleRetry(idx);
      });

    } else {
      if (source.drmType === 'clearkey' && source.clearkeys) {
        setupNativeClearKey(videoRef.current!, source.clearkeys).then(() => {
          if (!isMountedRef.current) return;
          videoRef.current!.src = source.url;
          attemptPlay();
        });
      } else {
        if (source.drmType === 'widevine' || source.drmType === 'playready') {
          addLog(source.drmType.toUpperCase() + ' nécessite un manifeste HLS ou DASH en pratique.', 'warn');
        }
        videoRef.current!.src = source.url;
        attemptPlay();
      }
    }
  }, [destroyEngines, addLog, attemptPlay, scheduleRetry, refreshHlsTracks, refreshHlsQualities, refreshShakaTracks, volume]);

  useEffect(() => {
    loadSourceRef.current = loadSource;
  }, [loadSource]);

  const setupNativeClearKey = async (videoEl: HTMLVideoElement, clearkeysText: string) => {
    const pairs = parseClearkeyLines(clearkeysText);
    if (!pairs.length) { addLog('Aucune clé ClearKey valide fournie.', 'warn'); return; }
    if (!navigator.requestMediaKeySystemAccess) { addLog('EME non disponible dans ce navigateur.', 'error'); return; }
    
    try {
      const config = [{
        initDataTypes: ['cenc', 'keyids'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }]
      }];
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', config);
      const mediaKeys = await access.createMediaKeys();
      await videoEl.setMediaKeys(mediaKeys);
      
      videoEl.addEventListener('encrypted', async (e: any) => {
        try {
          const session = mediaKeys.createSession();
          session.addEventListener('message', async () => {
            const keysObj = {
              keys: pairs.map(p => ({ kty: 'oct', k: hexToBase64Url(p.k), kid: hexToBase64Url(p.kid) })),
              type: 'temporary'
            };
            await session.update(new TextEncoder().encode(JSON.stringify(keysObj)));
            addLog('Clés ClearKey injectées dans la session EME.', 'ok');
          }, { once: true });
          await session.generateRequest(e.initDataType, e.initData);
        } catch (err: any) { addLog('Erreur de session EME : ' + err.message, 'error'); }
      }, { once: true });
      addLog('ClearKey natif initialisé (EME).', 'ok');
    } catch (err: any) {
      addLog('Échec initialisation ClearKey : ' + err.message, 'error');
    }
  };

  // Subtitle/audio/quality selection — works across all three playback
  // engines and never has to "resync": native TextTrack cues and Shaka's
  // text displayer both render against video.currentTime continuously, so
  // once a track is on, it tracks the timeline on its own.
  const selectSubtitle = useCallback((id: number | string) => {
    if (hlsRef.current) {
      if (id === -1) {
        hlsRef.current.subtitleDisplay = false;
      } else {
        hlsRef.current.subtitleTrack = id as number;
        hlsRef.current.subtitleDisplay = true;
      }
      setActiveSubtitleId(id);
    } else if (shakaRef.current) {
      if (id === -1) {
        shakaRef.current.setTextTrackVisibility(false);
      } else {
        const track = shakaRef.current.getTextTracks().find((t: any) => t.id === id);
        if (track) {
          shakaRef.current.selectTextTrack(track);
          shakaRef.current.setTextTrackVisibility(true);
        }
      }
      setActiveSubtitleId(id);
    } else if (videoRef.current) {
      Array.from(videoRef.current.textTracks).forEach((t, i) => {
        t.mode = i === id ? 'showing' : 'disabled';
      });
      setActiveSubtitleId(id);
    }
    setTracksMenuOpen(null);
  }, []);

  const selectAudioTrack = useCallback((id: number | string) => {
    if (hlsRef.current) {
      hlsRef.current.audioTrack = id as number;
      setActiveAudioId(id);
    } else if (shakaRef.current) {
      const variants = shakaRef.current.getVariantTracks();
      const track = variants.find((t: any) => t.language === id);
      if (track) {
        // clearBuffer + a small safeMargin keeps playback within ~0.5s of
        // where it was, so the audio swap feels instant on the timeline.
        shakaRef.current.selectVariantTrack(track, true, 0.5);
        setActiveAudioId(id);
        refreshShakaTracks(shakaRef.current, id as string);
      }
    }
    setTracksMenuOpen(null);
  }, [refreshShakaTracks]);

  const selectQuality = useCallback((id: number | string) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = id === -1 ? -1 : (id as number); // -1 re-enables ABR
      setActiveQualityId(id);
    } else if (shakaRef.current) {
      if (id === -1) {
        shakaRef.current.configure({ abr: { enabled: true } });
      } else {
        shakaRef.current.configure({ abr: { enabled: false } });
        const track = shakaRef.current.getVariantTracks().find((t: any) => t.id === id);
        if (track) shakaRef.current.selectVariantTrack(track, true);
      }
      setActiveQualityId(id);
    }
    setTracksMenuOpen(null);
  }, []);

  // Close the subtitles/audio/quality popover on outside click
  useEffect(() => {
    if (!tracksMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tracksMenuRef.current && !tracksMenuRef.current.contains(e.target as Node)) {
        setTracksMenuOpen(null);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [tracksMenuOpen]);

  // Video Events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => { setIsPlaying(true); setStatus('LECTURE'); };
    const onPause = () => { setIsPlaying(false); setStatus('PAUSE'); };
    const onEnded = () => {
      setStatus('TERMINÉ');
      const src = sourcesRef.current[activeIndexRef.current];
      if (src) safeStorageRemove(positionKey(src.url));
    };
    const onWaiting = () => setIsLoading(true);
    const onPlaying = () => setIsLoading(false);
    const onCanPlay = () => setIsLoading(false);
    const onError = () => {
      const err = video.error;
      addLog('Erreur média' + (err ? ' (code ' + err.code + ')' : ''), 'error');
      setFriendlyError(mediaErrorMessage(err?.code));
      scheduleRetry(activeIndexRef.current);
    };

    const onLoadedMetadata = () => {
      const src = sourcesRef.current[activeIndexRef.current];
      if (!src || !video.duration) return;
      const saved = safeStorageGet(positionKey(src.url));
      if (saved) {
        const t = parseFloat(saved);
        if (t > 5 && t < video.duration - 15) {
          video.currentTime = t;
          addLog('Reprise à ' + fmtTime(t), 'info');
        }
      }
    };

    const onTimeUpdate = () => {
      if (video.duration) {
        setCurrentTime(video.currentTime);
        setDuration(video.duration);

        // Throttled resume-position save (every ~5s), skipped near start/end.
        const now = Date.now();
        if (now - lastSaveRef.current > 5000 && video.currentTime > 5 && video.currentTime < video.duration - 15) {
          lastSaveRef.current = now;
          const src = sourcesRef.current[activeIndexRef.current];
          if (src) safeStorageSet(positionKey(src.url), String(video.currentTime));
        }
      }
    };

    const onProgress = () => {
      if (video.duration && video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
    };

    const onVolumeChange = () => {
      setIsMuted(video.muted || video.volume === 0);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('loadstart', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('progress', onProgress);
    video.addEventListener('volumechange', onVolumeChange);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('loadstart', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('volumechange', onVolumeChange);
    };
  }, [addLog, scheduleRetry]);

  // Stall watchdog: some failures (dead CDN edge, silently stuck segment
  // fetch) never fire 'error' or 'waiting' — currentTime just stops
  // advancing while state still says "playing". We poll for that and
  // nudge (tiny seek) before escalating to a full reload.
  useEffect(() => {
    const id = setInterval(() => {
      if (!isMountedRef.current) return;
      const video = videoRef.current;
      if (!video || video.paused || video.ended) { stallTicksRef.current = 0; return; }
      if (status !== 'LECTURE') return;

      if (Math.abs(video.currentTime - lastTimeRef.current) < 0.15) {
        stallTicksRef.current += 1;
        if (stallTicksRef.current >= STALL_TICKS_BEFORE_ACTION) {
          stallTicksRef.current = 0;
          nudgeAttemptsRef.current += 1;
          if (nudgeAttemptsRef.current > MAX_NUDGES_BEFORE_RELOAD) {
            nudgeAttemptsRef.current = 0;
            addLog('Blocage persistant détecté — rechargement du flux.', 'warn');
            scheduleRetry(activeIndexRef.current);
          } else {
            addLog('Lecture bloquée détectée — tentative de reprise.', 'warn');
            try { video.currentTime = video.currentTime + 0.1; } catch {}
          }
        }
      } else {
        stallTicksRef.current = 0;
        nudgeAttemptsRef.current = 0;
      }
      lastTimeRef.current = video.currentTime;
    }, STALL_CHECK_MS);
    return () => clearInterval(id);
  }, [status, addLog, scheduleRetry]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLocked) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      
      const video = videoRef.current;
      if (!video) return;

      if (e.code === 'Space') {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'm') toggleMute();
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
      if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
      if (e.key === 'ArrowUp') { e.preventDefault(); handleVolumeChange(Math.min(1, volume + 0.1)); }
      if (e.key === 'ArrowDown') { e.preventDefault(); handleVolumeChange(Math.max(0, volume - 0.1)); }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLocked, volume]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    if (videoRef.current) {
      videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      const nextMuted = !videoRef.current.muted;
      videoRef.current.muted = nextMuted;
      if (!nextMuted && videoRef.current.volume === 0) {
        handleVolumeChange(1);
      }
      setIsMuted(nextMuted);
    }
  };

  const handleVolumeChange = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolume(clamped);
    if (videoRef.current) {
      videoRef.current.volume = clamped;
      videoRef.current.muted = clamped === 0;
      setIsMuted(clamped === 0);
    }
    safeStorageSet(VOLUME_STORAGE_KEY, String(clamped));
  }, []);

  const toggleResize = () => {
    if (videoRef.current && activeIndex >= 0) {
      const current = sources[activeIndex].resizeMode;
      const next = resizeModes[(resizeModes.indexOf(current) + 1) % resizeModes.length];
      videoRef.current.style.objectFit = next;
      const newSources = [...sources];
      newSources[activeIndex].resizeMode = next;
      setSources(newSources);
    }
  };

  // Cross-browser fullscreen, including iOS Safari where only the <video>
  // element itself supports native fullscreen (webkitEnterFullscreen) —
  // requestFullscreen on a container div silently fails there.
  const toggleFullscreen = () => {
    const doc = document as any;
    const container = containerRef.current as any;
    const video = videoRef.current as any;
    const isFs = document.fullscreenElement || doc.webkitFullscreenElement;

    if (!isFs) {
      if (container?.requestFullscreen) {
        container.requestFullscreen().catch(() => addLog('Plein écran indisponible', 'warn'));
      } else if (container?.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      } else if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      } else {
        addLog('Plein écran non supporté sur cet appareil', 'warn');
      }
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    }
  };

  const togglePip = () => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (videoRef.current?.requestPictureInPicture) {
      videoRef.current.requestPictureInPicture().catch(() => addLog('PiP indisponible', 'warn'));
    } else {
      addLog('Picture-in-Picture non supporté', 'warn');
    }
  };

  const retryNow = () => {
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setFriendlyError('');
    if (activeIndexRef.current >= 0) loadSource(activeIndexRef.current);
  };

  // Timeline scrub
  const seekFromEvent = useCallback((e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    if (!timelineRef.current || !videoRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as any).clientX;
    const x = clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, x / rect.width));
    if (videoRef.current.duration) {
      videoRef.current.currentTime = ratio * videoRef.current.duration;
    }
  }, []);

  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent | TouchEvent) => {
      if (scrubbing) seekFromEvent(e);
    };
    const handleGlobalEnd = () => setScrubbing(false);

    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('touchmove', handleGlobalMove, { passive: true });
    window.addEventListener('mouseup', handleGlobalEnd);
    window.addEventListener('touchend', handleGlobalEnd);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMove);
      window.removeEventListener('touchmove', handleGlobalMove);
      window.removeEventListener('mouseup', handleGlobalEnd);
      window.removeEventListener('touchend', handleGlobalEnd);
    };
  }, [scrubbing, seekFromEvent]);

  // Controls auto-hide (works on touch too, unlike CSS-only :hover) —
  // stays visible while paused, hides after a few idle seconds while playing.
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    if (isPlaying) {
      hideControlsTimerRef.current = setTimeout(() => {
        if (isMountedRef.current) setControlsVisible(false);
      }, CONTROLS_HIDE_MS);
    }
  }, [isPlaying]);

  useEffect(() => {
    showControlsTemporarily();
    return () => { if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current); };
  }, [isPlaying, showControlsTemporarily]);

  const handleVideoTap = () => {
    if (!controlsVisible) {
      showControlsTemporarily();
      return;
    }
    togglePlay();
    showControlsTemporarily();
  };

  const activeSource = activeIndex >= 0 ? sources[activeIndex] : null;
  const pct = duration ? (currentTime / duration) * 100 : 0;
  const bufPct = duration ? (bufferedEnd / duration) * 100 : 0;
  const activeQualityLabel = useMemo(() => {
    if (activeQualityId === -1) return 'AUTO';
    const found = qualityLevels.find(q => q.id === activeQualityId);
    return found ? found.label : 'AUTO';
  }, [activeQualityId, qualityLevels]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-200">
      <div className="flex flex-col gap-6 h-full max-w-full mx-auto w-full px-2 lg:px-6">
        {/* Left Col - Player & Recommendations */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          
          {/* Player Header Info */}
          <div className="flex items-center space-x-3 bg-slate-900 border border-slate-800 rounded-xl p-3 shrink-0">
            <span className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold tracking-widest ${
              activeSource ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30' : 'bg-slate-800 text-slate-500'
            }`}>
              FORMAT: {activeSource ? activeSource.format.toUpperCase() : '—'}
            </span>
            <span className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold tracking-widest ${
              activeSource?.drmType && activeSource.drmType !== 'none' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-500'
            }`}>
              DRM: {activeSource?.drmType && activeSource.drmType !== 'none' ? activeSource.drmType.toUpperCase() : (activeSource ? 'CLAIR' : '—')}
            </span>
            {qualityLevels.length > 0 && (
              <span className="px-2.5 py-1 rounded-md text-xs font-mono font-bold tracking-widest bg-slate-800 text-slate-400">
                {activeQualityLabel}
              </span>
            )}
            <span className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold tracking-widest ml-auto ${
              status === 'LECTURE' ? 'text-emerald-400 bg-emerald-500/10' :
              status === 'ERREUR' ? 'text-red-400 bg-red-500/10' :
              status === 'CHARGEMENT' ? 'text-amber-400 bg-amber-500/10' : 'text-slate-500 bg-slate-800'
            }`}>
              {status}{status === 'CHARGEMENT' && retryAttempt > 0 ? ` (${retryAttempt}/${MAX_AUTO_RETRIES})` : ''}
            </span>
          </div>

          {/* Player Frame */}
          <div 
            ref={containerRef}
            className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 shrink-0 group"
            onMouseMove={showControlsTemporarily}
            onTouchStart={showControlsTemporarily}
          >
            <video 
              ref={videoRef} 
              playsInline 
              preload="metadata"
              crossOrigin="anonymous"
              className="w-full h-full"
              style={{ objectFit: activeSource?.resizeMode || 'contain' }}
              onClick={handleVideoTap}
              aria-label={activeSource ? `Lecteur vidéo : ${activeSource.label}` : 'Lecteur vidéo'}
            />
            
            {isLoading && status !== 'ERREUR' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none z-10">
                <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
              </div>
            )}

            {status === 'ERREUR' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-20 gap-3 px-4 text-center">
                <span className="text-sm font-mono text-red-400">
                  {friendlyError || 'Erreur de lecture'}
                </span>
                <button
                  onClick={retryNow}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-xs font-mono tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  aria-label="Réessayer la lecture"
                >
                  <RefreshCw className="w-4 h-4" /> RÉESSAYER
                </button>
              </div>
            )}

            {!isLocked && (
              <div className={`absolute left-0 right-0 bottom-0 p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity z-20 ${
                controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}>
                <div 
                  ref={timelineRef}
                  role="slider"
                  aria-label="Progression de la lecture"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                  className="relative h-1.5 bg-white/20 rounded-full mb-4 cursor-pointer"
                  onMouseDown={(e) => { setScrubbing(true); seekFromEvent(e); }}
                  onTouchStart={(e) => { setScrubbing(true); seekFromEvent(e); }}
                >
                  <div className="absolute left-0 top-0 bottom-0 bg-white/30 rounded-full" style={{ width: `${bufPct}%` }} />
                  <div className="absolute left-0 top-0 bottom-0 bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
                  <div className="absolute top-1/2 -mt-2 -ml-2 w-4 h-4 bg-indigo-500 rounded-full shadow-[0_0_0_4px_rgba(99,102,241,0.2)]" style={{ left: `${pct}%` }} />
                </div>
                
                <div className="flex items-center gap-4">
                  <button onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Lecture'} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded">
                    {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                  </button>

                  <div className="flex items-center gap-2 group/vol">
                    <button onClick={toggleMute} aria-label={isMuted ? 'Activer le son' : 'Couper le son'} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded">
                      {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                      aria-label="Volume"
                      className="w-0 group-hover/vol:w-16 focus:w-16 transition-all duration-200 accent-indigo-500 h-1 cursor-pointer"
                    />
                  </div>

                  <div className="text-xs font-mono text-slate-300">
                    {fmtTime(currentTime)} / {fmtTime(duration)}
                  </div>
                  
                  <div className="flex-1" />

                  <div ref={tracksMenuRef} className="flex items-center gap-4">
                    {qualityLevels.length > 1 && (
                      <div className="relative">
                        <button
                          onClick={() => setTracksMenuOpen(tracksMenuOpen === 'quality' ? null : 'quality')}
                          className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded"
                          title="Qualité vidéo"
                          aria-label="Choisir la qualité vidéo"
                        >
                          <Settings className="w-5 h-5" />
                        </button>
                        {tracksMenuOpen === 'quality' && (
                          <div className="absolute bottom-8 right-0 bg-slate-900 border border-slate-700 rounded-lg py-1 w-36 text-xs font-mono z-30 shadow-lg max-h-52 overflow-y-auto">
                            <button
                              onClick={() => selectQuality(-1)}
                              className={`w-full text-left px-3 py-2 hover:bg-slate-800 ${activeQualityId === -1 ? 'text-indigo-400' : 'text-slate-300'}`}
                            >
                              Auto
                            </button>
                            {qualityLevels.map(q => (
                              <button
                                key={q.id}
                                onClick={() => selectQuality(q.id)}
                                className={`w-full text-left px-3 py-2 hover:bg-slate-800 truncate ${activeQualityId === q.id ? 'text-indigo-400' : 'text-slate-300'}`}
                              >
                                {q.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {subtitleTracks.length > 0 && (
                      <div className="relative">
                        <button
                          onClick={() => setTracksMenuOpen(tracksMenuOpen === 'subtitles' ? null : 'subtitles')}
                          className={`hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded ${activeSubtitleId !== -1 ? 'text-indigo-400' : 'text-white'}`}
                          title="Sous-titres"
                          aria-label="Choisir les sous-titres"
                        >
                          <Captions className="w-5 h-5" />
                        </button>
                        {tracksMenuOpen === 'subtitles' && (
                          <div className="absolute bottom-8 right-0 bg-slate-900 border border-slate-700 rounded-lg py-1 w-44 text-xs font-mono z-30 shadow-lg max-h-52 overflow-y-auto">
                            <button
                              onClick={() => selectSubtitle(-1)}
                              className={`w-full text-left px-3 py-2 hover:bg-slate-800 ${activeSubtitleId === -1 ? 'text-indigo-400' : 'text-slate-300'}`}
                            >
                              Désactivé
                            </button>
                            {subtitleTracks.map(t => (
                              <button
                                key={t.id}
                                onClick={() => selectSubtitle(t.id)}
                                className={`w-full text-left px-3 py-2 hover:bg-slate-800 truncate ${activeSubtitleId === t.id ? 'text-indigo-400' : 'text-slate-300'}`}
                              >
                                {t.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {audioTracks.length > 1 && (
                      <div className="relative">
                        <button
                          onClick={() => setTracksMenuOpen(tracksMenuOpen === 'audio' ? null : 'audio')}
                          className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded"
                          title="Piste audio"
                          aria-label="Choisir la piste audio"
                        >
                          <Languages className="w-5 h-5" />
                        </button>
                        {tracksMenuOpen === 'audio' && (
                          <div className="absolute bottom-8 right-0 bg-slate-900 border border-slate-700 rounded-lg py-1 w-44 text-xs font-mono z-30 shadow-lg max-h-52 overflow-y-auto">
                            {audioTracks.map(t => (
                              <button
                                key={t.id}
                                onClick={() => selectAudioTrack(t.id)}
                                className={`w-full text-left px-3 py-2 hover:bg-slate-800 truncate ${activeAudioId === t.id ? 'text-indigo-400' : 'text-slate-300'}`}
                              >
                                {t.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  
                  <button onClick={toggleResize} aria-label="Changer le mode d'affichage" className="text-xs font-mono font-bold tracking-widest text-slate-300 hover:text-white px-2 py-1 bg-white/10 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
                    {activeSource ? resizeLabels[activeSource.resizeMode] : 'AJUSTER'}
                  </button>
                  <button onClick={togglePip} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Picture-in-Picture" aria-label="Picture-in-Picture">
                    <PictureInPicture className="w-5 h-5" />
                  </button>
                  <button onClick={() => setIsLocked(true)} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Verrouiller" aria-label="Verrouiller les contrôles">
                    <Lock className="w-5 h-5" />
                  </button>
                  <button onClick={toggleFullscreen} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Plein écran" aria-label="Plein écran">
                    <Maximize className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

            {isLocked && (
              <button 
                onClick={() => setIsLocked(false)}
                className="absolute bottom-4 right-4 bg-black/60 text-amber-400 border border-amber-500/40 rounded-lg px-4 py-2 flex items-center gap-2 text-xs font-mono tracking-widest hover:bg-black/80 z-30"
                aria-label="Déverrouiller les contrôles"
              >
                <Unlock className="w-4 h-4" /> DÉVERROUILLER
              </button>
            )}
          </div>

          {/* Playlist Row */}
          <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar shrink-0">
            {sources.length === 0 ? (
              <div className="text-sm font-mono text-slate-500 py-4 italic">Veuillez sélectionner un match dans l'onglet Events.</div>
            ) : (
              sources.map((s, idx) => (
                <div 
                  key={idx}
                  tabIndex={0}
                  onClick={() => loadSource(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      loadSource(idx);
                    }
                  }}
                  className={`flex-none w-48 p-3 rounded-xl border cursor-pointer relative group transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    activeIndex === idx ? 'bg-indigo-500/10 border-indigo-500/50' : 'bg-slate-900 border-slate-800 hover:border-slate-600'
                  }`}
                >
                  <div className="font-bold text-sm text-slate-200 line-clamp-1 pr-2">{s.label}</div>
                  <div className={`text-[10px] font-mono mt-1 ${activeIndex === idx ? 'text-indigo-400' : 'text-slate-500'}`}>
                    {s.format.toUpperCase()} {s.drmType !== 'none' ? `· ${s.drmType.toUpperCase()}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Recommendations */}
          {events.length > 0 && onPlayStream && (
            <div className="flex-1 flex flex-col mt-4">
              <div className="px-1 py-2 flex items-center gap-2">
                <Tv className="w-4 h-4 text-indigo-400" />
                <span className="text-sm font-bold tracking-wider text-slate-300 uppercase">Autres Matchs & Événements</span>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-4 pt-2 custom-scrollbar shrink-0">
                {events.slice(0, 10).map((item) => {
                  const { eventDetails, teamA, teamB } = item.event;
                  const displayLogo = eventDetails.eventLogo || categoryLogos[eventDetails.category];
                  
                  return (
                    <div 
                      key={item.id}
                      className="flex-none w-64 bg-slate-900 border border-slate-800 rounded-xl p-4 cursor-pointer hover:border-indigo-500 transition-all group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      tabIndex={0}
                      onClick={() => {
                        const streams: StreamSource[] = item.links.map((link, idx) => {
                          let type = 'auto';
                          if (link.link.includes('.m3u8')) type = 'hls';
                          else if (link.link.includes('.mpd')) type = 'dash';
                          
                          let drmType = 'none';
                          let clearkeys = '';
                          let licenseUrl = '';
                          if (link.api) {
                            drmType = 'clearkey';
                            if (link.api.startsWith('http')) {
                              licenseUrl = link.api;
                            } else {
                              clearkeys = link.api;
                            }
                          }
                          return {
                            name: link.name || `${eventDetails.eventName} - Server ${idx + 1}`,
                            url: link.link,
                            type,
                            drmType,
                            clearkeys,
                            licenseUrl
                          };
                        });
                        onPlayStream(streams);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.currentTarget.click();
                        }
                      }}
                    >
                      <div className="flex items-center space-x-2 mb-3">
                        {displayLogo && (
                          <img 
                            src={displayLogo} 
                            alt={eventDetails.category} 
                            className="w-6 h-6 object-contain rounded" 
                            referrerPolicy="no-referrer"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          />
                        )}
                        <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest truncate">{eventDetails.category}</p>
                      </div>
                      
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex flex-col items-center w-1/3 text-center">
                          {teamA.logo ? (
                            <img src={teamA.logo} alt={teamA.name} className="w-8 h-8 object-contain mb-1" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                          ) : (
                            <div className="w-8 h-8 bg-slate-800 rounded-full mb-1 flex items-center justify-center font-bold text-slate-500 text-[10px]">{teamA.name.substring(0, 2)}</div>
                          )}
                          <span className="text-[10px] font-medium text-slate-300 truncate w-full">{teamA.name}</span>
                        </div>
                        <div className="text-[10px] font-black text-slate-600 italic px-2">VS</div>
                        <div className="flex flex-col items-center w-1/3 text-center">
                          {teamB.logo ? (
                            <img src={teamB.logo} alt={teamB.name} className="w-8 h-8 object-contain mb-1" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                          ) : (
                            <div className="w-8 h-8 bg-slate-800 rounded-full mb-1 flex items-center justify-center font-bold text-slate-500 text-[10px]">{teamB.name.substring(0, 2)}</div>
                          )}
                          <span className="text-[10px] font-medium text-slate-300 truncate w-full">{teamB.name}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}