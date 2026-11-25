'use strict';
// Offline music PWA. Audio blobs live in IndexedDB; playback is a single <audio> element.
// Rule for reliable lock-screen skipping on iOS: every track change sets audio.src and calls
// play() synchronously — no awaits — so all object URLs are prepared up front.

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ---------- debug log (persisted so you can read what happened while locked) ----------
const LOG_KEY = 'om-log';
let logLines = [];
try { logLines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch {}
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logLines.push(`${t} [${document.visibilityState}] ${msg}`);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(logLines)); } catch {}
  $('log').textContent = logLines.slice().reverse().join('\n');
}
$('clearlog').onclick = () => { logLines = []; log('log cleared'); };
document.addEventListener('visibilitychange', () => log('visibility → ' + document.visibilityState));
const flash = (m) => { $('msg').textContent = m; };

// ---------- IndexedDB ----------
// v1: tracks (metadata), blobs (audio). v2: art (image Blob per track id, optional).
// Track record: { id, name, title, artist, album, size, type, duration, hasArt }
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('offline-music', 2);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) { d.createObjectStore('tracks', { keyPath: 'id' }); d.createObjectStore('blobs'); }
      if (e.oldVersion < 2) d.createObjectStore('art');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

// ---------- state ----------
let tracks = [];
const urls = new Map();     // track id -> audio object URL
const artUrls = new Map();  // track id -> image object URL
let index = -1;

async function loadLibrary() {
  tracks = await req(store('tracks').getAll());
  tracks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Prepare every object URL now so track changes never need to await.
  // IndexedDB blobs are disk-backed in Safari, so this doesn't pull audio into memory.
  for (const t of tracks) {
    if (!urls.has(t.id)) {
      const blob = await req(store('blobs').get(t.id));
      if (blob) urls.set(t.id, URL.createObjectURL(blob));
    }
    if (t.hasArt && !artUrls.has(t.id)) {
      const img = await req(store('art').get(t.id));
      if (img) artUrls.set(t.id, URL.createObjectURL(img));
    }
  }
  render();
}

// Album art hook: call this with an image Blob (e.g. from embedded tags) to attach art to a track.
async function setTrackArt(id, imageBlob) {
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  const tx = db.transaction(['art', 'tracks'], 'readwrite');
  tx.objectStore('art').put(imageBlob, id);
  tx.objectStore('tracks').put({ ...t, hasArt: true });
  await done(tx);
  t.hasArt = true;
  if (artUrls.has(id)) URL.revokeObjectURL(artUrls.get(id));
  artUrls.set(id, URL.createObjectURL(imageBlob));
  if (tracks[index] && tracks[index].id === id) { updateSession(); updateNow(); }
}
window.setTrackArt = setTrackArt;

// ---------- import ----------
$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const existing = new Set(tracks.map((t) => t.name + '|' + t.size));
  let added = 0, skipped = 0;
  for (const f of files) {
    flash(`importing ${added + skipped + 1}/${files.length} ${f.name}`);
    if (existing.has(f.name + '|' + f.size)) { skipped++; continue; }
    try {
      // Copy into a fresh Blob: Safari has had bugs storing picker File objects directly.
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || guessType(f.name) });
      const id = crypto.randomUUID();
      const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
      tx.objectStore('blobs').put(blob, id);
      tx.objectStore('tracks').put({
        id, name: f.name, title: f.name.replace(/\.[^.]+$/, ''), artist: '', album: '',
        size: f.size, type: blob.type, duration: 0, hasArt: false,
      });
      await done(tx);
      added++;
    } catch (err) {
      log(`import failed ${f.name}: ${err && err.name} ${err && err.message}`);
    }
  }
  flash(`+${added} imported, ${skipped} dup skipped`);
  log(`import: ${added} added, ${skipped} skipped`);
  await loadLibrary();
  showStorage();
});

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', alac: 'audio/mp4' }[ext] || '';
}

$('clear').onclick = async () => {
  if (!confirm('Delete all imported tracks from this app?')) return;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  for (const u of [...urls.values(), ...artUrls.values()]) URL.revokeObjectURL(u);
  urls.clear(); artUrls.clear(); index = -1;
  const tx = db.transaction(['tracks', 'blobs', 'art'], 'readwrite');
  for (const s of ['tracks', 'blobs', 'art']) tx.objectStore(s).clear();
  await done(tx);
  log('library cleared');
  await loadLibrary(); showStorage(); updateNow(); syncPlayState();
};

// ---------- playback (all synchronous) ----------
function playIndex(i, why) {
  if (!tracks.length) return;
  i = (i + tracks.length) % tracks.length;
  const t = tracks[i];
  const url = urls.get(t.id);
  if (!url) { log(`no url for ${t.name}`); return; }
  index = i;
  audio.src = url;
  const p = audio.play();
  if (p) p.catch((err) => log(`play() rejected: ${err.name} ${err.message}`));
  log(`${why} → #${i + 1} ${t.title}`);
  updateSession();
  updateNow();
  render();
}
const next = (why) => playIndex(index + 1, why);
const prev = (why) => {
  if (audio.currentTime > 3) { audio.currentTime = 0; log(`${why} → restart`); return; }
  playIndex(index - 1, why);
};
function toggle() {
  if (index < 0) return playIndex(0, 'toggle');
  if (audio.paused) audio.play().catch((e) => log('play() rejected: ' + e.name)); else audio.pause();
}

