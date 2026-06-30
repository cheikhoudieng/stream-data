import React, { useState, useRef, useEffect, FormEvent, useCallback } from 'react';
import Hls from 'hls.js';
import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Lock, Unlock, X, MonitorPlay, PictureInPicture, Terminal, Layers, Calendar, Clock, Tv, Captions, Languages, RefreshCw } from 'lucide-react';
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

const FORBIDDEN_HEADERS = [
  'user-agent', 'referer', 'cookie', 'host', 'origin', 'content-length',
  'connection', 'via', 'accept-charset', 'accept-encoding', 'date', 'dnt', 'expect', 'keep-alive',
  'trailer', 'transfer-encoding', 'upgrade'
];

function escapeHtml(s: string) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
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

function parseHeaders(text: string, logFn: (msg: string, level: 'warn') => void) {
  const out: Record<string, string> = {};
  const ignored: string[] = [];
  (text || '').split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) return;
    if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) { ignored.push(name); return; }
    out[name] = value;
  });
  if (ignored.length) logFn('En-têtes ignorés (protégés par le navigateur) : ' + ignored.join(', '), 'warn');
  return out;
}

function detectFormat(url: string, override: string) {
  if (override && override !== 'auto') return override;
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.m3u8')) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  return 'progressive';
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

  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<number | string>(-1);
  const [activeAudioId, setActiveAudioId] = useState<number | string>(-1);
  const [tracksMenuOpen, setTracksMenuOpen] = useState<'subtitles' | 'audio' | null>(null);

  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryCountRef = useRef(0);
  
  const [status, setStatus] = useState<'ARRÊTÉ' | 'CHARGEMENT' | 'LECTURE' | 'PAUSE' | 'TERMINÉ' | 'ERREUR'>('ARRÊTÉ');

  useEffect(() => {
    if (initialStreams && initialStreams.length > 0) {
      const parsedSources: Source[] = initialStreams.map((is, idx) => ({
        url: is.url,
        format: detectFormat(is.url, is.type || 'auto'),
        drmType: is.drmType || 'none',
        licenseUrl: is.licenseUrl || '',
        clearkeys: is.clearkeys || '',
        headers: {},
        resizeMode: 'contain',
        label: is.name || `Server ${idx + 1}`
      }));
      
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

  const sourcesRef = useRef<Source[]>([]);
  const activeIndexRef = useRef(-1);
  // Holds the latest loadSource implementation so scheduleRetry can call it
  // without creating a circular useCallback dependency.
  const loadSourceRef = useRef<(idx: number, isRetry?: boolean) => void>();

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Auto-retry: fires immediately (no delay) on fatal playback errors,
  // up to MAX_AUTO_RETRIES, then surfaces a manual retry button.
  const scheduleRetry = useCallback((idx: number) => {
    if (idx < 0) return;
    if (retryCountRef.current >= MAX_AUTO_RETRIES) {
      addLog(`Échec après ${MAX_AUTO_RETRIES} tentatives automatiques.`, 'error');
      setRetryAttempt(retryCountRef.current);
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

  const refreshShakaTracks = useCallback((player: any) => {
    try {
      const texts = player.getTextTracks();
      setSubtitleTracks(texts.map((t: any) => ({
        id: t.id,
        label: t.label || t.language || `Sous-titres ${t.id}`,
        language: t.language
      })));
      setActiveSubtitleId(-1); // sous-titres masqués par défaut

      const variants = player.getVariantTracks();
      const seen = new Set<string>();
      const auds: TrackOption[] = [];
      variants.forEach((t: any) => {
        if (!t.language || seen.has(t.language)) return;
        seen.add(t.language);
        auds.push({ id: t.language, label: t.language });
      });
      setAudioTracks(auds);
      const active = variants.find((t: any) => t.active);
      setActiveAudioId(active ? active.language : -1);
    } catch (e) {
      addLog('Impossible de récupérer les pistes audio/sous-titres.', 'warn');
    }
  }, [addLog]);

  const loadSource = useCallback(async (idx: number, isRetry = false) => {
    const source = sourcesRef.current[idx];
    if (!source) return;

    if (!isRetry) {
      retryCountRef.current = 0;
      setRetryAttempt(0);
    }

    setActiveIndex(idx);
    destroyEngines();
    setIsLoading(true);
    setStatus('CHARGEMENT');
    setSubtitleTracks([]);
    setAudioTracks([]);
    setActiveSubtitleId(-1);
    setActiveAudioId(-1);
    setTracksMenuOpen(null);

    if (videoRef.current) {
      videoRef.current.style.objectFit = source.resizeMode;
    }

    if (source.format === 'hls') {
      if (Hls.isSupported()) {
        const hlsConfig: any = {
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
          enableWorker: true,
          lowLatencyMode: true,
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
          if (data.fatal) {
            addLog(`Erreur HLS fatale : ${data.type} — ${data.details}`, 'error');
            scheduleRetry(idx);
          }
        });

        // Subtitle/audio tracks are discovered from the manifest and stay
        // in sync with currentTime automatically — HLS.js feeds them into
        // the video element's native TextTrack cues, which the browser
        // renders against video.currentTime on every frame.
        hls.on(Hls.Events.MANIFEST_PARSED, () => refreshHlsTracks(hls));
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => refreshHlsTracks(hls));
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => refreshHlsTracks(hls));
        
        hls.loadSource(source.url);
        hls.attachMedia(videoRef.current!);
      } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = source.url;
        addLog('Lecture HLS native (Safari Apple).', 'ok');
      } else {
        addLog('HLS non supporté par ce navigateur.', 'error');
        scheduleRetry(idx);
      }
      attemptPlay();
    } else if (source.format === 'dash') {
      shaka.polyfill.installAll();
      if (!shaka.Player.isBrowserSupported()) {
        addLog('Navigateur non supporté par Shaka Player', 'error');
        return;
      }

      const player = new shaka.Player(videoRef.current!);
      shakaRef.current = player;

      player.getNetworkingEngine().registerRequestFilter((type: any, request: any) => {
        if (Object.keys(source.headers).length) {
          Object.assign(request.headers, source.headers);
        }
      });

      player.addEventListener('error', (e: any) => {
        addLog('Erreur Shaka : ' + e.detail.code, 'error');
        scheduleRetry(idx);
      });

      const shakaConfig: any = {
        streaming: {
          bufferingGoal: 30,
          rebufferingGoal: 2,
          bufferBehind: 30,
        }
      };
      if (source.drmType === 'clearkey' && source.clearkeys) {
        const clearKeysMap: Record<string, string> = {};
        parseClearkeyLines(source.clearkeys).forEach(p => {
          clearKeysMap[p.kid] = p.k;
        });

        shakaConfig.drm = { clearKeys: clearKeysMap };
        shakaConfig.manifest = { dash: { ignoreDrmInfo: true } };
        addLog('Forçage des clés ClearKey (ignoreDrmInfo activé).', 'ok');
      } else if (source.drmType !== 'none' && source.licenseUrl) {
        const sysMap: Record<string, string> = { widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready' };
        shakaConfig.drm = { servers: { [sysMap[source.drmType]]: source.licenseUrl } };
      }

      player.configure(shakaConfig);

      player.load(source.url).then(() => {
        addLog('DASH chargé avec succès.', 'ok');
        // Shaka's own text/caption renderer is driven off video.currentTime
        // internally, so once a track is selected it stays frame-accurate
        // with the timeline without any extra wiring on our side.
        refreshShakaTracks(player);
        attemptPlay();
      }).catch((e: any) => {
        addLog('Erreur de chargement DASH : ' + e.message, 'error');
        scheduleRetry(idx);
      });

    } else {
      if (source.drmType === 'clearkey' && source.clearkeys) {
        setupNativeClearKey(videoRef.current!, source.clearkeys).then(() => {
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
  }, [destroyEngines, addLog, attemptPlay, scheduleRetry, refreshHlsTracks, refreshShakaTracks]);

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

  // Subtitle/audio selection — works across all three playback engines and
  // never has to "seek to resync": native TextTrack cues and Shaka's
  // SimpleTextDisplayer both render against video.currentTime continuously,
  // so once a track is on, it tracks the timeline on its own.
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
      }
    }
    setTracksMenuOpen(null);
  }, []);

  // Close the subtitles/audio popover on outside click
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
    const onEnded = () => { setStatus('TERMINÉ'); };
    const onWaiting = () => setIsLoading(true);
    const onPlaying = () => setIsLoading(false);
    const onCanPlay = () => setIsLoading(false);
    const onError = () => {
      const err = video.error;
      addLog('Erreur média' + (err ? ' (code ' + err.code + ')' : ''), 'error');
      scheduleRetry(activeIndexRef.current);
    };

    const onTimeUpdate = () => {
      if (video.duration) {
        setCurrentTime(video.currentTime);
        setDuration(video.duration);
      }
    };

    const onProgress = () => {
      if (video.duration && video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('loadstart', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('progress', onProgress);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('loadstart', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('progress', onProgress);
    };
  }, [addLog, scheduleRetry]);

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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLocked]);

  const togglePlay = () => {
    if (videoRef.current) {
      videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      if (!videoRef.current.muted && videoRef.current.volume === 0) videoRef.current.volume = 1;
      setIsMuted(videoRef.current.muted);
    }
  };

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

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => addLog('Plein écran indisponible', 'warn'));
    } else {
      document.exitFullscreen();
    }
  };

  const togglePip = () => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (videoRef.current?.requestPictureInPicture) {
      videoRef.current.requestPictureInPicture().catch(err => addLog('PiP indisponible', 'warn'));
    } else {
      addLog('Picture-in-Picture non supporté', 'warn');
    }
  };

  const retryNow = () => {
    retryCountRef.current = 0;
    setRetryAttempt(0);
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

  const activeSource = activeIndex >= 0 ? sources[activeIndex] : null;
  const pct = duration ? (currentTime / duration) * 100 : 0;
  const bufPct = duration ? (bufferedEnd / duration) * 100 : 0;

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
          >
            <video 
              ref={videoRef} 
              playsInline 
              className="w-full h-full"
              style={{ objectFit: activeSource?.resizeMode || 'contain' }}
              onClick={togglePlay}
            />
            
            {isLoading && status !== 'ERREUR' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none z-10">
                <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
              </div>
            )}

            {status === 'ERREUR' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-20 gap-3 px-4 text-center">
                <span className="text-sm font-mono text-red-400">
                  {retryAttempt >= MAX_AUTO_RETRIES
                    ? `Échec après ${MAX_AUTO_RETRIES} tentatives automatiques`
                    : 'Erreur de lecture'}
                </span>
                <button
                  onClick={retryNow}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-xs font-mono tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <RefreshCw className="w-4 h-4" /> RÉESSAYER
                </button>
              </div>
            )}

            {!isLocked && (
              <div className="absolute left-0 right-0 bottom-0 p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity z-20">
                <div 
                  ref={timelineRef}
                  className="relative h-1.5 bg-white/20 rounded-full mb-4 cursor-pointer"
                  onMouseDown={(e) => { setScrubbing(true); seekFromEvent(e); }}
                  onTouchStart={(e) => { setScrubbing(true); seekFromEvent(e); }}
                >
                  <div className="absolute left-0 top-0 bottom-0 bg-white/30 rounded-full" style={{ width: `${bufPct}%` }} />
                  <div className="absolute left-0 top-0 bottom-0 bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
                  <div className="absolute top-1/2 -mt-2 -ml-2 w-4 h-4 bg-indigo-500 rounded-full shadow-[0_0_0_4px_rgba(99,102,241,0.2)]" style={{ left: `${pct}%` }} />
                </div>
                
                <div className="flex items-center gap-4">
                  <button onClick={togglePlay} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded">
                    {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                  </button>
                  <button onClick={toggleMute} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded">
                    {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </button>
                  <div className="text-xs font-mono text-slate-300">
                    {fmtTime(currentTime)} / {fmtTime(duration)}
                  </div>
                  
                  <div className="flex-1" />

                  <div ref={tracksMenuRef} className="flex items-center gap-4">
                    {subtitleTracks.length > 0 && (
                      <div className="relative">
                        <button
                          onClick={() => setTracksMenuOpen(tracksMenuOpen === 'subtitles' ? null : 'subtitles')}
                          className={`hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded ${activeSubtitleId !== -1 ? 'text-indigo-400' : 'text-white'}`}
                          title="Sous-titres"
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
                  
                  <button onClick={toggleResize} className="text-xs font-mono font-bold tracking-widest text-slate-300 hover:text-white px-2 py-1 bg-white/10 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
                    {activeSource ? resizeLabels[activeSource.resizeMode] : 'AJUSTER'}
                  </button>
                  <button onClick={togglePip} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Picture-in-Picture">
                    <PictureInPicture className="w-5 h-5" />
                  </button>
                  <button onClick={() => setIsLocked(true)} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Verrouiller">
                    <Lock className="w-5 h-5" />
                  </button>
                  <button onClick={toggleFullscreen} className="text-white hover:text-indigo-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded" title="Plein écran">
                    <Maximize className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

            {isLocked && (
              <button 
                onClick={() => setIsLocked(false)}
                className="absolute bottom-4 right-4 bg-black/60 text-amber-400 border border-amber-500/40 rounded-lg px-4 py-2 flex items-center gap-2 text-xs font-mono tracking-widest hover:bg-black/80 z-30"
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