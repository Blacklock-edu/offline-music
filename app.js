'use strict';
// Spike: import audio into IndexedDB, play offline, lock-screen next/prev via Media Session.
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

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('offline-music', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('tracks', { keyPath: 'id' });
      r.result.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }

// ---------- state ----------
let tracks = [];          // [{id, name, title, size, type}]
const urls = new Map();   // id -> object URL
let index = -1;

async function loadLibrary() {
  tracks = await req(store('tracks').getAll());
  tracks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Prepare every object URL now so track changes never need to await.
  // Blobs from IndexedDB are disk-backed in Safari, so this doesn't load audio into memory.
  for (const t of tracks) {
    if (urls.has(t.id)) continue;
    const blob = await req(store('blobs').get(t.id));
    if (blob) urls.set(t.id, URL.createObjectURL(blob));
  }
  render();
}

// ---------- import ----------
$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const existing = new Set(tracks.map((t) => t.name + '|' + t.size));
  let done = 0, skipped = 0;
  for (const f of files) {
    $('status').textContent = `Importing ${done + skipped + 1}/${files.length}: ${f.name}`;
    if (existing.has(f.name + '|' + f.size)) { skipped++; continue; }
    try {
      // Copy into a fresh Blob: Safari has had bugs storing picker File objects directly.
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || guessType(f.name) });
      const id = crypto.randomUUID();
      const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
      tx.objectStore('blobs').put(blob, id);
      tx.objectStore('tracks').put({ id, name: f.name, title: f.name.replace(/\.[^.]+$/, ''), size: f.size, type: blob.type });
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      done++;
    } catch (err) {
      log(`import failed ${f.name}: ${err && err.name} ${err && err.message}`);
    }
  }
  $('status').textContent = `Imported ${done}, skipped ${skipped} duplicate(s).`;
  log(`import: ${done} added, ${skipped} skipped`);
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
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear(); index = -1;
  const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
  tx.objectStore('tracks').clear(); tx.objectStore('blobs').clear();
  await new Promise((res) => (tx.oncomplete = res));
  log('library cleared');
  await loadLibrary(); showStorage(); updateNow();
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
  log(`${why} → #${i} ${t.title}`);
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
audio.addEventListener('play', () => { log('event: play'); syncPlayState(); });
audio.addEventListener('pause', () => { log('event: pause'); syncPlayState(); });
audio.addEventListener('error', () => log(`audio error: code ${audio.error && audio.error.code}`));
audio.addEventListener('stalled', () => log('event: stalled'));
audio.addEventListener('loadedmetadata', () => { $('seek').max = audio.duration || 0; updatePosition(); });
audio.addEventListener('timeupdate', updateNow);

$('prev').onclick = () => prev('button');
$('next').onclick = () => next('button');
$('toggle').onclick = toggle;
$('seek').oninput = (e) => { audio.currentTime = +e.target.value; };

// ---------- Media Session (lock screen / Control Center / AirPods) ----------
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
if (ms) {
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { log('no handler support: ' + a); } };
  set('play', () => { log('ms: play'); audio.play().catch((e) => log('play() rejected: ' + e.name)); });
  set('pause', () => { log('ms: pause'); audio.pause(); });
  set('nexttrack', () => next('ms: nexttrack'));
  set('previoustrack', () => prev('ms: previoustrack'));
  set('seekto', (d) => { audio.currentTime = d.seekTime; updatePosition(); });
  // Deliberately NOT setting seekforward/seekbackward: on iOS those replace the
  // next/prev buttons on the lock screen with ±10s skip buttons.
} else {
  log('Media Session API not available');
}
function updateSession() {
  if (!ms || index < 0) return;
  ms.metadata = new MediaMetadata({
    title: tracks[index].title,
    artist: 'Offline Music',
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
function syncPlayState() {
  if (ms) ms.playbackState = audio.paused ? 'paused' : 'playing';
  $('toggle').textContent = audio.paused ? '▶' : '⏸';
  updatePosition();
}
function updatePosition() {
  if (!ms || !ms.setPositionState || !isFinite(audio.duration)) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}

// ---------- UI ----------
const fmt = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
function updateNow() {
  $('title').textContent = index >= 0 ? tracks[index].title : 'Nothing playing';
  $('time').textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
  if (document.activeElement !== $('seek')) $('seek').value = audio.currentTime || 0;
}
function render() {
  const ol = $('list');
  ol.replaceChildren(...tracks.map((t, i) => {
    const li = document.createElement('li');
    li.textContent = t.title;
    if (i === index) li.className = 'cur';
    li.onclick = () => playIndex(i, 'tap');
    return li;
  }));
  if (!tracks.length) $('status').textContent ||= 'No tracks yet — tap Import files.';
}
async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : 'n/a';
  const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
  $('storage').textContent = `Storage: ${mb(usage)} used of ${mb(quota)} · persistent: ${persisted}`;
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
  db = await openDB();
  await loadLibrary();
  showStorage();
})().catch((e) => log('boot error: ' + e.message));