audio.addEventListener('ended', () => next('ended'));
audio.addEventListener('playing', () => { registerHandlers(); syncPlayState(); });
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', syncPlayState);
audio.addEventListener('error', () => log(`audio error: code ${audio.error && audio.error.code}`));
audio.addEventListener('stalled', () => log('event: stalled'));
audio.addEventListener('timeupdate', updateNow);
audio.addEventListener('loadedmetadata', () => {
  updatePosition(); updateNow();
  const t = tracks[index];
  if (t && isFinite(audio.duration) && !t.duration) {   // remember duration for the list
    t.duration = audio.duration;
    store('tracks', 'readwrite').put(t);
    render();
  }
});

$('prev').onclick = () => prev('button');
$('next').onclick = () => next('button');
$('toggle').onclick = toggle;

// scrub bar
(() => {
  const bar = $('bar');
  let dragging = false;
  const seekFrom = (e) => {
    if (!isFinite(audio.duration)) return;
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = f * audio.duration;
    updateNow(); updatePosition();
  };
  bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seekFrom(e); });
  bar.addEventListener('pointermove', (e) => { if (dragging) seekFrom(e); });
  bar.addEventListener('pointerup', () => { dragging = false; });
  bar.addEventListener('pointercancel', () => { dragging = false; });
})();

// ---------- Media Session (lock screen / Control Center / AirPods) ----------
// iOS home-screen apps were showing ±10s skip instead of next/prev. Fixes:
//  - explicitly clear seekforward/seekbackward (they win over next/prev if present),
//  - (re)register handlers once playback is actually running, since iOS can drop or ignore
//    handlers registered before the page became the active Now Playing session.
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
let handlersLogged = false;
function registerHandlers() {
  if (!ms) return;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); return true; } catch { return false; } };
  set('seekforward', null);
  set('seekbackward', null);
  const ok = {
    play: set('play', () => { log('ms: play'); audio.play().catch((e) => log('play() rejected: ' + e.name)); }),
    pause: set('pause', () => { log('ms: pause'); audio.pause(); }),
    nexttrack: set('nexttrack', () => next('ms: nexttrack')),
    previoustrack: set('previoustrack', () => prev('ms: previoustrack')),
    seekto: set('seekto', (d) => { audio.currentTime = d.seekTime; updatePosition(); }),
  };
  if (!handlersLogged) { log('ms handlers: ' + JSON.stringify(ok)); handlersLogged = true; }
}
function artFor(t) {
  const u = t && artUrls.get(t.id);
  return u ? [{ src: u, sizes: '512x512' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }];
}
function updateSession() {
  if (!ms || index < 0) return;
  const t = tracks[index];
  ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: artFor(t) });
  registerHandlers();
}
function syncPlayState() {
  if (ms) ms.playbackState = index < 0 ? 'none' : audio.paused ? 'paused' : 'playing';
  $('toggle').textContent = audio.paused ? 'play' : 'pause';
  $('mode').textContent = index < 0 ? 'IDLE' : audio.paused ? 'PAUSED' : 'PLAYING';
  updatePosition();
}
function updatePosition() {
  if (!ms || !ms.setPositionState || !isFinite(audio.duration)) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}

// ---------- UI ----------
const fmt = (s) => (s && isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
let shownArt = null;
function updateNow() {
  const t = tracks[index];
  $('title').textContent = t ? t.title : 'nothing playing';
  $('sub').textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') || 'unknown artist' : '—';
  const u = t && artUrls.get(t.id);
  if (u !== shownArt) {
    shownArt = u;
    if (u) { const img = new Image(); img.src = u; img.alt = ''; $('art').replaceChildren(img); }
    else $('art').textContent = 'no art';
  }
  const d = audio.duration, c = audio.currentTime || 0;
  const pct = isFinite(d) && d > 0 ? (c / d) * 100 : 0;
  $('fill').style.width = pct + '%';
  $('head').style.left = pct + '%';
  $('cur').textContent = fmt(c);
  $('dur').textContent = fmt(d);
  $('pos').textContent = `${index + 1}/${tracks.length}`;
}
function render() {
  $('count').textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
  const ol = $('list');
  if (!tracks.length) {
    const p = document.createElement('li');
    p.className = 'empty'; p.textContent = '~ empty — tap [import] to add music';
    ol.replaceChildren(p);
  } else {
    ol.replaceChildren(...tracks.map((t, i) => {
      const li = document.createElement('li');
      if (i === index) li.className = 'cur';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = i === index ? '▸' : String(i + 1).padStart(2, '0');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t.title;
      const d = document.createElement('span'); d.className = 'd'; d.textContent = t.duration ? fmt(t.duration) : '';
      li.append(n, nm, d);
      li.onclick = () => playIndex(i, 'tap');
      return li;
    }));
  }
  updateNow();
}
async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const h = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : (b / 1048576).toFixed(0) + 'M');
  $('store').textContent = `${h(usage)}/${h(quota)}`;
}

// ---------- boot ----------
(async () => {
  log(`boot · standalone=${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}`);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => log('SW register failed: ' + e.message));
  }
  if (navigator.storage && navigator.storage.persist) {
    try { log('persist() → ' + (await navigator.storage.persist())); } catch {}
  }
  registerHandlers();
  db = await openDB();
  await loadLibrary();
  syncPlayState();
  showStorage();
})().catch((e) => log('boot error: ' + e.message));
